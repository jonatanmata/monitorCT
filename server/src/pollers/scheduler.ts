import { db, pruneOldData, rollupMetrics, type NodeRow } from '../db/index.js';
import { pollNodePing, pollMikrotikMetrics, pollSnmpMetrics, broadcastStatus } from './collector.js';
import { runPcProbes, runMikrotikProbes } from './probes.js';
import { evaluateAlerts } from '../alerts/engine.js';
import { remindOpenCritical } from '../alerts/notifier.js';
import { diagnoseAlert, aiAvailable } from '../ai/agent.js';
import { getLiveNode } from '../state.js';

const PING_INTERVAL_MS = 15_000;
const METRICS_INTERVAL_MS = 60_000;
const PROBE_INTERVAL_MS = 60_000;
const REMINDER_INTERVAL_MS = 60_000; // chequeo de recordatorios; el gate real es reminderMinutes
const HOUSEKEEPING_INTERVAL_MS = 3_600_000;

/** Al arrancar: resuelve alertas huérfanas (de nodos ya borrados) para que no queden abiertas para siempre. */
function purgeOrphanAlerts(): void {
  try {
    // La FK es ON DELETE SET NULL: al borrar un nodo/enlace, sus alertas quedan con
    // node_id/edge_id en NULL y abiertas para siempre. Una alerta sin nodo NI enlace
    // es basura → se elimina. También las que apunten a un id inexistente.
    db.prepare('DELETE FROM alerts WHERE node_id IS NULL AND edge_id IS NULL').run();
    db.prepare('DELETE FROM alerts WHERE node_id IS NOT NULL AND node_id NOT IN (SELECT id FROM nodes)').run();
    db.prepare('DELETE FROM alerts WHERE edge_id IS NOT NULL AND edge_id NOT IN (SELECT id FROM edges)').run();
  } catch (err) { console.error('purgeOrphanAlerts:', err); }
}

function enabledNodes(): NodeRow[] {
  return db.prepare(`SELECT * FROM nodes WHERE enabled = 1 AND ip != ''`).all() as NodeRow[];
}

/** Evalúa alertas, redifunde el estado y lanza el diagnóstico IA de las nuevas. */
function runAlerts(): void {
  const newAlerts = evaluateAlerts();
  broadcastStatus(); // redifundir con bwNear ya calculado
  if (aiAvailable()) {
    for (const id of newAlerts) void diagnoseAlert(id);
  }
}

async function pingCycle(): Promise<void> {
  const nodes = enabledNodes();
  // Lotes de 8 pings simultáneos para no saturar
  for (let i = 0; i < nodes.length; i += 8) {
    await Promise.allSettled(nodes.slice(i, i + 8).map((n) => pollNodePing(n)));
  }
  broadcastStatus();
  // Evaluar caídas/recuperaciones en CADA ciclo de ping (15 s), no solo cada 60 s:
  // así un reinicio corto de un equipo no se escapa entre evaluaciones.
  runAlerts();
}

async function metricsCycle(): Promise<void> {
  const nodes = enabledNodes();
  for (const node of nodes) {
    // No intentar consultas caras a nodos caídos
    if (getLiveNode(node.id).status === 'down') continue;
    try {
      if (node.type === 'mikrotik') await pollMikrotikMetrics(node);
      else if (
        node.type === 'ptp-mimosa' || node.type === 'ap-ubiquiti' ||
        node.type === 'litebeam' || node.type === 'cliente' || node.type === 'router'
      ) {
        // router genérico: solo salud de enlace SNMP (sin radio); el resto también leen radio
        await pollSnmpMetrics(node);
      }
      // switch (pasivo), gateway-isp, monitor → solo ping
    } catch {
      // el equipo respondió al ping pero no a la consulta; se reintenta en el próximo ciclo
    }
  }
  broadcastStatus();
  // Evaluar alertas tras el ciclo de métricas (con datos frescos de CPU/señal/utilización).
  runAlerts();
}

async function probeCycle(): Promise<void> {
  await Promise.allSettled([runPcProbes(), runMikrotikProbes()]);
}

function housekeeping(): void {
  try {
    rollupMetrics();
    pruneOldData();
  } catch (err) {
    console.error('housekeeping:', err);
  }
}

let timers: NodeJS.Timeout[] = [];

export function startScheduler(): void {
  stopScheduler();
  purgeOrphanAlerts();
  const guard = (fn: () => Promise<void>) => {
    let running = false;
    return () => {
      if (running) return;
      running = true;
      fn()
        .catch((err) => console.error('poller:', err))
        .finally(() => { running = false; });
    };
  };
  timers = [
    setInterval(guard(pingCycle), PING_INTERVAL_MS),
    setInterval(guard(metricsCycle), METRICS_INTERVAL_MS),
    setInterval(guard(probeCycle), PROBE_INTERVAL_MS),
    setInterval(() => { try { remindOpenCritical(); } catch (err) { console.error('reminder:', err); } }, REMINDER_INTERVAL_MS),
    setInterval(housekeeping, HOUSEKEEPING_INTERVAL_MS),
  ];
  // Primer ciclo inmediato
  void pingCycle().then(() => metricsCycle()).catch(() => {});
  void probeCycle().catch(() => {});
}

export function stopScheduler(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
}
