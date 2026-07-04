import { useCallback, useMemo } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap,
  type Node as FlowNode, type Edge as FlowEdge, type Connection, type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { DeviceNode, type DeviceFlowNode } from './DeviceNode';
import type { ApiNode, ApiEdge, LiveNode, NodeType } from '../types';
import { NODE_TYPE_LABELS, NODE_TYPE_ICONS } from '../types';
import { api } from '../api';
import { InfoTip } from '../components/InfoTip';

const nodeTypes = { device: DeviceNode };

interface Props {
  nodes: ApiNode[];
  edges: ApiEdge[];
  live: Record<number, LiveNode>;
  onSelectNode: (id: number | null) => void;
  onSelectEdge: (id: number | null) => void;
  onTopologyChanged: () => void;
}

export function TopologyCanvas({ nodes, edges, live, onSelectNode, onSelectEdge, onTopologyChanged }: Props) {
  const flowNodes: DeviceFlowNode[] = useMemo(
    () =>
      nodes.map((n) => ({
        id: String(n.id),
        type: 'device' as const,
        position: { x: n.posX, y: n.posY },
        data: { node: n, live: live[n.id] ?? null },
      })),
    [nodes, live],
  );

  const flowEdges: FlowEdge[] = useMemo(
    () =>
      edges.map((e) => ({
        id: String(e.id),
        source: String(e.source_id),
        target: String(e.target_id),
        label: e.label || (e.capacity_mbps ? `${e.capacity_mbps} Mbps` : undefined),
        animated: true,
        style: { stroke: '#475569' },
        labelStyle: { fill: '#94a3b8', fontSize: 10 },
        labelBgStyle: { fill: '#0f1420' },
      })),
    [edges],
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
        .then(onTopologyChanged);
    },
    [onTopologyChanged],
  );

  const addNode = useCallback(
    (type: NodeType) => {
      void api
        .createNode({
          type,
          name: NODE_TYPE_LABELS[type],
          posX: 120 + Math.random() * 300,
          posY: 100 + Math.random() * 250,
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
        <div className="small" style={{ padding: '0 4px 4px' }}>
          Añadir equipo:
          <InfoTip text="Este es el lienzo de tu red. Añade cada equipo con estos botones y conéctalos arrastrando desde el borde derecho de un nodo al borde izquierdo del siguiente, siguiendo el camino de la señal (ej. Gateway → MikroTik → PTP → MikroTik → AP → Cliente). El orden importa: es el grafo de dependencias que usa la IA para ubicar fallas — si un equipo cae, todo lo que cuelga de él se ve afectado. El color del borde muestra el estado en vivo: verde OK, amarillo con pérdida, rojo caído." />
        </div>
        {(Object.keys(NODE_TYPE_LABELS) as NodeType[]).map((t) => (
          <button key={t} onClick={() => addNode(t)}>
            <span>{NODE_TYPE_ICONS[t]}</span> {NODE_TYPE_LABELS[t]}
          </button>
        ))}
      </div>
      <ReactFlow
        nodes={flowNodes as FlowNode[]}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => onSelectNode(parseInt(node.id, 10))}
        onEdgeClick={(_, edge) => onSelectEdge(parseInt(edge.id, 10))}
        onPaneClick={() => {
          onSelectNode(null);
          onSelectEdge(null);
        }}
        fitView
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1e293b" gap={20} />
        <Controls />
        <MiniMap pannable zoomable style={{ background: '#131a2b' }} />
      </ReactFlow>
    </div>
  );
}
