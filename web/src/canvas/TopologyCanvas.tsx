import { useCallback, useMemo, useState } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap,
  type Node as FlowNode, type Edge as FlowEdge, type Connection, type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { DeviceNode, type DeviceFlowNode } from './DeviceNode';
import { FlowEdge as FlowEdgeComponent } from './FlowEdge';
import type { ApiNode, ApiEdge, LiveNode, NodeType } from '../types';
import { NODE_TYPE_LABELS, NODE_TYPE_ICONS } from '../types';
import { api } from '../api';
import { InfoTip } from '../components/InfoTip';

const nodeTypes = { device: DeviceNode };
const edgeTypes = { flow: FlowEdgeComponent };

const STATUS_COLOR: Record<string, string> = {
  up: '#10b981', warning: '#f59e0b', down: '#f43f5e', unknown: '#5d6980',
};

interface Props {
  nodes: ApiNode[];
  edges: ApiEdge[];
  live: Record<number, LiveNode>;
  selectedNodeId: number | null;
  selectedEdgeId: number | null;
  onSelectNode: (id: number | null) => void;
  onSelectEdge: (id: number | null) => void;
  onTopologyChanged: () => void;
}

export function TopologyCanvas({
  nodes, edges, live, selectedNodeId, selectedEdgeId,
  onSelectNode, onSelectEdge, onTopologyChanged,
}: Props) {
  const [connecting, setConnecting] = useState(false);

  const flowNodes: DeviceFlowNode[] = useMemo(
    () =>
      nodes.map((n) => ({
        id: String(n.id),
        type: 'device' as const,
        position: { x: n.posX, y: n.posY },
        selected: n.id === selectedNodeId,
        data: { node: n, live: live[n.id] ?? null },
      })),
    [nodes, live, selectedNodeId],
  );

  const flowEdges: FlowEdge[] = useMemo(
    () =>
      edges.map((e) => {
        // La salud del enlace se deriva del estado del nodo destino (aguas abajo)
        const health = live[e.target_id]?.status ?? 'unknown';
        return {
          id: String(e.id),
          source: String(e.source_id),
          target: String(e.target_id),
          type: 'flow' as const,
          selected: e.id === selectedEdgeId,
          data: {
            label: e.label || (e.capacity_mbps ? `${e.capacity_mbps} Mbps` : undefined),
            health,
          },
        };
      }),
    [edges, live, selectedEdgeId],
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
          onSelectEdge(e.id); // abre el panel del enlace recién creado para poner capacidad
        });
    },
    [onTopologyChanged, onSelectEdge],
  );

  const addNode = useCallback(
    (type: NodeType) => {
      void api
        .createNode({
          type,
          name: NODE_TYPE_LABELS[type],
          posX: 140 + Math.random() * 320,
          posY: 120 + Math.random() * 260,
        })
        .then((n) => {
          onTopologyChanged();
          onSelectNode(n.id);
        });
    },
    [onTopologyChanged, onSelectNode],
  );

  return (
    <div className="canvas-wrap">
      <div className="palette">
        <div className="small" style={{ padding: '0 4px 4px', display: 'flex', alignItems: 'center' }}>
          Añadir equipo
          <InfoTip text="Este es el mapa de tu red. Añade cada equipo con estos botones y conéctalos ARRASTRANDO desde el punto azul del borde derecho de un nodo hasta el borde izquierdo del siguiente, siguiendo el camino de la señal (Gateway → MikroTik → PTP → MikroTik → AP → Cliente). Los puntos de conexión aparecen al pasar el mouse sobre un equipo. El color de cada línea muestra la salud del enlace y el punto que viaja indica el sentido del tráfico." />
        </div>
        {(Object.keys(NODE_TYPE_LABELS) as NodeType[]).map((t) => (
          <button key={t} onClick={() => addNode(t)}>
            <span className="palette-icon">{NODE_TYPE_ICONS[t]}</span> {NODE_TYPE_LABELS[t]}
          </button>
        ))}
      </div>

      {nodes.length === 0 && (
        <div className="canvas-welcome">
          <div className="cw-icon">🗺️</div>
          <h2>Dibuja tu red</h2>
          <p>Usa la paleta de la izquierda para añadir tu primer equipo y empieza a construir la topología.</p>
        </div>
      )}

      <ReactFlow
        nodes={flowNodes as FlowNode[]}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onConnectStart={() => setConnecting(true)}
        onConnectEnd={() => setConnecting(false)}
        onNodeClick={(_, node) => onSelectNode(parseInt(node.id, 10))}
        onEdgeClick={(_, edge) => onSelectEdge(parseInt(edge.id, 10))}
        onPaneClick={() => {
          onSelectNode(null);
          onSelectEdge(null);
        }}
        fitView
        colorMode="dark"
        connectionRadius={40}
        proOptions={{ hideAttribution: true }}
        className={connecting ? 'is-connecting' : ''}
      >
        <Background variant={BackgroundVariant.Dots} color="#253048" gap={22} size={1.5} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable zoomable
          style={{ background: '#121826' }}
          maskColor="rgba(11, 15, 23, 0.6)"
          nodeColor={(n) => {
            const live_ = (n.data as { live?: LiveNode }).live;
            return STATUS_COLOR[live_?.status ?? 'unknown'];
          }}
        />
      </ReactFlow>
    </div>
  );
}
