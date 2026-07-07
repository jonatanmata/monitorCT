import { db, type NodeRow, type EdgeRow, type Credentials } from '../db/index.js';
import { decryptJson } from '../db/crypto.js';
import { getLiveNode, broadcast } from '../state.js';
import { pingHost } from './ping.js';
import * as mikrotik from './mikrotik.js';
import * as snmpPoll from './snmp.js';

const insertMetric = () =>
  db.prepare('INSERT INTO metrics (node_id, edge_id, metric, value, extra, ts) VALUES (?, ?, ?, ?, ?, ?)');

export function writeMetric(opts: {
  nodeId?: number | null;
  edgeId?: number | null;
  metric: string;
  value: number;
  extra?: unknown;
}): void {
  insertMetric().run(
    opts.nodeId ?? null,
    opts.edgeId ?? null,
    opts.metric,
    opts.value,
    opts.extra ? JSON.stringify(opts.extra) : null,
    Math.floor(Date.now() / 1000),
  );
}

export function nodeCredentials(node: NodeRow): Credentials {
  return decryptJson<Credentials>(node.credentials_enc, {});
}

// ---------- Ping de disponibilidad a cada equipo ----------

export async function pollNodePing(node: NodeRow): Promise<void> {
  if (!node.ip) return;
  const live = getLiveNode(node.id);
  try {
    const res = await pingHost(node.ip, 4);
    live.latencyMs = res.avgMs;
    live.lossPct = res.lossPct;
    if (res.alive) {
      live.lastSeen = Math.floor(Date.now() / 1000);
      live.status = res.lossPct > 20 ? 'warning' : 'up';
    } else {
      live.status = 'down';
    }
    if (res.avgMs !== null) writeMetric({ nodeId: node.id, metric: 'latency_ms', value: res.avgMs });
    writeMetric({ nodeId: node.id, metric: 'loss_pct', value: res.lossPct });
  } catch {
    live.status = 'down';
    writeMetric({ nodeId: node.id, metric: 'loss_pct', value: 100 });
  }
}

// ---------- Métricas por tipo de equipo ----------

/** Contadores previos para calcular deltas de tráfico: clave "nodeId:iface". */
const lastCounters = new Map<string, { rx: number; tx: number; ts: number }>();
/** Drops previos por interfaz para reportar el incremento por intervalo. */
const lastDrops = new Map<string, { txDrops: number; rxErrors: number }>();
const lastQueueDrops = new Map<string, number>();
// Contadores acumulados de capa física (CRC/colisiones) para reportar el incremento por intervalo
const lastPhy = new Map<string, { crc: number; coll: number }>();

/** Delta de un contador acumulado; null la primera vez o si se reinició. */
function counterDelta(map: Map<string, { crc: number; coll: number }>, key: string, crc: number, coll: number): { dCrc: number; dColl: number } | null {
  const prev = map.get(key);
  map.set(key, { crc, coll });
  if (!prev) return null;
  const dCrc = crc - prev.crc;
  const dColl = coll - prev.coll;
  if (dCrc < 0 || dColl < 0) return null;
  return { dCrc, dColl };
}

function trafficDelta(key: string, rx: number, tx: number): { rxMbps: number; txMbps: number } | null {
  const now = Date.now() / 1000;
  const prev = lastCounters.get(key);
  lastCounters.set(key, { rx, tx, ts: now });
  if (!prev || now <= prev.ts) return null;
  const dt = now - prev.ts;
  const dRx = rx - prev.rx;
  const dTx = tx - prev.tx;
  if (dRx < 0 || dTx < 0) return null; // reinicio de contador
  return { rxMbps: (dRx * 8) / dt / 1e6, txMbps: (dTx * 8) / dt / 1e6 };
}

function edgesForNode(nodeId: number): EdgeRow[] {
  return db.prepare('SELECT * FROM edges WHERE source_id = ?').all(nodeId) as EdgeRow[];
}
/** Aristas donde el nodo es origen O destino (para medir utilización desde el MikroTik en cualquier sentido). */
function edgesTouchingNode(nodeId: number): EdgeRow[] {
  return db.prepare('SELECT * FROM edges WHERE source_id = ? OR target_id = ?').all(nodeId, nodeId) as EdgeRow[];
}
function nodeTypeOf(nodeId: number): string | undefined {
  return (db.prepare('SELECT type FROM nodes WHERE id = ?').get(nodeId) as { type: string } | undefined)?.type;
}

export async function pollMikrotikMetrics(node: NodeRow): Promise<void> {
  const creds = nodeCredentials(node);
  const live = getLiveNode(node.id);

  const info = await mikrotik.getSystemInfo(node.ip, creds);
  writeMetric({ nodeId: node.id, metric: 'cpu_pct', value: info.cpuPct });
  writeMetric({ nodeId: node.id, metric: 'mem_pct', value: info.memPct });
  live.summary.cpu_pct = info.cpuPct;
  live.summary.mem_pct = info.memPct;

  const ifaces = await mikrotik.getInterfaceStats(node.ip, creds);
  const edges = edgesTouchingNode(node.id);
  for (const iface of ifaces) {
    const key = `${node.id}:${iface.name}`;
    const delta = trafficDelta(key, iface.rxBytes, iface.txBytes);
    if (delta) {
      writeMetric({ nodeId: node.id, metric: 'rx_mbps', value: delta.rxMbps, extra: { iface: iface.name } });
      writeMetric({ nodeId: node.id, metric: 'tx_mbps', value: delta.txMbps, extra: { iface: iface.name } });

      // Utilización del enlace si alguna arista mapea esta interfaz. Se mide desde este MikroTik
      // sea origen o destino del enlace (así funciona aunque lo dibujaras Mimosa→MikroTik). Si es
      // el destino, solo se mide aquí cuando el origen NO es otro MikroTik (para no duplicar).
      const edge = edges.find((e) =>
        e.source_interface === iface.name && e.capacity_mbps != null &&
        (e.source_id === node.id || nodeTypeOf(e.source_id) !== 'mikrotik'),
      );
      if (edge?.capacity_mbps) {
        const util = (Math.max(delta.rxMbps, delta.txMbps) / edge.capacity_mbps) * 100;
        writeMetric({ edgeId: edge.id, metric: 'utilization_pct', value: Math.round(util * 10) / 10 });
        writeMetric({ edgeId: edge.id, metric: 'rx_mbps', value: delta.rxMbps });
        writeMetric({ edgeId: edge.id, metric: 'tx_mbps', value: delta.txMbps });
      }
    }
    // Incremento de drops/errores en el intervalo
    const prevDrops = lastDrops.get(key);
    lastDrops.set(key, { txDrops: iface.txDrops, rxErrors: iface.rxErrors });
    if (prevDrops) {
      const dDrops = iface.txDrops - prevDrops.txDrops;
      const dErrors = iface.rxErrors - prevDrops.rxErrors;
      if (dDrops > 0) writeMetric({ nodeId: node.id, metric: 'tx_drops', value: dDrops, extra: { iface: iface.name } });
      if (dErrors > 0) writeMetric({ nodeId: node.id, metric: 'rx_errors', value: dErrors, extra: { iface: iface.name } });
    }
  }

  // Drops de colas simples (si hay QoS configurado)
  const queues = await mikrotik.getQueueDrops(node.ip, creds);
  for (const q of queues) {
    const key = `${node.id}:queue:${q.name}`;
    const prev = lastQueueDrops.get(key);
    lastQueueDrops.set(key, q.dropped);
    if (prev !== undefined && q.dropped > prev) {
      writeMetric({ nodeId: node.id, metric: 'queue_drops', value: q.dropped - prev, extra: { queue: q.name } });
    }
  }

  // Salud de enlace por puerto ethernet (velocidad negociada, dúplex, CRC) — no invasivo
  try {
    const [status, errStats] = await Promise.all([
      mikrotik.getEthernetStatus(node.ip, creds),
      mikrotik.getEthernetErrorStats(node.ip, creds),
    ]);
    for (const s of status) {
      if (!s.linkOk) continue;
      if (s.rateMbps !== null) writeMetric({ nodeId: node.id, metric: 'link_speed_mbps', value: s.rateMbps, extra: { iface: s.name } });
      if (s.fullDuplex !== null) writeMetric({ nodeId: node.id, metric: 'duplex', value: s.fullDuplex ? 1 : 0, extra: { iface: s.name } });
    }
    for (const e of errStats) {
      const d = counterDelta(lastPhy, `${node.id}:${e.name}`, e.crcErrors, e.collisions);
      if (d) {
        if (d.dCrc > 0) writeMetric({ nodeId: node.id, metric: 'crc_errors', value: d.dCrc, extra: { iface: e.name } });
        if (d.dColl > 0) writeMetric({ nodeId: node.id, metric: 'collisions', value: d.dColl, extra: { iface: e.name } });
      }
    }
  } catch {
    // el equipo no expone /interface/ethernet (poco común); se omite
  }
}

export async function pollSnmpMetrics(node: NodeRow): Promise<void> {
  const creds = nodeCredentials(node);
  const community = creds.snmpCommunity || 'public';
  const live = getLiveNode(node.id);

  // Métricas de radio solo para equipos airMAX/Mimosa (el router genérico no tiene radio)
  if (node.type === 'ptp-mimosa') {
    const metrics = await snmpPoll.pollMimosa(node.ip, community);
    for (const [metric, value] of Object.entries(metrics)) {
      writeMetric({ nodeId: node.id, metric, value });
      live.summary[metric] = Math.round(value * 10) / 10;
    }
  } else if (node.type === 'ap-ubiquiti' || node.type === 'litebeam' || node.type === 'cliente') {
    const metrics = await snmpPoll.pollUbiquiti(node.ip, community);
    for (const [metric, value] of Object.entries(metrics)) {
      writeMetric({ nodeId: node.id, metric, value });
      live.summary[metric] = Math.round(value * 10) / 10;
    }
  }

  // Salud de enlace SNMP (velocidad negociada, dúplex, CRC/FCS) — todos los tipos SNMP
  try {
    const links = await snmpPoll.pollLinkHealth(node.ip, community);
    for (const l of links) {
      if (l.speedMbps !== null && l.speedMbps > 0) writeMetric({ nodeId: node.id, metric: 'link_speed_mbps', value: l.speedMbps, extra: { iface: l.name } });
      if (l.duplex !== null) writeMetric({ nodeId: node.id, metric: 'duplex', value: l.duplex, extra: { iface: l.name } });
      const d = counterDelta(lastPhy, `snmp:${node.id}:${l.name}`, l.fcsErrors, 0);
      if (d && d.dCrc > 0) writeMetric({ nodeId: node.id, metric: 'crc_errors', value: d.dCrc, extra: { iface: l.name } });
    }
  } catch {
    // EtherLike/IF-MIB no disponible en este equipo
  }

  // Tráfico IF-MIB con deltas (útil para AP y PTP)
  try {
    const counters = await snmpPoll.pollIfCounters(node.ip, community);
    const edges = edgesForNode(node.id);
    for (const c of counters) {
      const delta = trafficDelta(`${node.id}:${c.name}`, c.inOctets, c.outOctets);
      if (!delta) continue;
      if (delta.rxMbps > 0.01 || delta.txMbps > 0.01) {
        writeMetric({ nodeId: node.id, metric: 'rx_mbps', value: delta.rxMbps, extra: { iface: c.name } });
        writeMetric({ nodeId: node.id, metric: 'tx_mbps', value: delta.txMbps, extra: { iface: c.name } });
      }
      const edge = edges.find((e) => e.source_interface === c.name);
      if (edge?.capacity_mbps) {
        const util = (Math.max(delta.rxMbps, delta.txMbps) / edge.capacity_mbps) * 100;
        writeMetric({ edgeId: edge.id, metric: 'utilization_pct', value: Math.round(util * 10) / 10 });
      }
    }
  } catch {
    // IF-MIB no disponible; las métricas de radio ya se guardaron
  }
}

/** Publica el estado en vivo de todos los nodos hacia el frontend. */
export function broadcastStatus(): void {
  const rows = db.prepare('SELECT id FROM nodes').all() as { id: number }[];
  const payload: Record<number, unknown> = {};
  for (const r of rows) payload[r.id] = getLiveNode(r.id);
  broadcast('status', payload);
}
