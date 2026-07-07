import { db, pruneOldData, rollupMetrics, type NodeRow } from '../db/index.js';
import { pollNodePing, pollMikrotikMetrics, pollSnmpMetrics, broadcastStatus } from './collector.js';
import { runPcProbes, runMikrotikProbes } from './probes.js';
import { evaluateAlerts } from '../alerts/engine.js';
import { diagnoseAlert, aiAvailable } from '../ai/agent.js';
import { getLiveNode } from '../state.js';

const PING_INTERVAL_MS = 15_000;
const METRICS_INTERVAL_MS = 60_000;
const PROBE_INTERVAL_MS = 60_000;
const HOUSEKEEPING_INTERVAL_MS = 3_600_000;

function enabledNodes(): NodeRow[] {
  return db.prepare(`SELECT * FROM nodes WHERE enabled = 1 AND ip != ''`).all() as NodeRow[];
}

async function pingCycle(): Promise<void> {
  const nodes = enabledNodes();
  // Lotes de 8 pings simultáneos para no saturar
  for (let i = 0; i < nodes.length; i += 8) {
    await Promise.allSettled(nodes.slice(i, i + 8).map((n) => pollNodePing(n)));
  }
  broadcastStatus();
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

  // Evaluar alertas tras cada ciclo de métricas; diagnóstico IA en segundo plano
  const newAlerts = evaluateAlerts();
  broadcastStatus(); // re-difundir con el resaltado de ancho de banda (bwNear) ya calculado
  if (aiAvailable()) {
    for (const id of newAlerts) void diagnoseAlert(id);
  }
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
