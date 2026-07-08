import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// La BD vive en <raíz del proyecto>/data/monitorct.sqlite
const dataDir = path.resolve(here, '../../../data');
mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'monitorct.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = readFileSync(path.resolve(here, '../../src/db/schema.sql'), 'utf8');
db.exec(schema);

export type NodeType =
  | 'monitor' | 'gateway-isp' | 'router' | 'mikrotik' | 'switch'
  | 'ptp-mimosa' | 'ap-ubiquiti' | 'litebeam' | 'cliente'
  | 'torre' | 'rack'
  | 'olt' | 'onu' | 'nap' | 'poste'
  | 'poe' | 'patch';
export const NODE_TYPES: NodeType[] = [
  'monitor', 'gateway-isp', 'router', 'mikrotik', 'switch',
  'ptp-mimosa', 'ap-ubiquiti', 'litebeam', 'cliente',
  'torre', 'rack', 'olt', 'onu', 'nap', 'poste', 'poe', 'patch',
];
/** Contenedores: agrupan otros equipos por referencia (container_id), no por enlaces. */
export const CONTAINER_TYPES: NodeType[] = ['torre', 'rack'];
/** Pasivos: no se monitorean (fibra, cajas, postes, switch no gestionado, PoE, patch panel). */
export const PASSIVE_TYPES: NodeType[] = ['nap', 'poste', 'switch', 'rack', 'torre', 'poe', 'patch'];

/**
 * Migración idempotente: las bases creadas antes de añadir el tipo 'monitor'
 * tienen un CHECK (type IN (...)) en la tabla nodes que rechazaría ese tipo.
 * Si se detecta ese CHECK, se reconstruye la tabla sin él, preservando los ids
 * (edges/metrics referencian nodes con ON DELETE CASCADE).
 */
function migrateDropTypeCheck(): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='nodes'`).get() as { sql: string } | undefined;
  if (!row || !/CHECK\s*\(\s*type\s+IN/i.test(row.sql)) return;

  db.pragma('foreign_keys = OFF');
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE nodes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        ip TEXT NOT NULL DEFAULT '',
        pos_x REAL NOT NULL DEFAULT 0,
        pos_y REAL NOT NULL DEFAULT 0,
        credentials_enc TEXT NOT NULL DEFAULT '',
        probe_targets TEXT NOT NULL DEFAULT '[]',
        probe_src_addresses TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO nodes_new SELECT id, type, name, ip, pos_x, pos_y, credentials_enc,
        probe_targets, probe_src_addresses, enabled, created_at FROM nodes;
      DROP TABLE nodes;
      ALTER TABLE nodes_new RENAME TO nodes;
    `);
  });
  migrate();
  db.pragma('foreign_key_check');
  db.pragma('foreign_keys = ON');
}
migrateDropTypeCheck();

/**
 * Migración idempotente por columnas: añade una columna si no existe.
 * (CREATE TABLE IF NOT EXISTS de schema.sql no altera tablas ya creadas.)
 */
function addColumnIfMissing(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
// Modo mapa: ubicación geográfica de cada nodo (null = sin ubicar en el mapa).
addColumnIfMissing('nodes', 'lat', 'REAL');
addColumnIfMissing('nodes', 'lng', 'REAL');
// Contenedores: pertenencia a un rack/torre (null = suelto). SET NULL al borrar el contenedor.
addColumnIfMissing('nodes', 'container_id', 'INTEGER REFERENCES nodes(id) ON DELETE SET NULL');
// FTTH/PON: metadatos por tipo (JSON): puertos OLT, ratio del splitter NAP, sensibilidad ONU, etc.
addColumnIfMissing('nodes', 'meta', 'TEXT');
// Enlaces: medio físico + datos de fibra (JSON) para el cálculo de potencia PON.
addColumnIfMissing('edges', 'medium', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('edges', 'fiber', 'TEXT');
// Cableado puerto→puerto: un enlace es también un cable físico entre dos puertos concretos
// (ej. RB:sfp1 → OLT:up). Vacío = enlace lógico sin puerto asignado.
addColumnIfMissing('edges', 'source_port', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('edges', 'target_port', "TEXT NOT NULL DEFAULT ''");

/** Garantiza que exista el nodo Monitor (raíz singleton = este PC). No borrable. */
export function ensureMonitorNode(): void {
  const exists = db.prepare(`SELECT 1 FROM nodes WHERE type = 'monitor' LIMIT 1`).get();
  if (!exists) {
    db.prepare(
      `INSERT INTO nodes (type, name, ip, pos_x, pos_y, enabled) VALUES ('monitor', 'PC de monitoreo', '', 40, 220, 1)`,
    ).run();
  }
}
ensureMonitorNode();

export interface NodeRow {
  id: number;
  type: NodeType;
  name: string;
  ip: string;
  pos_x: number;
  pos_y: number;
  credentials_enc: string;
  probe_targets: string;
  probe_src_addresses: string;
  enabled: number;
  created_at: number;
  lat: number | null;
  lng: number | null;
  container_id: number | null;
  meta: string | null;
}

export interface EdgeRow {
  id: number;
  source_id: number;
  target_id: number;
  label: string;
  capacity_mbps: number | null;
  source_interface: string;
  medium: string;
  fiber: string | null;
  source_port: string;
  target_port: string;
}

export interface Credentials {
  routerosUser?: string;
  routerosPass?: string;
  snmpCommunity?: string;
}

export function getSetting(key: string, def: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? def;
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/**
 * Modo enfoque ("nueva investigación"): timestamp desde el cual las superficies
 * de análisis (matriz de pérdida, correlación, alertas, IA) consideran los datos.
 * 0 = sin enfoque (se ve todo).
 */
export function focusStart(): number {
  return parseInt(getSetting('focus_start', '0'), 10) || 0;
}
export function setFocusStart(ts: number): void {
  setSetting('focus_start', String(Math.floor(ts)));
}
export function clearFocus(): void {
  setSetting('focus_start', '0');
}
/** Aplica el piso de enfoque a un "since" (segundos epoch). */
export function withFocus(since: number): number {
  return Math.max(since, focusStart());
}

/** Borra métricas crudas de más de 48h y resultados de sondas de más de 30 días. */
export function pruneOldData(): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM metrics WHERE ts < ?').run(now - 48 * 3600);
  db.prepare('DELETE FROM probe_results WHERE ts < ?').run(now - 30 * 24 * 3600);
}

/**
 * Agregados de 5 minutos que se conservan 30 días: antes de podar, los promedios
 * se consolidan en la misma tabla con metric prefijado por "agg5m:".
 */
export function rollupMetrics(): void {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 48 * 3600;
  db.prepare(
    `INSERT INTO metrics (node_id, edge_id, metric, value, ts)
     SELECT node_id, edge_id, 'agg5m:' || metric, AVG(value), (ts / 300) * 300
     FROM metrics
     WHERE ts < ? AND metric NOT LIKE 'agg5m:%'
     GROUP BY node_id, edge_id, metric, ts / 300`
  ).run(cutoff);
  db.prepare(`DELETE FROM metrics WHERE ts < ? AND metric NOT LIKE 'agg5m:%'`).run(cutoff);
  db.prepare(`DELETE FROM metrics WHERE metric LIKE 'agg5m:%' AND ts < ?`).run(now - 30 * 24 * 3600);
}
