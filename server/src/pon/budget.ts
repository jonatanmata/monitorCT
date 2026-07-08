/**
 * Cálculo de presupuesto óptico PON (potencia estimada recibida en cada ONU).
 * Recorre el grafo desde la ONU hasta la OLT por el camino más corto y resta las
 * pérdidas: potencia del puerto OLT − conectores − fibra (dB/km × longitud) −
 * splitters de cada NAP atravesado. Función pura y determinista → testeable.
 */

export const CONNECTOR_LOSS_DB = 0.5;    // por conector/empalme mecánico
export const DEFAULT_DB_PER_KM = 0.35;   // atenuación típica fibra 1310/1550 nm
export const DEFAULT_OLT_TX_DBM = 3;     // potencia de puerto GPON por defecto (clase B+ ~ +1.5..+5)

/** Pérdida por inserción de un splitter según su ratio (1:N). */
export const SPLITTER_LOSS_DB: Record<number, number> = {
  2: 3.7, 4: 7.3, 8: 10.5, 16: 13.7, 32: 17.1, 64: 20.5,
};

export interface PonNode { id: number; type: string; name: string; meta: unknown }
export interface FiberInfo { lengthM?: number; dbPerKm?: number; connectors?: number; oltPort?: string }
export interface PonEdge { source_id: number; target_id: number; fiber: FiberInfo | null }
export interface PonHop { node: string; kind: 'olt' | 'fiber' | 'splitter' | 'onu'; detail: string; lossDb: number }
export interface PonBudget {
  supported: boolean;
  note?: string;
  txDbm: number | null;      // potencia del puerto OLT
  rxDbm: number | null;      // potencia estimada recibida en la ONU
  totalLossDb: number;
  hops: PonHop[];
  warnings: string[];
  path: number[];            // ids de nodos OLT→…→ONU
}

function splitterLoss(ratio: number): number {
  if (SPLITTER_LOSS_DB[ratio] != null) return SPLITTER_LOSS_DB[ratio];
  // Aproximación log2 si el ratio no es estándar: ~3.5 dB por etapa 1:2 + exceso.
  return Math.round((3.4 * Math.log2(Math.max(2, ratio)) + 0.5) * 10) / 10;
}

export function computePonBudget(nodes: PonNode[], edges: PonEdge[], onuId: number): PonBudget {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const onu = byId.get(onuId);
  const empty: PonBudget = { supported: false, txDbm: null, rxDbm: null, totalLossDb: 0, hops: [], warnings: [], path: [] };
  if (!onu) return { ...empty, note: 'ONU no encontrada' };
  if (onu.type !== 'onu') return { ...empty, note: 'El nodo no es una ONU' };

  // Adyacencia no dirigida con referencia a la arista.
  const adj = new Map<number, { to: number; edge: PonEdge }[]>();
  const link = (a: number, b: number, e: PonEdge) => (adj.get(a) ?? adj.set(a, []).get(a)!).push({ to: b, edge: e });
  for (const e of edges) { link(e.source_id, e.target_id, e); link(e.target_id, e.source_id, e); }

  // BFS ONU → OLT más cercana, guardando de dónde vino cada nodo.
  const prev = new Map<number, { from: number; edge: PonEdge }>();
  const q = [onuId]; const visited = new Set([onuId]); let oltId: number | null = null;
  while (q.length) {
    const cur = q.shift()!;
    if (byId.get(cur)?.type === 'olt' && cur !== onuId) { oltId = cur; break; }
    for (const { to, edge } of adj.get(cur) ?? []) {
      if (visited.has(to)) continue;
      visited.add(to); prev.set(to, { from: cur, edge }); q.push(to);
    }
  }
  const warnings: string[] = [];
  const oltCount = nodes.filter((n) => n.type === 'olt').length;
  if (oltCount > 1) warnings.push('Hay más de una OLT en la red; se usó la más cercana por el camino.');
  if (oltId == null) return { ...empty, warnings, note: 'No hay una OLT conectada a esta ONU (revisa los enlaces de fibra).' };

  // Reconstruir el camino OLT → ONU. `rev` = [olt, …, onu]; `revEdges[i]` une rev[i] y rev[i+1].
  const rev: number[] = []; const revEdges: PonEdge[] = [];
  let n: number | undefined = oltId;
  while (n !== undefined && n !== onuId) { const p = prev.get(n); if (!p) break; rev.push(n); revEdges.push(p.edge); n = p.from; }
  rev.push(onuId);
  const pathNodes = rev;

  const hops: PonHop[] = [];
  // Potencia del puerto OLT (la arista adyacente al OLT trae fiber.oltPort).
  const oltNode = byId.get(oltId)!;
  const oltMeta = (oltNode.meta ?? {}) as { ports?: { name: string; txDbm: number }[] };
  const firstEdge = revEdges[0]; // arista entre olt y su vecino en el camino
  const portName = firstEdge?.fiber?.oltPort;
  let txDbm = DEFAULT_OLT_TX_DBM;
  const port = oltMeta.ports?.find((p) => p.name === portName);
  if (port) txDbm = port.txDbm;
  else if (portName) warnings.push(`El puerto "${portName}" no existe en la OLT; se usó ${DEFAULT_OLT_TX_DBM} dBm por defecto.`);
  else warnings.push(`El enlace desde la OLT no tiene puerto asignado; se usó ${DEFAULT_OLT_TX_DBM} dBm por defecto.`);
  hops.push({ node: oltNode.name, kind: 'olt', detail: port ? `puerto ${port.name}` : 'puerto por defecto', lossDb: 0 });

  let total = 0;
  // Recorrer OLT→ONU: por cada tramo, pérdida de fibra + conectores; por cada NAP, splitter.
  for (let i = 0; i < pathNodes.length - 1; i++) {
    const a = pathNodes[i], b = pathNodes[i + 1];
    // arista entre a y b (rev y revEdges están alineados: revEdges[i] une pathNodes[i] y [i+1])
    const e = revEdges[i];
    const f = e?.fiber ?? {};
    const lengthKm = (f.lengthM ?? 0) / 1000;
    const dbPerKm = f.dbPerKm ?? DEFAULT_DB_PER_KM;
    const connectors = f.connectors ?? 0;
    const fiberLoss = Math.round((lengthKm * dbPerKm + connectors * CONNECTOR_LOSS_DB) * 100) / 100;
    if (fiberLoss > 0 || f.lengthM) {
      total += fiberLoss;
      hops.push({ node: `${byId.get(a)?.name} → ${byId.get(b)?.name}`, kind: 'fiber', detail: `${f.lengthM ?? 0} m · ${connectors} conector(es)`, lossDb: fiberLoss });
    }
    // pérdida del nodo destino si es un NAP con splitter
    const bn = byId.get(b);
    if (bn?.type === 'nap') {
      const ratio = ((bn.meta ?? {}) as { splitRatio?: number }).splitRatio ?? 0;
      if (ratio >= 2) { const l = splitterLoss(ratio); total += l; hops.push({ node: bn.name, kind: 'splitter', detail: `splitter 1:${ratio}`, lossDb: l }); }
      else warnings.push(`El NAP "${bn.name}" no tiene ratio de splitter configurado.`);
    }
  }

  const rxDbm = Math.round((txDbm - total) * 100) / 100;
  hops.push({ node: onu.name, kind: 'onu', detail: `${rxDbm} dBm estimados`, lossDb: 0 });
  return { supported: true, txDbm, rxDbm, totalLossDb: Math.round(total * 100) / 100, hops, warnings, path: pathNodes };
}
