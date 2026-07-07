import { useCallback, useMemo, useState } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap,
  type Node as FlowNode, type Edge as FlowEdge, type Connection, type NodeChange,
} from '@xyflow/react';
import type { Node as RFNode, Edge as RFEdge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { DeviceNode, type DeviceFlowNode } from './DeviceNode';
import { FlowEdge as FlowEdgeComponent } from './FlowEdge';
import type { ApiNode, ApiEdge, LiveNode, NodeType } from '../types';
import { NODE_TYPE_LABELS, ADDABLE_TYPES, nodesForInsert } from '../types';
import { api } from '../api';
import { Icon, ICONS, TYPE_META } from '../ui/meta';

const nodeTypes = { device: DeviceNode };
const edgeTypes = { flow: FlowEdgeComponent };

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
}

export function TopologyCanvas({
  nodes, edges, live, theme, selectedNodeId, selectedEdgeId,
  onSelectNode, onSelectEdge, onTopologyChanged, onHelp,
}: Props) {
  const [connecting, setConnecting] = useState(false);
  const [insertMenu, setInsertMenu] = useState<{ edgeId: number; x: number; y: number } | null>(null);

  const openInsertMenu = useCallback((edgeId: string, x: number, y: number) => {
    setInsertMenu({ edgeId: parseInt(edgeId, 10), x, y });
  }, []);

  const flowNodes: DeviceFlowNode[] = useMemo(
    () =>
      nodes.map((n) => ({
        id: String(n.id),
        type: 'device' as const,
        position: { x: n.posX, y: n.posY },
        selected: n.id === selectedNodeId,
        deletable: n.type !== 'monitor',
        data: { node: n, live: live[n.id] ?? null },
      })),
    [nodes, live, selectedNodeId],
  );

  const flowEdges: FlowEdge[] = useMemo(
    () =>
      edges.map((e) => {
        // Color por el PEOR de los dos extremos (independiente de la dirección del enlace).
        const rank = { down: 3, warning: 2, unknown: 1, up: 0 } as const;
        const st = (s?: string) => (s === 'down' || s === 'warning' || s === 'up' ? s : 'unknown') as 'down' | 'warning' | 'up' | 'unknown';
        const a = st(live[e.source_id]?.status), b = st(live[e.target_id]?.status);
        let health: 'down' | 'warning' | 'up' | 'unknown' = rank[a] >= rank[b] ? a : b;
        // Si un extremo está cerca del techo de ancho de banda, el enlace se pinta naranja.
        if (health !== 'down' && (live[e.target_id]?.bwNear || live[e.source_id]?.bwNear)) health = 'warning';
        return {
          id: String(e.id),
          source: String(e.source_id),
          target: String(e.target_id),
          type: 'flow' as const,
          selected: e.id === selectedEdgeId,
          data: {
            label: e.label || (e.capacity_mbps ? `${e.capacity_mbps} Mbps` : undefined),
            health,
            onInsert: openInsertMenu,
          },
        };
      }),
    [edges, live, selectedEdgeId, openInsertMenu],
  );

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
      for (const ch of changes) {
        if (ch.type === 'position' && !ch.dragging && ch.position) {
          void api
            .updateNode(parseInt(ch.id, 10), { posX: ch.position.x, posY: ch.position.y })
            .then(onTopologyChanged);
        }
      }
    },
    [onTopologyChanged],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return;
      void api
        .createEdge({ sourceId: parseInt(conn.source, 10), targetId: parseInt(conn.target, 10) })
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
              const nd = n.data as { live?: LiveNode; node?: ApiNode };
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
            {ADDABLE_TYPES.map((t) => {
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
