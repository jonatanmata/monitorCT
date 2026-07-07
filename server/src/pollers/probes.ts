import { db, type NodeRow, getSetting, withFocus } from '../db/index.js';
import { decryptJson } from '../db/crypto.js';
import type { Credentials } from '../db/index.js';
import { pingHost } from './ping.js';
import { pingFromMikrotik } from './mikrotik.js';

/**
 * Sondas de pérdida hacia internet — el síntoma clave de esta red:
 * la pérdida a 8.8.8.8 aparece en el tráfico reenviado (clientes) pero no en
 * el ping generado por los routers. Por eso se sondea desde varios orígenes:
 *
 *  - 'pc': este equipo Windows, que atraviesa toda la cadena como un cliente.
 *  - 'node:<id>': cada MikroTik vía API /ping, incluso con src-address LAN
 *    para que el paquete se enrute/NATee como tráfico de cliente.
 */

function insertProbe(origin: string, srcAddress: string, target: string, r: {
  sent: number; received: number; lossPct: number; avgMs: number | null;
}): void {
  db.prepare(
    'INSERT INTO probe_results (origin, src_address, target, sent, received, loss_pct, avg_ms, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(origin, srcAddress, target, r.sent, r.received, r.lossPct, r.avgMs, Math.floor(Date.now() / 1000));
}

/** Targets globales sondeados desde el PC (configurable en ajustes). */
export function pcProbeTargets(): string[] {
  try {
    const t = JSON.parse(getSetting('pc_probe_targets', '["8.8.8.8"]'));
    return Array.isArray(t) ? t.filter((x) => typeof x === 'string' && x) : ['8.8.8.8'];
  } catch {
    return ['8.8.8.8'];
  }
}

export async function runPcProbes(): Promise<void> {
  for (const target of pcProbeTargets()) {
    try {
      const r = await pingHost(target, 10);
      insertProbe('pc', '', target, r);
    } catch {
      insertProbe('pc', '', target, { sent: 10, received: 0, lossPct: 100, avgMs: null });
    }
  }
}

export async function runMikrotikProbes(): Promise<void> {
  const nodes = db
    .prepare(`SELECT * FROM nodes WHERE type = 'mikrotik' AND enabled = 1 AND ip != ''`)
    .all() as NodeRow[];

  for (const node of nodes) {
    let targets: string[] = [];
    let srcAddresses: string[] = [];
    try { targets = JSON.parse(node.probe_targets) as string[]; } catch { /* sin targets */ }
    try { srcAddresses = JSON.parse(node.probe_src_addresses) as string[]; } catch { /* sin src */ }
    if (!Array.isArray(targets) || targets.length === 0) continue;

    const creds = decryptJson<Credentials>(node.credentials_enc, {});
    // '' = ping por defecto del router; cada src-address adicional simula tráfico de cliente
    const sources = ['', ...(Array.isArray(srcAddresses) ? srcAddresses : [])];

    for (const target of targets) {
      for (const src of sources) {
        try {
          const r = await pingFromMikrotik(node.ip, creds, target, src || undefined, 5);
          insertProbe(`node:${node.id}`, src, target, r);
        } catch {
          // No registrar 100% de pérdida por un fallo de conexión API:
          // se distinguiría mal de pérdida real. Solo se omite la muestra.
        }
      }
    }
  }
}

export interface LossMatrixCell {
  origin: string;
  originName: string;
  srcAddress: string;
  target: string;
  samples: number;
  avgLossPct: number;
  avgMs: number | null;
}

/** Matriz de pérdida por par (origen→destino) en un rango de horas hacia atrás. */
export function lossMatrix(hoursBack: number): LossMatrixCell[] {
  const since = withFocus(Math.floor(Date.now() / 1000) - hoursBack * 3600);
  const rows = db
    .prepare(
      `SELECT origin, src_address, target, COUNT(*) AS samples,
              AVG(loss_pct) AS avg_loss, AVG(avg_ms) AS avg_ms
       FROM probe_results WHERE ts >= ?
       GROUP BY origin, src_address, target
       ORDER BY origin, target`,
    )
    .all(since) as { origin: string; src_address: string; target: string; samples: number; avg_loss: number; avg_ms: number | null }[];

  const nodeNames = new Map<number, string>();
  for (const n of db.prepare('SELECT id, name FROM nodes').all() as { id: number; name: string }[]) {
    nodeNames.set(n.id, n.name);
  }

  return rows.map((r) => ({
    origin: r.origin,
    originName: r.origin === 'pc' ? 'PC de monitoreo' : nodeNames.get(parseInt(r.origin.slice(5), 10)) ?? r.origin,
    srcAddress: r.src_address,
    target: r.target,
    samples: r.samples,
    avgLossPct: Math.round(r.avg_loss * 10) / 10,
    avgMs: r.avg_ms !== null ? Math.round(r.avg_ms * 10) / 10 : null,
  }));
}

export interface HourlyLossRow {
  hour: number;       // 0-23 hora local
  avgLossPct: number;
  avgUtilizationPct: number | null;
  samples: number;
}

/**
 * Correlación pérdida ↔ utilización por hora del día (para la hipótesis de
 * horas pico). Usa las sondas del PC hacia targets externos y la utilización
 * del enlace indicado (o de todos si edgeId es null).
 */
export function hourlyCorrelation(edgeId: number | null, daysBack: number): HourlyLossRow[] {
  const since = withFocus(Math.floor(Date.now() / 1000) - daysBack * 24 * 3600);
  const tzOffsetMin = new Date().getTimezoneOffset(); // minutos a RESTAR de UTC

  const loss = db
    .prepare(
      `SELECT ((ts - ?*60) % 86400) / 3600 AS hour, AVG(loss_pct) AS avg_loss, COUNT(*) AS n
       FROM probe_results WHERE ts >= ? GROUP BY hour`,
    )
    .all(tzOffsetMin, since) as { hour: number; avg_loss: number; n: number }[];

  const utilParams: (number | string)[] = [tzOffsetMin, since];
  let utilWhere = `metric IN ('utilization_pct','agg5m:utilization_pct') AND ts >= ?`;
  if (edgeId !== null) {
    utilWhere += ' AND edge_id = ?';
    utilParams.push(edgeId);
  }
  const util = db
    .prepare(
      `SELECT ((ts - ?*60) % 86400) / 3600 AS hour, AVG(value) AS avg_util
       FROM metrics WHERE ${utilWhere} GROUP BY hour`,
    )
    .all(...utilParams) as { hour: number; avg_util: number }[];
  const utilByHour = new Map(util.map((u) => [u.hour, u.avg_util]));

  const out: HourlyLossRow[] = [];
  for (let h = 0; h < 24; h++) {
    const l = loss.find((x) => x.hour === h);
    const u = utilByHour.get(h);
    out.push({
      hour: h,
      avgLossPct: l ? Math.round(l.avg_loss * 10) / 10 : 0,
      avgUtilizationPct: u !== undefined ? Math.round(u * 10) / 10 : null,
      samples: l?.n ?? 0,
    });
  }
  return out;
}
