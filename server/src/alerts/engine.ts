import { db, getSetting } from '../db/index.js';
import { getLiveNode, broadcast } from '../state.js';
import type { NodeRow, EdgeRow } from '../db/index.js';
import { sendTelegram, formatAlertMessage } from './telegram.js';

export interface Thresholds {
  cpuPct: number;
  signalDbm: number;
  lossPct: number;
  utilizationPct: number;
  saturationLossPct: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  cpuPct: 85,
  signalDbm: -75,
  lossPct: 10,
  utilizationPct: 85,
  saturationLossPct: 3,
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
  // Notificación a Telegram (si está configurado); no bloquea la evaluación
  void sendTelegram(formatAlertMessage({ severity, type: key.type, message }));
  return id;
}

function resolve(key: OpenAlertKey): void {
  const open = findOpenAlert(key);
  if (open) {
    db.prepare('UPDATE alerts SET resolved_at = unixepoch() WHERE id = ?').run(open.id);
    broadcast('alert_resolved', { id: open.id });
  }
}

function avgRecent(nodeId: number | null, edgeId: number | null, metric: string, minutes: number): number | null {
  const since = Math.floor(Date.now() / 1000) - minutes * 60;
  const row = db
    .prepare('SELECT AVG(value) AS v FROM metrics WHERE node_id IS ? AND edge_id IS ? AND metric = ? AND ts >= ?')
    .get(nodeId, edgeId, metric, since) as { v: number | null };
  return row.v;
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
    if (node.type === 'ap-ubiquiti' || node.type === 'ptp-mimosa' || node.type === 'cliente') {
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
