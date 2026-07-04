import { db, getSetting } from '../db/index.js';
import { getLiveNode, broadcast } from '../state.js';
import type { NodeRow, EdgeRow } from '../db/index.js';
import { sendTelegram, formatAlertMessage, formatResolvedMessage, telegramAllowsSeverity, telegramNotifyResolved } from './telegram.js';

export interface Thresholds {
  cpuPct: number;
  signalDbm: number;
  lossPct: number;
  utilizationPct: number;
  saturationLossPct: number;
  crcErrorsPer5min: number;   // errores CRC/FCS por ventana de 5 min que disparan alerta de cable
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  cpuPct: 85,
  signalDbm: -75,
  lossPct: 10,
  utilizationPct: 85,
  saturationLossPct: 3,
  crcErrorsPer5min: 50,
};

export function getThresholds(): Thresholds {
  try {
    return { ...DEFAULT_THRESHOLDS, ...JSON.parse(getSetting('thresholds', '{}')) };
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

interface OpenAlertKey {
  nodeId: number | null;
  edgeId: number | null;
  type: string;
}

function findOpenAlert(key: OpenAlertKey): { id: number } | undefined {
  return db
    .prepare(
      `SELECT id FROM alerts WHERE resolved_at IS NULL AND type = ?
       AND node_id IS ? AND edge_id IS ?`,
    )
    .get(key.type, key.nodeId, key.edgeId) as { id: number } | undefined;
}

/** Dispara una alerta si no hay una abierta igual. Devuelve el id si es nueva. */
function raise(key: OpenAlertKey, severity: 'info' | 'warning' | 'critical', message: string): number | null {
  if (findOpenAlert(key)) return null;
  const res = db
    .prepare('INSERT INTO alerts (node_id, edge_id, severity, type, message) VALUES (?, ?, ?, ?, ?)')
    .run(key.nodeId, key.edgeId, severity, key.type, message);
  const id = Number(res.lastInsertRowid);
  broadcast('alert', { id, ...key, severity, message });
  // Notificación a Telegram (si está configurado y la severidad supera el umbral elegido)
  if (telegramAllowsSeverity(severity)) void sendTelegram(formatAlertMessage({ severity, type: key.type, message }));
  return id;
}

function resolve(key: OpenAlertKey): void {
  const open = findOpenAlert(key) as { id: number; message?: string } | undefined;
  if (open) {
    const row = db.prepare('SELECT message FROM alerts WHERE id = ?').get(open.id) as { message: string } | undefined;
    db.prepare('UPDATE alerts SET resolved_at = unixepoch() WHERE id = ?').run(open.id);
    broadcast('alert_resolved', { id: open.id });
    if (row && telegramNotifyResolved()) void sendTelegram(formatResolvedMessage(row.message));
  }
}

function avgRecent(nodeId: number | null, edgeId: number | null, metric: string, minutes: number): number | null {
  const since = Math.floor(Date.now() / 1000) - minutes * 60;
  const row = db
    .prepare('SELECT AVG(value) AS v FROM metrics WHERE node_id IS ? AND edge_id IS ? AND metric = ? AND ts >= ?')
    .get(nodeId, edgeId, metric, since) as { v: number | null };
  return row.v;
}

/** Interfaces con métrica reciente de un tipo (para iterar por puerto). */
function recentInterfaces(nodeId: number, metric: string, minutes: number): string[] {
  const since = Math.floor(Date.now() / 1000) - minutes * 60;
  const rows = db
    .prepare(
      `SELECT DISTINCT json_extract(extra, '$.iface') AS iface
       FROM metrics WHERE node_id = ? AND metric = ? AND ts >= ? AND extra IS NOT NULL`,
    )
    .all(nodeId, metric, since) as { iface: string | null }[];
  return rows.map((r) => r.iface).filter((x): x is string => Boolean(x));
}

/** Diagnóstico físico por interfaz: bajada de velocidad, half-duplex y errores CRC. */
function checkPhysical(node: NodeRow, t: Thresholds, out: number[]): void {
  const now = Math.floor(Date.now() / 1000);
  const ifaces = new Set([
    ...recentInterfaces(node.id, 'link_speed_mbps', 30),
    ...recentInterfaces(node.id, 'crc_errors', 10),
  ]);

  for (const iface of ifaces) {
    const ifWhere = `node_id = ? AND metric = ? AND json_extract(extra,'$.iface') = ?`;

    // 1) Bajada de velocidad: la velocidad actual es menor que el máximo histórico visto en ese puerto
    const speed = db
      .prepare(`SELECT MAX(value) AS mx, (SELECT value FROM metrics WHERE ${ifWhere} ORDER BY ts DESC LIMIT 1) AS last FROM metrics WHERE ${ifWhere}`)
      .get(node.id, 'link_speed_mbps', iface, node.id, 'link_speed_mbps', iface) as { mx: number | null; last: number | null };
    const dsKey = { nodeId: node.id, edgeId: null, type: `link_downshift:${iface}` };
    if (speed.mx !== null && speed.last !== null && speed.last < speed.mx && speed.mx >= 1000) {
      const id = raise(dsKey, 'warning',
        `${node.name} · ${iface}: el enlace bajó de ${speed.mx} a ${speed.last} Mbps — posible cable/par dañado (Gigabit necesita los 4 pares)`);
      if (id) out.push(id);
    } else if (speed.last !== null) {
      resolve(dsKey);
    }

    // 2) Half-duplex reciente
    const dpx = db
      .prepare(`SELECT value FROM metrics WHERE ${ifWhere} ORDER BY ts DESC LIMIT 1`)
      .get(node.id, 'duplex', iface) as { value: number } | undefined;
    const hdKey = { nodeId: node.id, edgeId: null, type: `half_duplex:${iface}` };
    if (dpx && dpx.value === 0) {
      const id = raise(hdKey, 'warning', `${node.name} · ${iface}: dúplex en HALF — mala negociación o cable defectuoso`);
      if (id) out.push(id);
    } else if (dpx) {
      resolve(hdKey);
    }

    // 3) Errores CRC/FCS acumulados en los últimos 5 min
    const crc = db
      .prepare(`SELECT SUM(value) AS s FROM metrics WHERE ${ifWhere} AND ts >= ?`)
      .get(node.id, 'crc_errors', iface, now - 5 * 60) as { s: number | null };
    const crcKey = { nodeId: node.id, edgeId: null, type: `crc_errors:${iface}` };
    if ((crc.s ?? 0) > t.crcErrorsPer5min) {
      const id = raise(crcKey, 'warning',
        `${node.name} · ${iface}: ${crc.s} errores CRC/FCS en 5 min — cable, conector RJ45 o interferencia (EMI)`);
      if (id) out.push(id);
    } else if (crc.s !== null && crc.s === 0) {
      resolve(crcKey);
    }
  }
}

/** IDs de alertas nuevas creadas en esta pasada (para lanzar diagnóstico IA). */
export function evaluateAlerts(): number[] {
  const t = getThresholds();
  const newAlertIds: number[] = [];
  const nodes = db.prepare('SELECT * FROM nodes WHERE enabled = 1').all() as NodeRow[];
  const edges = db.prepare('SELECT * FROM edges').all() as EdgeRow[];
  const nodeName = new Map(nodes.map((n) => [n.id, n.name]));

  for (const node of nodes) {
    const live = getLiveNode(node.id);

    // Nodo caído
    const downKey = { nodeId: node.id, edgeId: null, type: 'node_down' };
    if (live.status === 'down') {
      const id = raise(downKey, 'critical', `${node.name} (${node.ip}) no responde a ping`);
      if (id) newAlertIds.push(id);
    } else if (live.status === 'up') {
      resolve(downKey);
    }

    // CPU alta (MikroTik)
    if (node.type === 'mikrotik') {
      const cpu = avgRecent(node.id, null, 'cpu_pct', 5);
      const key = { nodeId: node.id, edgeId: null, type: 'high_cpu' };
      if (cpu !== null && cpu > t.cpuPct) {
        const id = raise(key, 'warning', `${node.name}: CPU promedio ${cpu.toFixed(0)}% en los últimos 5 min (umbral ${t.cpuPct}%)`);
        if (id) newAlertIds.push(id);
      } else if (cpu !== null) {
        resolve(key);
      }
    }

    // Señal baja (antenas)
    if (node.type === 'ap-ubiquiti' || node.type === 'ptp-mimosa' || node.type === 'litebeam' || node.type === 'cliente') {
      const signal = avgRecent(node.id, null, 'signal_dbm', 10);
      const key = { nodeId: node.id, edgeId: null, type: 'low_signal' };
      if (signal !== null && signal < t.signalDbm) {
        const id = raise(key, 'warning', `${node.name}: señal ${signal.toFixed(0)} dBm por debajo del umbral (${t.signalDbm} dBm)`);
        if (id) newAlertIds.push(id);
      } else if (signal !== null) {
        resolve(key);
      }
    }

    // Pérdida alta al equipo
    const loss = avgRecent(node.id, null, 'loss_pct', 5);
    const lossKey = { nodeId: node.id, edgeId: null, type: 'high_loss' };
    if (loss !== null && loss > t.lossPct && live.status !== 'down') {
      const id = raise(lossKey, 'warning', `${node.name}: pérdida de paquetes ${loss.toFixed(1)}% en los últimos 5 min`);
      if (id) newAlertIds.push(id);
    } else if (loss !== null && loss <= t.lossPct) {
      resolve(lossKey);
    }

    // ---- Diagnóstico físico (cable UTP) por interfaz ----
    checkPhysical(node, t, newAlertIds);
  }

  // Saturación + pérdida coincidente (la firma del problema de horas pico)
  const since = Math.floor(Date.now() / 1000) - 10 * 60;
  const pcLoss = db
    .prepare(`SELECT AVG(loss_pct) AS v FROM probe_results WHERE origin = 'pc' AND ts >= ?`)
    .get(since) as { v: number | null };
  for (const edge of edges) {
    const util = avgRecent(null, edge.id, 'utilization_pct', 10);
    const key = { nodeId: null, edgeId: edge.id, type: 'saturation_loss' };
    const label = edge.label || `${nodeName.get(edge.source_id) ?? '?'} → ${nodeName.get(edge.target_id) ?? '?'}`;
    if (util !== null && util > t.utilizationPct && (pcLoss.v ?? 0) > t.saturationLossPct) {
      const id = raise(
        key,
        'critical',
        `Enlace ${label}: utilización ${util.toFixed(0)}% sostenida coincidiendo con ${pcLoss.v!.toFixed(1)}% de pérdida hacia internet — saturación probable`,
      );
      if (id) newAlertIds.push(id);
    } else if (util !== null && util <= t.utilizationPct) {
      resolve(key);
    }
  }

  return newAlertIds;
}
