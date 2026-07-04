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

export interface NodeRow {
  id: number;
  type: 'gateway-isp' | 'mikrotik' | 'ptp-mimosa' | 'ap-ubiquiti' | 'cliente';
  name: string;
  ip: string;
  pos_x: number;
  pos_y: number;
  credentials_enc: string;
  probe_targets: string;
  probe_src_addresses: string;
  enabled: number;
  created_at: number;
}

export interface EdgeRow {
  id: number;
  source_id: number;
  target_id: number;
  label: string;
  capacity_mbps: number | null;
  source_interface: string;
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
