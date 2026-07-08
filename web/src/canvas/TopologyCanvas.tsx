import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap,
  type Node as FlowNode, type Edge as FlowEdge, type Connection, type NodeChange,
} from '@xyflow/react';
import type { Node as RFNode, Edge as RFEdge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { DeviceNode, type DeviceFlowNode } from './DeviceNode';
import { GroupNode, type GroupFlowNode, type GroupMember } from './GroupNode';
import { FlowEdge as FlowEdgeComponent } from './FlowEdge';
import type { ApiNode, ApiEdge, LiveNode, NodeType } from '../types';
import { NODE_TYPE_LABELS, ADDABLE_TYPES, INSERTABLE_TYPES, CONTAINER_TYPES, nodesForInsert } from '../types';
import { api } from '../api';
import { Icon, ICONS, TYPE_META } from '../ui/meta';

const nodeTypes = { device: DeviceNode, group: GroupNode };
const edgeTypes = { flow: FlowEdgeComponent };

const STATUS_RANK = { down: 3, warning: 2, unknown: 1, up: 0 } as const;
type Health = 'down' | 'warning' | 'up' | 'unknown';
const asHealth = (s?: string): Health => (s === 'down' || s === 'warning' || s === 'up' ? s : 'unknown');

const STATUS_HEX: Record<string, string> = {
  up: '#33cc7a', warning: '#f5b13d', down: '#f0556b', unknown: '#6b788f',
};

interface Props {
  nodes: ApiNode[];
  edges: ApiEdge[];
  live: Record<number, LiveNode>;
  theme: 'dark' | 'light';
  selectedNodeId: number | null;
  selectedEdgeId: number | null;
  onSelectNode: (id: number | null) => void;
  onSelectEdge: (id: number | null) => void;
  onTopologyChanged: () => void;
  onHelp: () => void;
  /** Abrir un rack/torre en la vista física «Rack y Torre». */
  onOpenContainer?: (id: number) => void;
}

export function TopologyCanvas({
  nodes, edges, live, theme, selectedNodeId, selectedEdgeId,
  onSelectNode, onSelectEdge, onTopologyChanged, onHelp, onOpenContainer,
}: Props) {
  const [connecting, setConnecting] = useState(false);
  const [insertMenu, setInsertMenu] = useState<{ edgeId: number; x: number; y: number } | null>(null);
  // Dimensiones medidas por React Flow. Como controlamos `nodes` nosotros, hay que
  // reinyectar `measured` en cada nodo o el MINIMAPA no dibuja nada (usa node.measured).
  const [dimsTick, setDimsTick] = useState(0);
  const dimsRef = useRef(new Map<string, { width: number; height: number }>());
  // Contenedores (rack/torre) colapsados: se muestra solo la cabecera con el nº de equipos.
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const toggleCollapse = useCallback((id: number) => {
    setCollapsed((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }, []);

  const openInsertMenu = useCallback((edgeId: string, x: number, y: number) => {
    setInsertMenu({ edgeId: parseInt(edgeId, 10), x, y });
  }, []);

  // --- pertenencia a contenedores: los miembros no se dibujan sueltos; el rack/torre ---
  // --- se dibuja como tarjeta de grupo y los enlaces se re-mapean a su contenedor. ---
  const { containerOf, statusOf } = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const isContainer = (id: number) => { const t = byId.get(id)?.type; return t != null && (CONTAINER_TYPES as NodeType[]).includes(t); };
    const containerOf = new Map<number, number>();
    for (const n of nodes) {
      if (n.containerId != null && isContainer(n.containerId)) containerOf.set(n.id, n.containerId);
    }
    // Estado en vivo de un nodo (el monitor siempre "up").
    const rawStatus = (n: ApiNode): Health => (n.type === 'monitor' ? 'up' : asHealth(live[n.id]?.status));
    const statusOf = (id: number): Health => { const n = byId.get(id); return n ? rawStatus(n) : 'unknown'; };
    return { containerOf, statusOf };
  }, [nodes, live]);

  // Peor estado de los miembros de cada contenedor (para el dot del grupo).
  const worstByContainer = useMemo(() => {
    const worst = new Map<number, Health>();
    for (const n of nodes) {
      const cid = containerOf.get(n.id);
      if (cid == null) continue;
      let s = statusOf(n.id);
      if (s !== 'down' && live[n.id]?.bwNear) s = 'warning';
      const cur = worst.get(cid) ?? 'unknown';
      if (STATUS_RANK[s] >= STATUS_RANK[cur]) worst.set(cid, s);
    }
    return worst;
  }, [nodes, containerOf, statusOf, live]);

  const flowNodes: (DeviceFlowNode | GroupFlowNode)[] = useMemo(() => {
    const out: (DeviceFlowNode | GroupFlowNode)[] = [];
    for (const n of nodes) {
      const isContainer = (CONTAINER_TYPES as NodeType[]).includes(n.type);
      if (isContainer) {
        const members: GroupMember[] = nodes
          .filter((m) => containerOf.get(m.id) === n.id)
          .map((m) => ({ node: m, live: live[m.id] ?? null }));
        out.push({
          id: String(n.id), type: 'group', position: { x: n.posX, y: n.posY },
          selected: n.id === selectedNodeId, deletable: true, measured: dimsRef.current.get(String(n.id)),
          data: { container: n, members, worst: worstByContainer.get(n.id) ?? 'unknown', collapsed: collapsed.has(n.id), onOpen: (id) => (onOpenContainer ? onOpenContainer(id) : onSelectNode(id)), onSelectMember: (id) => onSelectNode(id), onToggleCollapse: toggleCollapse },
        });
      } else if (!containerOf.has(n.id)) {
        // Nodo suelto (los miembros de un contenedor se dibujan dentro de la tarjeta).
        out.push({
          id: String(n.id), type: 'device', position: { x: n.posX, y: n.posY },
          selected: n.id === selectedNodeId, deletable: n.type !== 'monitor', measured: dimsRef.current.get(String(n.id)),
          data: { node: n, live: live[n.id] ?? null },
        });
      }
    }
    return out;
    // dimsTick fuerza recompute cuando llegan las dimensiones medidas (para el minimapa).
  }, [nodes, live, selectedNodeId, containerOf, worstByContainer, onOpenContainer, onSelectNode, toggleCollapse, collapsed, dimsTick]);

  const flowEdges: FlowEdge[] = useMemo(() => {
    // Extremo dibujado: si el nodo está en un contenedor, el enlace va a la tarjeta del contenedor.
    const rendered = (id: number) => containerOf.get(id) ?? id;
    // Estado efectivo del extremo dibujado (contenedor = peor de sus miembros).
    const effStatus = (renderedId: number): Health =>
      (CONTAINER_TYPES as NodeType[]).includes(nodes.find((n) => n.id === renderedId)?.type as NodeType)
        ? worstByContainer.get(renderedId) ?? 'unknown'
        : statusOf(renderedId);
    const seen = new Set<string>();
    const out: FlowEdge[] = [];
    for (const e of edges) {
      const ra = rendered(e.source_id), rb = rendered(e.target_id);
      if (ra === rb) continue; // enlace interno de un contenedor → oculto en la tarjeta
      const key = ra < rb ? `${ra}-${rb}` : `${rb}-${ra}`;
      if (seen.has(key)) continue; // deduplicar líneas entre las mismas dos tarjetas/nodos
      seen.add(key);
      const a = effStatus(ra), b = effStatus(rb);
      let health: Health = STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
      if (health !== 'down' && (live[e.target_id]?.bwNear || live[e.source_id]?.bwNear)) health = 'warning';
      out.push({
        id: String(e.id), source: String(ra), target: String(rb), type: 'flow' as const,
        selected: e.id === selectedEdgeId,
        data: {
          label: e.label || (e.capacity_mbps ? `${e.capacity_mbps} Mbps` : undefined),
          health, onInsert: openInsertMenu,
        },
      });
    }
    return out;
  }, [edges, nodes, live, selectedEdgeId, openInsertMenu, containerOf, worstByContainer, statusOf]);

  const doInsert = useCallback(
    (type: NodeType) => {
      if (!insertMenu) return;
      const edgeId = insertMenu.edgeId;
      setInsertMenu(null);
      void api.splitEdge(edgeId, nodesForInsert(type)).then((res) => {
        onTopologyChanged();
        if (res.nodes[0]) onSelectNode(res.nodes[0].id);
      });
    },
    [insertMenu, onTopologyChanged, onSelectNode],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      let dimsChanged = false;
      for (const ch of changes) {
        if (ch.type === 'position' && !ch.dragging && ch.position) {
          void api
            .updateNode(parseInt(ch.id, 10), { posX: ch.position.x, posY: ch.position.y })
            .then(onTopologyChanged);
        } else if (ch.type === 'dimensions' && ch.dimensions) {
          // Guardar el tamaño medido para reinyectarlo (necesario para el minimapa).
          const prev = dimsRef.current.get(ch.id);
          if (!prev || prev.width !== ch.dimensions.width || prev.height !== ch.dimensions.height) {
            dimsRef.current.set(ch.id, { width: ch.dimensions.width, height: ch.dimensions.height });
            dimsChanged = true;
          }
        }
      }
      if (dimsChanged) setDimsTick((t) => t + 1);
    },
    [onTopologyChanged],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      // Un handle "m-<id>" en una tarjeta de grupo apunta a un equipo interno concreto
      // (la antena, no el contenedor). Sin handle → el nodo/contenedor como un todo.
      const resolve = (nodeId: string, handleId: string | null | undefined): number => {
        const m = handleId && /^m-(\d+)$/.exec(handleId);
        return m ? parseInt(m[1], 10) : parseInt(nodeId, 10);
      };
      const sourceId = resolve(conn.source, conn.sourceHandle);
      const targetId = resolve(conn.target, conn.targetHandle);
      if (!sourceId || !targetId || sourceId === targetId) return;
      void api
        .createEdge({ sourceId, targetId })
        .then((e) => {
          onTopologyChanged();
          onSelectEdge(e.id);
        });
    },
    [onTopologyChanged, onSelectEdge],
  );

  const onNodesDelete = useCallback(
    (deleted: RFNode[]) => {
      const ids = deleted
        .map((n) => parseInt(n.id, 10))
        .filter((id) => nodes.find((x) => x.id === id)?.type !== 'monitor');
      if (ids.length === 0) return onTopologyChanged();
      Promise.all(ids.map((id) => api.deleteNode(id)))
        .then(() => { onSelectNode(null); onTopologyChanged(); })
        .catch(() => onTopologyChanged());
    },
    [nodes, onSelectNode, onTopologyChanged],
  );

  const onEdgesDelete = useCallback(
    (deleted: RFEdge[]) => {
      Promise.all(deleted.map((e) => api.deleteEdge(parseInt(e.id, 10))))
        .then(() => { onSelectEdge(null); onTopologyChanged(); })
        .catch(() => onTopologyChanged());
    },
    [onSelectEdge, onTopologyChanged],
  );

  const addNode = useCallback(
    (type: NodeType) => {
      void api
        .createNode({
          type,
          name: NODE_TYPE_LABELS[type],
          posX: 160 + Math.random() * 320,
          posY: 120 + Math.random() * 260,
        })
        .then((n) => { onTopologyChanged(); onSelectNode(n.id); });
    },
    [onTopologyChanged, onSelectNode],
  );

  return (
    <div className="topo-wrap">
      <div className="palette">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="palette-title">Paleta</div>
          <button className="help-dot" style={{ width: 16, height: 16, fontSize: 10 }} onClick={onHelp}>!</button>
        </div>
        {ADDABLE_TYPES.map((t) => {
          const meta = TYPE_META[t];
          return (
            <button key={t} className="palette-btn" title={`Añadir ${meta.label}`} onClick={() => addNode(t)}>
              <span className="palette-ico" style={{ color: meta.color }}>
                <Icon path={ICONS[meta.icon]} size={15} strokeWidth={1.9} />
              </span>
              <span style={{ lineHeight: 1.1 }}>{NODE_TYPE_LABELS[t]}</span>
            </button>
          );
        })}
        <div style={{ marginTop: 6, fontSize: 10, color: 'var(--muted)', lineHeight: 1.5, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          Arrastra un nodo para moverlo. Tira del punto azul para crear un enlace. Suprimir = eliminar.
        </div>
      </div>

      <div className="canvas-host">
        <ReactFlow
          nodes={flowNodes as FlowNode[]}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onNodesDelete={onNodesDelete}
          onEdgesDelete={onEdgesDelete}
          deleteKeyCode={['Delete', 'Backspace']}
          onConnect={onConnect}
          onConnectStart={() => setConnecting(true)}
          onConnectEnd={() => setConnecting(false)}
          onNodeClick={(_, node) => onSelectNode(parseInt(node.id, 10))}
          onEdgeClick={(_, edge) => onSelectEdge(parseInt(edge.id, 10))}
          onPaneClick={() => { onSelectNode(null); onSelectEdge(null); }}
          fitView
          colorMode={theme}
          connectionRadius={40}
          proOptions={{ hideAttribution: true }}
          className={connecting ? 'is-connecting' : ''}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable zoomable
            maskColor={theme === 'dark' ? 'rgba(10,14,22,0.6)' : 'rgba(200,209,224,0.5)'}
            nodeColor={(n) => {
              const nd = n.data as { live?: LiveNode; node?: ApiNode; worst?: string };
              if (nd.worst) return STATUS_HEX[nd.worst] ?? STATUS_HEX.unknown; // tarjeta de grupo
              if (nd.node?.type === 'monitor') return STATUS_HEX.up;
              return STATUS_HEX[nd.live?.status ?? 'unknown'];
            }}
          />
        </ReactFlow>

        {nodes.length === 0 && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, pointerEvents: 'none', color: 'var(--muted)' }}>
            <div style={{ fontSize: 34 }}>🗺️</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>Dibuja tu red</div>
            <div style={{ fontSize: 12, maxWidth: 280, textAlign: 'center' }}>Añade tu primer equipo desde la paleta y conéctalo al PC de monitoreo.</div>
          </div>
        )}
      </div>

      {insertMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setInsertMenu(null)} />
          <div
            className="insert-pop"
            style={{
              left: Math.min(insertMenu.x, window.innerWidth - 210),
              top: Math.min(insertMenu.y, window.innerHeight - 320),
            }}
          >
            <div className="palette-title" style={{ padding: '4px 8px' }}>Insertar aquí</div>
            {INSERTABLE_TYPES.map((t) => {
              const meta = TYPE_META[t];
              return (
                <button key={t} onClick={() => doInsert(t)}>
                  <span className="palette-ico" style={{ width: 22, height: 22, color: meta.color }}>
                    <Icon path={ICONS[meta.icon]} size={13} strokeWidth={1.9} />
                  </span>
                  {NODE_TYPE_LABELS[t]}
                  {t === 'ptp-mimosa' && <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--muted)' }}>2 antenas</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
