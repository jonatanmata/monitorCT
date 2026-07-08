import { db } from '../db/index.js';
import {
  getTelegramConfig, sendTelegram, routeChat, isQuietNow, isWatched, isMuted, rankOf,
  formatAlertMessage, formatResolvedMessage, severityIcon, type Severity, type InlineButton,
} from './telegram.js';

/**
 * Notificador con ventana anti-spam y agrupación por causa raíz.
 * En vez de enviar cada alerta al instante, las junta durante una ventana corta
 * y, para los "caído" (node_down), usa el grafo de topología: si un equipo aguas
 * arriba también está caído, la caída de este es CONSECUENCIA — se suprime y solo
 * se notifica la raíz, con la lista de equipos que arrastra aguas abajo.
 */

interface RaisedItem { kind: 'raised'; alertId: number; nodeId: number | null; edgeId: number | null; severity: Severity; type: string; message: string }
interface ResolvedItem { kind: 'resolved'; nodeId: number | null; edgeId: number | null; type: string; message: string; minutesOpen: number | null }
type Item = RaisedItem | ResolvedItem;

let queue: Item[] = [];
let timer: NodeJS.Timeout | null = null;
// Última vez (epoch s) que se avisó por Telegram de cada alerta, para el recordatorio.
const lastNotified = new Map<number, number>();
const nowSec = () => Math.floor(Date.now() / 1000);

export function notifyRaised(item: Omit<RaisedItem, 'kind'>): void { enqueue({ kind: 'raised', ...item }); }
export function notifyResolved(item: Omit<ResolvedItem, 'kind'>): void { enqueue({ kind: 'resolved', ...item }); }

function enqueue(item: Item): void {
  const c = getTelegramConfig();
  if (!c.enabled || !c.botToken || !c.chatId) return;
  queue.push(item);
  if (!timer) {
    const ms = Math.max(1, c.groupWindowSec) * 1000;
    timer = setTimeout(() => { void flush(); }, ms);
  }
}

// ¿Se debe enviar según severidad/quiet/mute/vigilancia? (para el chat destino ver routeChat)
function shouldSend(nodeId: number | null, severity: Severity): boolean {
  const c = getTelegramConfig();
  if (isMuted(nodeId)) return false;
  if (isWatched(nodeId)) return true;                       // vigilado: siempre pasa
  if (rankOf(severity) < rankOf(c.minSeverity)) return false;
  if (isQuietNow() && severity !== 'critical') return false; // silencioso: solo críticas
  return true;
}

function buttonsFor(alertId: number | null, nodeId: number | null): InlineButton[][] | undefined {
  if (!getTelegramConfig().actionButtons) return undefined;
  const row: InlineButton[] = [];
  if (alertId) row.push({ text: '✔ Resolver', callback_data: `resolve:${alertId}` });
  if (nodeId) row.push({ text: '🔕 Silenciar 1h', callback_data: `mute:${nodeId}` });
  return row.length ? [row] : undefined;
}

export interface Topo {
  name: Map<number, string>; parent: Map<number, number>; children: Map<number, number[]>;
  openDown: Set<number>;
  /** Nodos pasivos (sin IP: fibra, NAP, poste, switch, contenedores): nunca caen y actúan como "cable". */
  transparent: Set<number>;
}
function loadTopo(): Topo {
  const nodes = db.prepare('SELECT id, name, type, ip FROM nodes').all() as { id: number; name: string; type: string; ip: string }[];
  const edges = db.prepare('SELECT source_id, target_id FROM edges').all() as { source_id: number; target_id: number }[];
  const name = new Map(nodes.map((n) => [n.id, n.name]));

  const monitor = nodes.find((n) => n.type === 'monitor');
  const { parent, children } = buildHierarchy(edges, monitor?.id);

  // Un nodo sin IP no se pinguea → nunca está en openDown → es "transparente" para la causa raíz.
  const transparent = new Set(nodes.filter((n) => !n.ip && n.type !== 'monitor').map((n) => n.id));
  const downRows = db.prepare("SELECT node_id FROM alerts WHERE type = 'node_down' AND resolved_at IS NULL AND node_id IS NOT NULL").all() as { node_id: number }[];
  return { name, parent, children, openDown: new Set(downRows.map((r) => r.node_id)), transparent };
}

/**
 * Deriva la jerarquía (padre = un salto más cerca del Monitor; hijos = más lejos) a partir
 * del grafo NO dirigido. Así la dependencia NO depende de cómo se dibujó la flecha del enlace:
 * si un nodo intermedio cae, todo lo que queda detrás (más lejos del Monitor) aparece caído.
 */
export function buildHierarchy(
  edges: { source_id: number; target_id: number }[],
  monitorId: number | undefined,
): { parent: Map<number, number>; children: Map<number, number[]> } {
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
  for (const e of edges) { link(e.source_id, e.target_id); link(e.target_id, e.source_id); }

  const dist = new Map<number, number>();
  if (monitorId !== undefined) {
    dist.set(monitorId, 0);
    const q = [monitorId];
    while (q.length) {
      const cur = q.shift()!;
      for (const nb of adj.get(cur) ?? []) if (!dist.has(nb)) { dist.set(nb, dist.get(cur)! + 1); q.push(nb); }
    }
  }

  const parent = new Map<number, number>();
  const children = new Map<number, number[]>();
  for (const [n, neighbors] of adj) {
    const dn = dist.get(n);
    if (dn === undefined) continue; // no conectado al Monitor: será su propia raíz
    for (const m of neighbors) {
      const dm = dist.get(m);
      if (dm === dn - 1 && !parent.has(n)) parent.set(n, m);
      else if (dm === dn + 1) (children.get(n) ?? children.set(n, []).get(n)!).push(m);
    }
  }
  return { parent, children };
}

/**
 * Sube por los padres devolviendo el nodo CAÍDO más cercano al Monitor del clúster.
 * Los nodos pasivos (transparent, sin IP) se atraviesan como si fueran cable: no rompen
 * el clúster ni cuentan como raíz. Así la caída de una OLT detrás de un NAP se agrupa bien.
 */
export function rootOf(n: number, topo: Topo): number {
  const transparent = topo.transparent ?? new Set<number>();
  let cur = n; let lastDown = n; const seen = new Set<number>([cur]);
  for (;;) {
    const p = topo.parent.get(cur);
    if (p === undefined || seen.has(p)) return lastDown;
    if (topo.openDown.has(p)) { cur = p; lastDown = p; seen.add(p); continue; }
    if (transparent.has(p)) { cur = p; seen.add(p); continue; } // atravesar el pasivo
    return lastDown;
  }
}
/** Descendientes CAÍDOS de `root` (atravesando pasivos transparentes). */
export function downstreamCasualties(root: number, topo: Topo): number[] {
  const transparent = topo.transparent ?? new Set<number>();
  const out: number[] = []; const stack = [...(topo.children.get(root) ?? [])]; const seen = new Set<number>();
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue; seen.add(n);
    if (topo.openDown.has(n)) { out.push(n); stack.push(...(topo.children.get(n) ?? [])); }
    else if (transparent.has(n)) { stack.push(...(topo.children.get(n) ?? [])); } // seguir a través del pasivo
  }
  return out;
}

async function flush(): Promise<void> {
  const items = queue; queue = []; timer = null;
  if (!items.length) return;
  const c = getTelegramConfig();
  const topo = loadTopo();

  for (const it of items) {
    if (it.kind === 'raised') {
      // Caídas: solo la raíz notifica; las consecuencias se suprimen.
      if (it.type === 'node_down' && it.nodeId !== null) {
        const root = rootOf(it.nodeId, topo);
        if (root !== it.nodeId) continue; // consecuencia de un nodo aguas arriba caído
        if (!shouldSend(it.nodeId, it.severity)) continue;
        const cas = downstreamCasualties(it.nodeId, topo);
        let text = formatAlertMessage(it);
        if (cas.length) {
          const names = cas.slice(0, 6).map((id) => topo.name.get(id) ?? `#${id}`).join(', ');
          text += `\n↳ arrastra ${cas.length} equipo(s) aguas abajo: ${names}${cas.length > 6 ? '…' : ''}`;
        }
        await sendTelegram(text, { chatId: routeChat(it.severity), buttons: buttonsFor(it.alertId, it.nodeId) });
        lastNotified.set(it.alertId, nowSec());
      } else {
        if (!shouldSend(it.nodeId, it.severity)) continue;
        await sendTelegram(formatAlertMessage(it), { chatId: routeChat(it.severity), buttons: buttonsFor(it.alertId, it.nodeId) });
        lastNotified.set(it.alertId, nowSec());
      }
    } else {
      if (!c.notifyResolved) continue;
      // Resuelto: para node_down, solo si era una raíz (su padre no está caído).
      if (it.type === 'node_down' && it.nodeId !== null) {
        const p = topo.parent.get(it.nodeId);
        if (p !== undefined && topo.openDown.has(p)) continue;
      }
      if (isMuted(it.nodeId)) continue;
      if (isQuietNow() && !isWatched(it.nodeId)) continue; // resuelto = informativo, se calla en silencioso
      await sendTelegram(formatResolvedMessage(it.message, it.minutesOpen), { chatId: c.chatId });
    }
  }
}

/**
 * Recordatorio: re-avisa por Telegram las alertas CRÍTICAS que siguen abiertas
 * cada `reminderMinutes`. Así una caída persistente (ej. un PTP a una montaña que
 * quedó caído) sigue recordándote en vez de avisar una sola vez. Lo llama el scheduler.
 */
export function remindOpenCritical(): void {
  const c = getTelegramConfig();
  if (!c.enabled || !c.botToken || !c.chatId || !c.reminderMinutes) return;
  const now = nowSec();
  const cutoff = now - c.reminderMinutes * 60;
  const rows = db
    .prepare("SELECT id, message, node_id, created_at FROM alerts WHERE resolved_at IS NULL AND severity = 'critical'")
    .all() as { id: number; message: string; node_id: number | null; created_at: number }[];
  for (const r of rows) {
    if (isMuted(r.node_id)) continue;
    // Si nunca lo mandamos en esta ejecución, usa la fecha de creación como referencia.
    const last = lastNotified.get(r.id) ?? r.created_at;
    if (last > cutoff) continue;
    const mins = Math.max(1, Math.round((now - r.created_at) / 60));
    void sendTelegram(`⏰ *Sigue abierta* (${mins} min)\n${r.message}`, { chatId: routeChat('critical'), buttons: buttonsFor(r.id, r.node_id) });
    lastNotified.set(r.id, now);
  }
}

export { severityIcon };
