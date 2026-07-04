import { useCallback, useEffect, useRef, useState } from 'react';
import { TopologyCanvas } from './canvas/TopologyCanvas';
import { NodePanel } from './panels/NodePanel';
import { EdgePanel } from './panels/EdgePanel';
import { AlertsPanel } from './panels/AlertsPanel';
import { SaturationPanel } from './panels/SaturationPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { ChatPanel } from './chat/ChatPanel';
import { api } from './api';
import { useWebSocket } from './ws';
import type { ApiNode, ApiEdge, LiveNode } from './types';

type Tab = 'nodo' | 'alertas' | 'saturacion' | 'ia' | 'ajustes';

type ChatHandler = (event: string, data: { sessionId: string; text?: string; name?: string; error?: string }) => void;

export default function App() {
  const [nodes, setNodes] = useState<ApiNode[]>([]);
  const [edges, setEdges] = useState<ApiEdge[]>([]);
  const [live, setLive] = useState<Record<number, LiveNode>>({});
  const [aiAvailable, setAiAvailable] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('nodo');
  const [alertRefresh, setAlertRefresh] = useState(0);
  const chatHandlerRef = useRef<ChatHandler>(() => {});

  const reload = useCallback(() => {
    api.topology().then((t) => {
      setNodes(t.nodes);
      setEdges(t.edges);
      setLive(t.live);
      setAiAvailable(t.aiAvailable);
    }).catch(() => {});
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const { send } = useWebSocket((event, data) => {
    if (event === 'status') {
      setLive(data as Record<number, LiveNode>);
    } else if (event === 'alert' || event === 'alert_resolved') {
      setAlertRefresh((x) => x + 1);
    } else if (event.startsWith('chat_')) {
      chatHandlerRef.current(event, data as Parameters<ChatHandler>[1]);
    }
  });

  const registerChatHandler = useCallback((fn: ChatHandler) => {
    chatHandlerRef.current = fn;
  }, []);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId) ?? null;
  const openAlerts = 0; // el contador vive en AlertsPanel; aquí solo pestaña

  return (
    <div className="app">
      <div className="topbar">
        <h1>📡 MonitorCt</h1>
        <span className="small">Monitoreo de red WISP con diagnóstico IA</span>
        <span style={{ flex: 1 }} />
        <span className={`ai-badge ${aiAvailable ? 'ai-on' : 'ai-off'}`}>
          {aiAvailable ? 'IA activa' : 'IA sin configurar'}
        </span>
      </div>
      <div className="main">
        <TopologyCanvas
          nodes={nodes}
          edges={edges}
          live={live}
          onSelectNode={(id) => {
            setSelectedNodeId(id);
            setSelectedEdgeId(null);
            if (id !== null) setTab('nodo');
          }}
          onSelectEdge={(id) => {
            setSelectedEdgeId(id);
            setSelectedNodeId(null);
            if (id !== null) setTab('nodo');
          }}
          onTopologyChanged={reload}
        />
        <div className="sidebar">
          <div className="tabs">
            <button className={tab === 'nodo' ? 'active' : ''} onClick={() => setTab('nodo')}>Detalle</button>
            <button className={tab === 'alertas' ? 'active' : ''} onClick={() => setTab('alertas')}>
              Alertas{openAlerts > 0 ? ` (${openAlerts})` : ''}
            </button>
            <button className={tab === 'saturacion' ? 'active' : ''} onClick={() => setTab('saturacion')}>Saturación</button>
            <button className={tab === 'ia' ? 'active' : ''} onClick={() => setTab('ia')}>🤖 IA</button>
            <button className={tab === 'ajustes' ? 'active' : ''} onClick={() => setTab('ajustes')} title="Ajustes">⚙</button>
          </div>
          <div className="tab-content">
            {tab === 'nodo' && selectedNode && (
              <NodePanel
                node={selectedNode}
                onChanged={reload}
                onDeleted={() => { setSelectedNodeId(null); reload(); }}
              />
            )}
            {tab === 'nodo' && selectedEdge && (
              <EdgePanel
                edge={selectedEdge}
                nodes={nodes}
                onChanged={reload}
                onDeleted={() => { setSelectedEdgeId(null); reload(); }}
              />
            )}
            {tab === 'nodo' && !selectedNode && !selectedEdge && (
              <div className="empty-hint">
                Añade equipos con la paleta de la izquierda y conéctalos arrastrando desde el borde
                derecho de un nodo al izquierdo del siguiente (siguiendo el camino de la señal).
                <br /><br />
                Haz clic en un equipo o enlace para ver su detalle aquí.
              </div>
            )}
            {tab === 'alertas' && <AlertsPanel refreshKey={alertRefresh} />}
            {tab === 'saturacion' && <SaturationPanel edges={edges} nodes={nodes} />}
            {tab === 'ia' && <ChatPanel aiAvailable={aiAvailable} send={send} registerHandler={registerChatHandler} />}
            {tab === 'ajustes' && <SettingsPanel onAiChanged={reload} />}
          </div>
        </div>
      </div>
    </div>
  );
}
