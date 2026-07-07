/**
 * Estado en vivo compartido: último estado conocido de cada nodo y
 * difusión de eventos a los clientes WebSocket conectados.
 */

export type NodeStatus = 'up' | 'warning' | 'down' | 'unknown';

export interface LiveNode {
  status: NodeStatus;
  latencyMs: number | null;
  lossPct: number | null;
  lastSeen: number | null;
  /** Últimas métricas clave para mostrar en el lienzo (cpu_pct, signal_dbm, etc.) */
  summary: Record<string, number>;
  /** Mayor % de utilización de un enlace con capacidad que toca este nodo. */
  bwPct?: number;
  /** true cuando ese % supera el umbral "cerca del techo" (resalta la antena en naranja). */
  bwNear?: boolean;
}

const liveNodes = new Map<number, LiveNode>();

export function getLiveNode(nodeId: number): LiveNode {
  let n = liveNodes.get(nodeId);
  if (!n) {
    n = { status: 'unknown', latencyMs: null, lossPct: null, lastSeen: null, summary: {} };
    liveNodes.set(nodeId, n);
  }
  return n;
}

export function allLiveNodes(): Record<number, LiveNode> {
  return Object.fromEntries(liveNodes.entries());
}

export function dropLiveNode(nodeId: number): void {
  liveNodes.delete(nodeId);
}

type Broadcast = (event: string, data: unknown) => void;
let broadcastFn: Broadcast = () => {};

export function setBroadcast(fn: Broadcast): void {
  broadcastFn = fn;
}

export function broadcast(event: string, data: unknown): void {
  broadcastFn(event, data);
}
