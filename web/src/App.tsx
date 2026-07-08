import { useCallback, useEffect, useMemo, useRef, useState, Suspense, lazy } from 'react';
import { TopologyCanvas } from './canvas/TopologyCanvas';
import { NodeDrawer, EdgeDrawer } from './ui/DeviceDrawer';
import { HelpModal } from './ui/HelpModal';
import { EmergencyAlarm, loadAlarmCfg, saveAlarmCfg, type AlarmCfg, type EmergencyItem } from './ui/EmergencyAlarm';
import { AlertsSection } from './sections/AlertsSection';
import { SaturationSection } from './sections/SaturationSection';
import { AiSection } from './sections/AiSection';
import { TelegramSection } from './sections/TelegramSection';
import { SettingsSection } from './sections/SettingsSection';
import { api } from './api';
import { useWebSocket } from './ws';
import { Icon, SECTION_META, type Section } from './ui/meta';
import type { ApiNode, ApiEdge, LiveNode } from './types';

const GeoMap = lazy(() => import('./map/GeoMap'));

type ChatHandler = (event: string, data: { sessionId: string; text?: string; name?: string; error?: string }) => void;

const NAV: Section[] = ['topology', 'map', 'alerts', 'saturation', 'ai', 'telegram', 'settings'];

// Equipos de infraestructura cuya caída dispara la alarma de emergencia sonora.
const INFRA_TYPES = new Set<string>(['mikrotik', 'router', 'ptp-mimosa', 'ap-ubiquiti', 'olt']);

export default function App() {
  const [nodes, setNodes] = useState<ApiNode[]>([]);
  const [edges, setEdges] = useState<ApiEdge[]>([]);
  const [live, setLive] = useState<Record<number, LiveNode>>({});
  const [aiAvailable, setAiAvailable] = useState(false);
  const [section, setSection] = useState<Section>('topology');
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('mct-theme') as 'dark' | 'light') || 'dark');
  const [now, setNow] = useState(new Date());
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<number | null>(null);
  const [alertRefresh, setAlertRefresh] = useState(0);
  const [openAlerts, setOpenAlerts] = useState(0);
  const [focusStart, setFocusStart] = useState<number | null>(null);
  const [helpKey, setHelpKey] = useState<string | null>(null);
  const [alarmCfg, setAlarmCfg] = useState<AlarmCfg>(() => loadAlarmCfg());
  const [emergencies, setEmergencies] = useState<EmergencyItem[]>([]);
  const [mapCfg, setMapCfg] = useState({ key: '', style: 'dark' });
  const chatHandlerRef = useRef<ChatHandler>(() => {});
  const nodesRef = useRef<ApiNode[]>([]);
  const alarmRef = useRef<AlarmCfg>(alarmCfg);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { alarmRef.current = alarmCfg; saveAlarmCfg(alarmCfg); }, [alarmCfg]);

  // Al cargar: si ya hay equipos de infraestructura caídos (alertas node_down abiertas),
  // dispara la alarma — así no se pierde una caída que ocurrió antes de abrir el monitor.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || nodes.length === 0) return;
    seededRef.current = true;
    const cfg = alarmRef.current;
    if (!cfg.enabled) return;
    api.alerts().then((r) => {
      const items: EmergencyItem[] = [];
      for (const a of r.alerts) {
        if (a.resolved_at || a.type !== 'node_down' || a.node_id == null) continue;
        const node = nodes.find((n) => n.id === a.node_id);
        if (node && (INFRA_TYPES.has(node.type) || node.watched || cfg.allDevices)) {
          items.push({ nodeId: node.id, name: node.name, message: a.message });
        }
      }
      if (items.length) setEmergencies(items);
    }).catch(() => {});
  }, [nodes]);

  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('mct-theme', theme); }, [theme]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);

  const loadFocus = useCallback(() => { api.getFocus().then((f) => setFocusStart(f.focusStart)).catch(() => {}); }, []);
  const reload = useCallback(() => {
    api.topology().then((t) => { setNodes(t.nodes); setEdges(t.edges); setLive(t.live); setAiAvailable(t.aiAvailable); }).catch(() => {});
  }, []);
  const loadAlertCount = useCallback(() => {
    api.alerts().then((r) => setOpenAlerts(r.alerts.filter((a) => !a.resolved_at).length)).catch(() => {});
  }, []);
  const loadMap = useCallback(() => {
    api.settings().then((s) => setMapCfg({ key: s.maptilerKey, style: s.mapStyle })).catch(() => {});
  }, []);

  useEffect(() => { reload(); loadFocus(); loadAlertCount(); loadMap(); }, [reload, loadFocus, loadAlertCount, loadMap]);
  // Refrescar la key/estilo del mapa al entrar en la sección (por si se acaba de guardar en Ajustes).
  useEffect(() => { if (section === 'map') loadMap(); }, [section, loadMap]);
  useEffect(() => { loadAlertCount(); }, [alertRefresh, loadAlertCount]);

  const { send } = useWebSocket((event, data) => {
    if (event === 'status') {
      const map = data as Record<number, LiveNode>;
      setLive(map);
      // Limpia la alarma de emergencia de un equipo cuando vuelve a responder.
      setEmergencies((prev) => prev.filter((e) => map[e.nodeId]?.status !== 'up'));
    } else if (event === 'alert') {
      setAlertRefresh((x) => x + 1);
      const ev = data as { nodeId: number | null; type: string; message: string };
      const cfg = alarmRef.current;
      const node = ev.nodeId != null ? nodesRef.current.find((n) => n.id === ev.nodeId) : undefined;
      const qualifies = cfg.enabled && ev.type === 'node_down' && !!node &&
        (INFRA_TYPES.has(node.type) || node.watched || cfg.allDevices);
      if (qualifies && node) {
        setEmergencies((prev) => (prev.some((e) => e.nodeId === node.id) ? prev : [...prev, { nodeId: node.id, name: node.name, message: ev.message }]));
      }
    } else if (event === 'alert_resolved') {
      setAlertRefresh((x) => x + 1);
    } else if (event.startsWith('chat_')) chatHandlerRef.current(event, data as Parameters<ChatHandler>[1]);
  });
  const registerChatHandler = useCallback((fn: ChatHandler) => { chatHandlerRef.current = fn; }, []);

  const startFocus = useCallback(() => {
    if (!confirm('Iniciar una nueva investigación: a partir de ahora el análisis (matriz de pérdida, saturación, alertas y la IA) considerará solo los datos nuevos. Los datos viejos NO se borran. ¿Continuar?')) return;
    api.setFocus().then((f) => { setFocusStart(f.focusStart); setAlertRefresh((x) => x + 1); }).catch(() => {});
  }, []);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId) ?? null;

  const health = useMemo(() => {
    let up = 0, warn = 0, down = 0;
    for (const n of nodes) {
      if (n.type === 'monitor') { up++; continue; }
      const s = live[n.id]?.status ?? 'unknown';
      if (s === 'up') up++; else if (s === 'warning') warn++; else if (s === 'down') down++;
    }
    return { up, warn, down };
  }, [nodes, live]);

  const sec = SECTION_META[section];

  return (
    <div className="shell">
      {/* SIDEBAR */}
      <aside className="sidebar" style={{ width: collapsed ? 70 : 230 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 6px', height: 56, flexShrink: 0 }}>
          <div className="brand-logo">
            <Icon path="M4 12h3l2 6 4-14 2 8h5" size={19} stroke="#fff" strokeWidth={2} />
          </div>
          {!collapsed && (
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, lineHeight: 1 }}>Monitor <span style={{ color: 'var(--accent)' }}>CT</span></div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>localhost:3000</div>
            </div>
          )}
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 14, flex: 1 }}>
          {NAV.map((s) => {
            const m = SECTION_META[s];
            return (
              <button key={s} className={`nav-btn ${section === s ? 'active' : ''}`} title={m.title} onClick={() => setSection(s)}>
                <Icon path={m.icon} size={18} strokeWidth={1.8} style={{ flexShrink: 0 }} />
                {!collapsed && <span>{m.title}</span>}
                {!collapsed && s === 'alerts' && openAlerts > 0 && <span className="nav-badge">{openAlerts}</span>}
              </button>
            );
          })}
        </nav>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {focusStart && !collapsed && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--accentSoft)', border: '1px solid var(--border2)', borderRadius: 9 }}>
              <Icon path="M12 2v4M12 18v4M2 12h4M18 12h4" size={14} stroke="var(--accent)" strokeWidth={2} />
              <span style={{ fontSize: 11, color: 'var(--text2)', flex: 1 }}>Modo enfoque activo</span>
              <a href="#" style={{ fontSize: 11 }} onClick={(e) => { e.preventDefault(); api.clearFocus().then(() => { setFocusStart(null); setAlertRefresh((x) => x + 1); }); }}>quitar</a>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 6px' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--up)', animation: 'blink 2s infinite', flexShrink: 0 }} />
            {!collapsed && <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{aiAvailable ? 'backend OK · IA activa' : 'backend OK'}</span>}
          </div>
          <button className="nav-btn" style={{ justifyContent: 'center', background: 'var(--panel2)', border: '1px solid var(--border)', height: 34 }} onClick={() => setCollapsed((c) => !c)}>
            <Icon path="M15 6l-6 6 6 6" size={16} strokeWidth={2} style={{ transform: collapsed ? 'rotate(180deg)' : undefined }} />
            {!collapsed && <span>Contraer</span>}
          </button>
        </div>
      </aside>

      {/* MAIN */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--bg)' }}>
        <header className="topbar">
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{sec.title}</h1>
              <button className="help-dot" onClick={() => setHelpKey(section)}>!</button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{sec.subtitle}</div>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div className="health-pill" style={{ background: 'var(--upSoft)', color: 'var(--up)' }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--up)' }} />{health.up}</div>
            <div className="health-pill" style={{ background: 'var(--warnSoft)', color: 'var(--warn)' }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--warn)' }} />{health.warn}</div>
            <div className="health-pill" style={{ background: 'var(--downSoft)', color: 'var(--down)' }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--down)' }} />{health.down}</div>
            {!focusStart && (
              <button className="btn" onClick={startFocus} title="Enfocar el análisis en un problema nuevo">
                <Icon path="M12 2v4M12 18v4M2 12h4M18 12h4" size={13} strokeWidth={2} />Nueva investigación
              </button>
            )}
            <div style={{ width: 1, height: 24, background: 'var(--border)' }} />
            <div className="mono" style={{ fontSize: 13, color: 'var(--text2)', minWidth: 74, textAlign: 'right' }}>{now.toLocaleTimeString('es-ES')}</div>
            <button className="icon-btn" title="Cambiar tema" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>
              <Icon path={theme === 'dark' ? 'M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z' : 'M12 4V2M12 22v-2M4 12H2M22 12h-2M6 6L4.5 4.5M19.5 19.5L18 18M6 18l-1.5 1.5M19.5 4.5L18 6M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'} size={17} strokeWidth={1.9} />
            </button>
          </div>
        </header>

        <div className="content">
          {section === 'topology' && (
            <TopologyCanvas
              nodes={nodes} edges={edges} live={live} theme={theme}
              selectedNodeId={selectedNodeId} selectedEdgeId={selectedEdgeId}
              onSelectNode={(id) => { setSelectedNodeId(id); setSelectedEdgeId(null); }}
              onSelectEdge={(id) => { setSelectedEdgeId(id); setSelectedNodeId(null); }}
              onTopologyChanged={reload}
              onHelp={() => setHelpKey('palette')}
              onOpenContainer={(id) => { setSelectedNodeId(id); setSelectedEdgeId(null); }}
            />
          )}
          {section === 'map' && (
            <Suspense fallback={<div className="empty-hint" style={{ padding: 30 }}>Cargando mapa…</div>}>
              <GeoMap
                nodes={nodes} edges={edges} live={live}
                maptilerKey={mapCfg.key} mapStyle={mapCfg.style}
                selectedNodeId={selectedNodeId}
                onSelectNode={(id) => { setSelectedNodeId(id); setSelectedEdgeId(null); }}
                onSelectEdge={(id) => { setSelectedEdgeId(id); setSelectedNodeId(null); }}
                onChanged={reload}
                onHelp={() => setHelpKey('map')}
              />
            </Suspense>
          )}
          {section === 'alerts' && <AlertsSection refreshKey={alertRefresh} focusStart={focusStart} onHelp={() => setHelpKey('alerts')} />}
          {section === 'saturation' && <SaturationSection edges={edges} nodes={nodes} focusStart={focusStart} onHelp={() => setHelpKey('saturation')} />}
          {section === 'ai' && <AiSection aiAvailable={aiAvailable} send={send} registerHandler={registerChatHandler} />}
          {section === 'telegram' && <TelegramSection />}
          {section === 'settings' && <SettingsSection onAiChanged={reload} focusStart={focusStart} onFocusChanged={() => { loadFocus(); setAlertRefresh((x) => x + 1); }} alarm={alarmCfg} onAlarm={setAlarmCfg} />}
        </div>
      </main>

      {/* DRAWERS — funcionan tanto desde la topología como desde el mapa */}
      {(section === 'topology' || section === 'map') && selectedNode && (
        <NodeDrawer
          node={selectedNode} live={live[selectedNode.id] ?? null} nodes={nodes} liveAll={live}
          onChanged={reload} onDeleted={() => { setSelectedNodeId(null); reload(); }}
          onClose={() => setSelectedNodeId(null)} onHelp={(k) => setHelpKey(k)}
        />
      )}
      {(section === 'topology' || section === 'map') && selectedEdge && (
        <EdgeDrawer
          edge={selectedEdge} nodes={nodes}
          onChanged={reload} onDeleted={() => { setSelectedEdgeId(null); reload(); }}
          onClose={() => setSelectedEdgeId(null)}
        />
      )}

      <HelpModal helpKey={helpKey} onClose={() => setHelpKey(null)} />
      <EmergencyAlarm items={emergencies} intervalSec={alarmCfg.intervalSec} onAck={() => setEmergencies([])} />
    </div>
  );
}
