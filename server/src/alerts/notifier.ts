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

export interface Topo { name: Map<number, string>; parent: Map<number, number>; children: Map<number, number[]>; openDown: Set<number> }
function loadTopo(): Topo {
  const nodes = db.prepare('SELECT id, name FROM nodes').all() as { id: number; name: string }[];
  const edges = db.prepare('SELECT source_id, target_id FROM edges').all() as { source_id: number; target_id: number }[];
  const name = new Map(nodes.map((n) => [n.id, n.name]));
  const parent = new Map<number, number>();
  const children = new Map<number, number[]>();
  for (const e of edges) {
    parent.set(e.target_id, e.source_id);
    (children.get(e.source_id) ?? children.set(e.source_id, []).get(e.source_id)!).push(e.target_id);
  }
  const downRows = db.prepare("SELECT node_id FROM alerts WHERE type = 'node_down' AND resolved_at IS NULL AND node_id IS NOT NULL").all() as { node_id: number }[];
  return { name, parent, children, openDown: new Set(downRows.map((r) => r.node_id)) };
}

/** Sube por los padres mientras sigan caídos; devuelve el nodo raíz de la caída. */
export function rootOf(n: number, topo: Topo): number {
  let cur = n; const seen = new Set<number>([cur]);
  for (;;) {
    const p = topo.parent.get(cur);
    if (p === undefined || !topo.openDown.has(p) || seen.has(p)) return cur;
    cur = p; seen.add(p);
  }
}
/** Descendientes de `root` que también están caídos (equipos arrastrados). */
export function downstreamCasualties(root: number, topo: Topo): number[] {
  const out: number[] = []; const stack = [...(topo.children.get(root) ?? [])]; const seen = new Set<number>();
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue; seen.add(n);
    if (topo.openDown.has(n)) { out.push(n); stack.push(...(topo.children.get(n) ?? [])); }
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
      } else {
        if (!shouldSend(it.nodeId, it.severity)) continue;
        await sendTelegram(formatAlertMessage(it), { chatId: routeChat(it.severity), buttons: buttonsFor(it.alertId, it.nodeId) });
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

export { severityIcon };
