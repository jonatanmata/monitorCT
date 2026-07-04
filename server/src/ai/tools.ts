import type Anthropic from '@anthropic-ai/sdk';
import { db, type NodeRow, type EdgeRow } from '../db/index.js';
import { allLiveNodes } from '../state.js';
import { nodeCredentials } from '../pollers/collector.js';
import { pingHost } from '../pollers/ping.js';
import { pingFromMikrotik, getSystemInfo, getInterfaceStats, getQueueDrops, getEthernetStatus, runCableTestAll } from '../pollers/mikrotik.js';
import { pollUbiquiti, pollMimosa, pollLinkHealth } from '../pollers/snmp.js';
import { lossMatrix, hourlyCorrelation } from '../pollers/probes.js';

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'get_topology',
    description:
      'Devuelve el grafo completo de la red: nodos (con tipo, IP y estado en vivo) y aristas (enlaces físicos con capacidad en Mbps). Úsalo primero para entender la cadena de dependencias.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_metrics',
    description:
      'Series de tiempo de una métrica para un nodo o arista. Métricas de nodo: cpu_pct, mem_pct, latency_ms, loss_pct, signal_dbm, noise_dbm, ccq_pct, stations, rx_mbps, tx_mbps, tx_drops, rx_errors, queue_drops, snr_db, phy_rx_mbps, phy_tx_mbps, airmax_quality_pct, airmax_capacity_pct, link_speed_mbps (velocidad negociada del puerto), duplex (1=full/0=half), crc_errors (errores CRC/FCS = cable/EMI), collisions. Métricas de arista: utilization_pct, rx_mbps, tx_mbps.',
    input_schema: {
      type: 'object',
      properties: {
        nodeId: { type: 'number', description: 'ID del nodo (omitir si es métrica de arista)' },
        edgeId: { type: 'number', description: 'ID de la arista (omitir si es métrica de nodo)' },
        metric: { type: 'string', description: 'Nombre de la métrica' },
        hoursBack: { type: 'number', description: 'Horas hacia atrás (por defecto 6, máx 720)' },
      },
      required: ['metric'],
      additionalProperties: false,
    },
  },
  {
    name: 'ping_now',
    description:
      'Ping en vivo bajo demanda. origin="pc" hace ping desde el PC de monitoreo (atraviesa toda la red como un cliente). origin="node:<id>" hace ping desde ese MikroTik vía API; con srcAddress se fuerza una IP de origen LAN para que el paquete se trate como tráfico de cliente (clave: el ping por defecto del router NO pasa por colas ni FastTrack).',
    input_schema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: '"pc" o "node:<id>" (el nodo debe ser mikrotik)' },
        target: { type: 'string', description: 'IP o host destino' },
        srcAddress: { type: 'string', description: 'src-address opcional para ping desde MikroTik' },
      },
      required: ['origin', 'target'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_device_detail',
    description:
      'Consulta en vivo del equipo: para mikrotik devuelve CPU/memoria/interfaces (tráfico, drops)/colas; para antenas (SNMP) devuelve señal, ruido, CCQ, SNR, capacidad y estaciones actuales.',
    input_schema: {
      type: 'object',
      properties: { nodeId: { type: 'number' } },
      required: ['nodeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_loss_matrix',
    description:
      'Matriz de pérdida promedio por par (origen → destino externo) de las sondas registradas. Compara qué orígenes pierden hacia 8.8.8.8/gateway y cuáles no, para delimitar el segmento culpable. srcAddress="" es el ping por defecto del router; con IP es tráfico simulado de cliente.',
    input_schema: {
      type: 'object',
      properties: { hoursBack: { type: 'number', description: 'Horas hacia atrás (por defecto 24)' } },
      additionalProperties: false,
    },
  },
  {
    name: 'correlate_saturation',
    description:
      'Correlación por hora del día entre pérdida hacia internet (sondas) y utilización de un enlace (o todos). Sirve para confirmar o descartar saturación en horas pico.',
    input_schema: {
      type: 'object',
      properties: {
        edgeId: { type: 'number', description: 'ID de la arista; omitir para promediar todos los enlaces' },
        daysBack: { type: 'number', description: 'Días hacia atrás (por defecto 7)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_recent_alerts',
    description: 'Alertas recientes (abiertas y resueltas) con su severidad y mensaje.',
    input_schema: {
      type: 'object',
      properties: { hoursBack: { type: 'number', description: 'Horas hacia atrás (por defecto 24)' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_link_health',
    description:
      'Salud física del enlace por puerto ethernet del equipo: velocidad negociada (Mbps), dúplex (full/half) y errores CRC/FCS. Úsalo para DESCARTAR problemas de cable UTP: un puerto Gigabit negociado a 100 Mbps o en half-duplex, o errores CRC crecientes, apuntan a cable/conector/EMI, no a RF ni saturación. Funciona en MikroTik (RouterOS) y en equipos SNMP que expongan EtherLike-MIB.',
    input_schema: {
      type: 'object',
      properties: { nodeId: { type: 'number' } },
      required: ['nodeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_cable_test',
    description:
      'Prueba de cable TDR en vivo (solo MikroTik): reporta par por par si el cable está ok/abierto/en corto y a qué distancia en metros está la falla. Es la prueba definitiva para confirmar o descartar un problema físico de cable. OJO: interrumpe el enlace de ese puerto ~1 segundo, así que úsalo cuando ya sospeches del cable (no de forma rutinaria). Para un equipo detrás de un switch pasivo, prueba el puerto del MikroTik vecino.',
    input_schema: {
      type: 'object',
      properties: {
        nodeId: { type: 'number' },
        interface: { type: 'string', description: 'Nombre del puerto ethernet; omitir para probar todos' },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
  },
];

function getNode(nodeId: number): NodeRow | undefined {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId) as NodeRow | undefined;
}

async function execGetTopology(): Promise<unknown> {
  const nodes = db.prepare('SELECT id, type, name, ip FROM nodes').all() as Pick<NodeRow, 'id' | 'type' | 'name' | 'ip'>[];
  const edges = db.prepare('SELECT id, source_id, target_id, label, capacity_mbps, source_interface FROM edges').all() as EdgeRow[];
  const live = allLiveNodes();
  return {
    nodes: nodes.map((n) => ({ ...n, live: live[n.id] ?? null })),
    edges,
  };
}

async function execGetMetrics(input: { nodeId?: number; edgeId?: number; metric: string; hoursBack?: number }): Promise<unknown> {
  const hours = Math.min(input.hoursBack ?? 6, 720);
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const metricNames = hours > 48 ? [`agg5m:${input.metric}`] : [input.metric, `agg5m:${input.metric}`];
  const rows = db
    .prepare(
      `SELECT metric, value, extra, ts FROM metrics
       WHERE node_id IS ? AND edge_id IS ? AND metric IN (${metricNames.map(() => '?').join(',')}) AND ts >= ?
       ORDER BY ts`,
    )
    .all(input.nodeId ?? null, input.edgeId ?? null, ...metricNames, since) as {
    metric: string; value: number; extra: string | null; ts: number;
  }[];

  // Compactar: si hay demasiados puntos, muestrear para no inflar el contexto
  const maxPoints = 300;
  const step = rows.length > maxPoints ? Math.ceil(rows.length / maxPoints) : 1;
  const points = rows.filter((_, i) => i % step === 0).map((r) => ({
    ts: r.ts,
    iso: new Date(r.ts * 1000).toISOString(),
    value: Math.round(r.value * 100) / 100,
    ...(r.extra ? { extra: JSON.parse(r.extra) } : {}),
  }));
  const values = rows.map((r) => r.value);
  return {
    metric: input.metric,
    totalSamples: rows.length,
    stats: values.length
      ? {
          min: Math.min(...values),
          max: Math.max(...values),
          avg: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
        }
      : null,
    points,
  };
}

async function execPingNow(input: { origin: string; target: string; srcAddress?: string }): Promise<unknown> {
  if (input.origin === 'pc') {
    return await pingHost(input.target, 10);
  }
  const m = /^node:(\d+)$/.exec(input.origin);
  if (!m) return { error: 'origin debe ser "pc" o "node:<id>"' };
  const node = getNode(parseInt(m[1], 10));
  if (!node) return { error: 'Nodo no encontrado' };
  if (node.type !== 'mikrotik') return { error: 'Solo se puede hacer ping remoto desde nodos mikrotik' };
  return await pingFromMikrotik(node.ip, nodeCredentials(node), input.target, input.srcAddress, 10);
}

async function execGetDeviceDetail(input: { nodeId: number }): Promise<unknown> {
  const node = getNode(input.nodeId);
  if (!node) return { error: 'Nodo no encontrado' };
  const creds = nodeCredentials(node);
  if (node.type === 'mikrotik') {
    const [info, ifaces, queues] = await Promise.all([
      getSystemInfo(node.ip, creds),
      getInterfaceStats(node.ip, creds),
      getQueueDrops(node.ip, creds),
    ]);
    return { node: { id: node.id, name: node.name, ip: node.ip }, system: info, interfaces: ifaces, queues };
  }
  if (node.type === 'ptp-mimosa') {
    return { node: { id: node.id, name: node.name, ip: node.ip }, radio: await pollMimosa(node.ip, creds.snmpCommunity || 'public') };
  }
  if (node.type === 'ap-ubiquiti' || node.type === 'cliente') {
    return { node: { id: node.id, name: node.name, ip: node.ip }, radio: await pollUbiquiti(node.ip, creds.snmpCommunity || 'public') };
  }
  return { node: { id: node.id, name: node.name, ip: node.ip }, note: 'Tipo sin consulta en vivo; usar ping_now' };
}

async function execGetLossMatrix(input: { hoursBack?: number }): Promise<unknown> {
  return { matrix: lossMatrix(Math.min(input.hoursBack ?? 24, 720)) };
}

async function execCorrelateSaturation(input: { edgeId?: number; daysBack?: number }): Promise<unknown> {
  return { hourly: hourlyCorrelation(input.edgeId ?? null, Math.min(input.daysBack ?? 7, 30)) };
}

async function execGetRecentAlerts(input: { hoursBack?: number }): Promise<unknown> {
  const since = Math.floor(Date.now() / 1000) - Math.min(input.hoursBack ?? 24, 720) * 3600;
  const rows = db
    .prepare(
      `SELECT a.id, a.severity, a.type, a.message, a.created_at, a.resolved_at, n.name AS node_name
       FROM alerts a LEFT JOIN nodes n ON n.id = a.node_id
       WHERE a.created_at >= ? ORDER BY a.created_at DESC LIMIT 100`,
    )
    .all(since);
  return { alerts: rows };
}

async function execGetLinkHealth(input: { nodeId: number }): Promise<unknown> {
  const node = getNode(input.nodeId);
  if (!node) return { error: 'Nodo no encontrado' };
  const creds = nodeCredentials(node);
  if (node.type === 'mikrotik') {
    const status = await getEthernetStatus(node.ip, creds);
    return { node: node.name, interfaces: status };
  }
  if (node.type === 'switch') {
    return { node: node.name, note: 'Switch no administrable (pasivo): no reporta salud de enlace. Prueba el puerto del equipo administrable vecino.' };
  }
  if (node.ip) {
    try {
      const links = await pollLinkHealth(node.ip, creds.snmpCommunity || 'public');
      return { node: node.name, interfaces: links };
    } catch (err) {
      return { node: node.name, error: `SNMP no respondió: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { node: node.name, note: 'Sin IP; no se puede consultar salud de enlace' };
}

async function execRunCableTest(input: { nodeId: number; interface?: string }): Promise<unknown> {
  const node = getNode(input.nodeId);
  if (!node) return { error: 'Nodo no encontrado' };
  if (node.type !== 'mikrotik') {
    return { supported: false, note: 'La prueba TDR requiere un MikroTik. Para equipos detrás de un switch pasivo, prueba el puerto del MikroTik vecino.' };
  }
  if (!node.ip) return { supported: false, note: 'El nodo no tiene IP' };
  try {
    return { supported: true, results: await runCableTestAll(node.ip, nodeCredentials(node), input.interface) };
  } catch (err) {
    return { supported: false, note: err instanceof Error ? err.message : String(err) };
  }
}

export async function executeTool(name: string, input: unknown): Promise<string> {
  const i = (input ?? {}) as never;
  try {
    let result: unknown;
    switch (name) {
      case 'get_topology': result = await execGetTopology(); break;
      case 'get_metrics': result = await execGetMetrics(i); break;
      case 'ping_now': result = await execPingNow(i); break;
      case 'get_device_detail': result = await execGetDeviceDetail(i); break;
      case 'get_loss_matrix': result = await execGetLossMatrix(i); break;
      case 'correlate_saturation': result = await execCorrelateSaturation(i); break;
      case 'get_recent_alerts': result = await execGetRecentAlerts(i); break;
      case 'get_link_health': result = await execGetLinkHealth(i); break;
      case 'run_cable_test': result = await execRunCableTest(i); break;
      default: return JSON.stringify({ error: `Herramienta desconocida: ${name}` });
    }
    return JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}
