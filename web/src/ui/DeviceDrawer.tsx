import { useEffect, useMemo, useState } from 'react';
import type { ApiNode, ApiEdge, LiveNode, NodeType } from '../types';
import { NODE_TYPE_LABELS, ADDABLE_TYPES, CONTAINER_TYPES } from '../types';
import { api } from '../api';
import { Icon, ICONS, TYPE_META, typeMeta } from './meta';
import { Sparkline } from './Sparkline';
import { RouterosFlow } from './RouterosFlow';
import { ConfigAudit } from './ConfigAudit';
import { OltPorts } from './OltPorts';
import { OnuBudget } from './OnuBudget';
import type { NapMeta, FiberInfo, OltMeta } from '../types';
import { TIA_COLORS } from '../types';

const FTTH_TYPES = ['olt', 'onu', 'nap', 'poste'];
/** Distancia en metros entre dos coordenadas (haversine). */
function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

const STATUS = {
  up: { label: 'En línea', color: 'var(--up)', soft: 'var(--upSoft)' },
  warning: { label: 'Advertencia', color: 'var(--warn)', soft: 'var(--warnSoft)' },
  down: { label: 'Caído', color: 'var(--down)', soft: 'var(--downSoft)' },
  unknown: { label: 'Sin datos', color: 'var(--muted)', soft: 'var(--panel3)' },
} as const;

type Tab = 'config' | 'metrics' | 'flow' | 'audit' | 'tdr' | 'inside' | 'ports' | 'pon';

interface CablePair { pair: string; status: string; distanceM: number | null }
interface CableIface { name: string; supported: boolean; status?: string; note?: string; pairs?: CablePair[] }

function DrawerChrome({ icon, color, name, statusChip, sub, onClose, children }: {
  icon: string; color: string; name: string; statusChip?: React.ReactNode; sub: string; onClose: () => void; children: React.ReactNode;
}) {
  return (
    <div className="drawer-backdrop">
      <div className="drawer-scrim" onClick={onClose} />
      <div className="drawer">
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--panel3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color }}>
            <Icon path={icon} size={20} strokeWidth={1.85} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{name}</h2>
              {statusChip}
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>
          </div>
          <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function NodeDrawer({ node, live, nodes = [], liveAll = {}, onChanged, onDeleted, onClose, onHelp }: {
  node: ApiNode; live: LiveNode | null; nodes?: ApiNode[]; liveAll?: Record<number, LiveNode>;
  onChanged: () => void; onDeleted: () => void; onClose: () => void; onHelp: (key: string) => void;
}) {
  const meta = typeMeta(node.type);
  const isMonitor = node.type === 'monitor';
  const isMikrotik = node.type === 'mikrotik';
  const isContainer = CONTAINER_TYPES.includes(node.type);
  const isOlt = node.type === 'olt';
  const isOnu = node.type === 'onu';
  const isNap = node.type === 'nap';
  const isRouterLike = isMikrotik || node.type === 'router';
  const isSnmp = ['ptp-mimosa', 'ap-ubiquiti', 'litebeam', 'cliente', 'router'].includes(node.type);
  const status = isMonitor ? 'up' : (live?.status ?? 'unknown');
  const st = STATUS[status];

  const [tab, setTab] = useState<Tab>('config');
  const [form, setForm] = useState({
    name: node.name, ip: node.ip, type: node.type as NodeType,
    routerosUser: '', routerosPass: '', snmpCommunity: node.snmpCommunity,
    probeTargets: node.probeTargets.join(', '), probeSrcAddresses: node.probeSrcAddresses.join(', '),
  });
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; detail: string }> | null>(null);
  const [testing, setTesting] = useState(false);
  const [watched, setWatchedState] = useState(node.watched);
  const [splitRatio, setSplitRatio] = useState<number>(((node.meta ?? {}) as NapMeta).splitRatio ?? 8);
  const [available, setAvailable] = useState<string[]>([]);
  const [cable, setCable] = useState<{ supported: boolean; note?: string; results?: CableIface[] } | null>(null);
  const [cableTesting, setCableTesting] = useState(false);

  useEffect(() => {
    setTab('config'); setTestResult(null); setCable(null); setWatchedState(node.watched);
    setSplitRatio(((node.meta ?? {}) as NapMeta).splitRatio ?? 8);
    setForm({
      name: node.name, ip: node.ip, type: node.type, routerosUser: '', routerosPass: '',
      snmpCommunity: node.snmpCommunity, probeTargets: node.probeTargets.join(', '), probeSrcAddresses: node.probeSrcAddresses.join(', '),
    });
    api.availableMetrics({ nodeId: node.id }).then((r) => setAvailable(r.metrics)).catch(() => setAvailable([]));
  }, [node.id]);

  const parseList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const save = async () => {
    await api.updateNode(node.id, {
      name: form.name, ip: form.ip, type: form.type,
      probeTargets: parseList(form.probeTargets), probeSrcAddresses: parseList(form.probeSrcAddresses),
      credentials: { routerosUser: form.routerosUser, routerosPass: form.routerosPass, snmpCommunity: form.snmpCommunity },
      ...(isNap ? { meta: { splitRatio } } : {}),
    });
    onChanged();
  };
  const test = async () => {
    setTesting(true); setTestResult(null);
    try { await save(); setTestResult(await api.testNode(node.id)); }
    catch (err) { setTestResult({ error: { ok: false, detail: String(err) } }); }
    finally { setTesting(false); }
  };
  const runCable = async () => {
    setCableTesting(true); setCable(null);
    try { setCable(await api.cableTest(node.id)); }
    catch (err) { setCable({ supported: false, note: String(err) }); }
    finally { setCableTesting(false); }
  };

  const metricsToShow = useMemo(() => {
    const base = ['latency_ms', 'loss_pct'];
    return [...new Set([...base, ...available])].slice(0, 8);
  }, [available]);

  // Miembros del contenedor (para la pestaña «Interior»)
  const members = useMemo(() => (isContainer ? nodes.filter((n) => n.containerId === node.id) : []), [isContainer, nodes, node.id]);
  const memberWorst = useMemo(() => {
    const rank = { down: 3, warning: 2, unknown: 1, up: 0 } as Record<string, number>;
    let worst = 'unknown';
    for (const m of members) { const s = liveAll[m.id]?.status ?? 'unknown'; if (rank[s] > rank[worst]) worst = s; }
    return worst;
  }, [members, liveAll]);

  const tabs: { k: Tab; label: string }[] = [{ k: 'config', label: 'Configuración' }];
  if (isContainer) tabs.push({ k: 'inside', label: `Interior (${members.length})` });
  if (isOlt) tabs.push({ k: 'ports', label: 'Puertos PON' });
  if (isOnu) tabs.push({ k: 'pon', label: 'PON' });
  if (!isMonitor && !isContainer) tabs.push({ k: 'metrics', label: 'Métricas' });
  if (isRouterLike) tabs.push({ k: 'flow', label: 'Flujo RouterOS' });
  if (isMikrotik) tabs.push({ k: 'audit', label: 'Auditoría' });
  if (isMikrotik) tabs.push({ k: 'tdr', label: 'Cable TDR' });

  const chip = <span className="chip" style={{ background: st.soft, color: st.color, padding: '2px 9px' }}>{st.label}</span>;

  return (
    <DrawerChrome icon={ICONS[meta.icon]} color={meta.color} name={node.name} statusChip={chip}
      sub={`${meta.label} · ${node.ip || 'sin IP'}`} onClose={onClose}>
      <div style={{ display: 'flex', gap: 4, padding: '10px 16px 0', borderBottom: '1px solid var(--border)' }}>
        {tabs.map((t) => (
          <button key={t.k} className={`drawer-tab ${tab === t.k ? 'active' : ''}`} onClick={() => setTab(t.k)}>{t.label}</button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
        {tab === 'config' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {isMonitor && (
              <div className="status-line pending" style={{ marginTop: 0 }}>
                Este es el PC de monitoreo, la raíz de tu red. Sus sondas a internet se configuran en Ajustes → «Targets de sonda del PC». Conéctalo al primer equipo tirando del punto azul de su borde derecho.
              </div>
            )}
            {isContainer && (
              <div className="status-line pending" style={{ marginTop: 0 }}>
                {node.type === 'rack' ? 'Un rack agrupa los equipos de un gabinete.' : 'Una torre agrupa las antenas (PTP, sectoriales) de un sitio.'} Añade o quita equipos en la pestaña <b>Interior</b>. En el mapa, los miembros sin ubicación propia heredan la del contenedor.
              </div>
            )}
            <label className="field">
              <span className="field-label">Nombre</span>
              <input className="inp" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            {!isMonitor && !isContainer && (
              <>
                <label className="field">
                  <span className="field-label">Tipo</span>
                  <select className="inp sans" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as NodeType })}>
                    {ADDABLE_TYPES.map((v) => <option key={v} value={v}>{NODE_TYPE_LABELS[v]}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Dirección IP</span>
                  <input className="inp" value={form.ip} placeholder="192.168.x.x" onChange={(e) => setForm({ ...form, ip: e.target.value })} />
                </label>
                {isMikrotik && (
                  <>
                    <label className="field"><span className="field-label">Usuario API RouterOS</span>
                      <input className="inp" value={form.routerosUser} placeholder={node.hasRouterosCreds ? '(guardado — escribir para cambiar)' : 'admin'} onChange={(e) => setForm({ ...form, routerosUser: e.target.value })} /></label>
                    <label className="field"><span className="field-label">Clave API</span>
                      <input className="inp" type="password" value={form.routerosPass} placeholder={node.hasRouterosCreds ? '(guardada)' : ''} onChange={(e) => setForm({ ...form, routerosPass: e.target.value })} /></label>
                    <label className="field"><span className="field-label">Sondas externas (coma)</span>
                      <input className="inp" value={form.probeTargets} placeholder="8.8.8.8, IP gateway público" onChange={(e) => setForm({ ...form, probeTargets: e.target.value })} /></label>
                    <label className="field"><span className="field-label">IPs origen — src (simula cliente)</span>
                      <input className="inp" value={form.probeSrcAddresses} placeholder="IP LAN del router" onChange={(e) => setForm({ ...form, probeSrcAddresses: e.target.value })} /></label>
                  </>
                )}
                {isSnmp && !isMikrotik && (
                  <label className="field"><span className="field-label">Community SNMP</span>
                    <input className="inp" value={form.snmpCommunity} placeholder="public" onChange={(e) => setForm({ ...form, snmpCommunity: e.target.value })} /></label>
                )}
                {node.type === 'switch' && (
                  <div className="status-line pending" style={{ marginTop: 0 }}>Switch no administrable: su cable se diagnostica desde el puerto del MikroTik vecino.</div>
                )}
                {isNap && (
                  <label className="field">
                    <span className="field-label">Splitter (ratio)</span>
                    <select className="inp sans" value={splitRatio} onChange={(e) => setSplitRatio(parseInt(e.target.value, 10))}>
                      {[2, 4, 8, 16, 32, 64].map((r) => <option key={r} value={r}>1:{r}</option>)}
                    </select>
                    <span style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>La pérdida del splitter se resta en el cálculo de potencia PON de las ONU que cuelgan de esta caja.</span>
                  </label>
                )}
                {node.type === 'poste' && (
                  <div className="status-line pending" style={{ marginTop: 0 }}>Poste: elemento de planta externa (referencia). Sitúalo en el mapa por dónde pasa la fibra.</div>
                )}
              </>
            )}

            <div style={{ display: 'flex', gap: 9, marginTop: 4 }}>
              <button className="btn primary btn-block" style={{ flex: 1 }} onClick={save}>Guardar</button>
              {!isMonitor && !isContainer && (
                <button className="btn" onClick={test} disabled={testing}>
                  <Icon path={testing ? 'M21 12a9 9 0 1 1-6.2-8.5' : 'M22 12h-4l-3 9L9 3l-3 9H2'} size={16} strokeWidth={2} style={testing ? { animation: 'spin 1s linear infinite' } : undefined} />
                  {testing ? 'Probando…' : 'Probar conexión'}
                </button>
              )}
              {!isContainer && <button className="btn" style={{ width: 40, color: 'var(--muted)' }} onClick={() => onHelp('conntest')}>!</button>}
            </div>
            {!isMonitor && !isContainer && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 10, padding: '11px 13px' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Icon path="M22 4L2 11l6 2 2 6 3-4 5 4z" size={14} stroke={watched ? 'var(--accent)' : 'var(--muted)'} strokeWidth={2} />
                    Vigilar en Telegram
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Sus alertas siempre notifican (ignora severidad mínima y horario silencioso). Ideal para un cliente VIP o un router clave.</div>
                </div>
                <button
                  className="toggle" style={{ background: watched ? 'var(--accent)' : 'var(--border2)' }}
                  onClick={() => { const next = !watched; setWatchedState(next); void api.watchNode(node.id, next).then(onChanged); }}
                >
                  <span className="knob" style={{ left: watched ? 20 : 2 }} />
                </button>
              </div>
            )}
            {!isMonitor && (
              <button className="btn danger" onClick={() => { if (confirm(`¿Eliminar ${node.name}? Se borran también sus métricas.`)) void api.deleteNode(node.id).then(onDeleted).catch((e) => alert(String(e))); }}>Eliminar equipo</button>
            )}
            {testResult && (
              <div className="card" style={{ padding: '12px 13px' }}>
                {Object.entries(testResult).map(([k, v]) => (
                  <div key={k} className="mono" style={{ fontSize: 11.5, color: v.ok ? 'var(--up)' : 'var(--down)', lineHeight: 1.7 }}>{v.ok ? '✔' : '✘'} {k}: {v.detail}</div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'metrics' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11 }}>
            {metricsToShow.map((m) => <Sparkline key={m} nodeId={node.id} metric={m} hoursBack={6} />)}
          </div>
        )}

        {tab === 'inside' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span className="chip" style={{ background: STATUS[memberWorst as keyof typeof STATUS].soft, color: STATUS[memberWorst as keyof typeof STATUS].color }}>
                {members.length} equipo{members.length !== 1 ? 's' : ''} · {STATUS[memberWorst as keyof typeof STATUS].label}
              </span>
            </div>
            {/* miembros actuales */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
              {members.map((m) => {
                const ms = liveAll[m.id]?.status ?? 'unknown';
                const mm = typeMeta(m.type);
                return (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 9, padding: '8px 11px' }}>
                    <span className="node-ico" style={{ width: 26, height: 26, color: mm.color }}><Icon path={ICONS[mm.icon]} size={14} strokeWidth={1.9} /></span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                      <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>{mm.label} · {m.ip || 'sin IP'}</div>
                    </div>
                    <span className="node-dot" style={{ background: STATUS[ms as keyof typeof STATUS].color }} />
                    <button className="btn" style={{ padding: '4px 9px' }} onClick={() => void api.updateNode(m.id, { containerId: null }).then(onChanged)}>Sacar</button>
                  </div>
                );
              })}
              {members.length === 0 && <div className="empty-hint" style={{ padding: 0 }}>Aún no hay equipos aquí. Añade abajo.</div>}
            </div>
            {/* añadir un equipo suelto */}
            <div className="field-label" style={{ marginBottom: 6 }}>Añadir equipo</div>
            <select className="inp sans" value="" onChange={(e) => { const mid = parseInt(e.target.value, 10); if (mid) void api.updateNode(mid, { containerId: node.id }).then(onChanged); }}>
              <option value="">— elegir equipo suelto —</option>
              {nodes.filter((n) => n.id !== node.id && n.containerId == null && n.type !== 'monitor' && !CONTAINER_TYPES.includes(n.type)).map((n) => (
                <option key={n.id} value={n.id}>{n.name} ({typeMeta(n.type).label})</option>
              ))}
            </select>
          </div>
        )}

        {tab === 'ports' && <OltPorts node={node} onChanged={onChanged} />}
        {tab === 'pon' && <OnuBudget node={node} />}

        {tab === 'flow' && <RouterosFlow nodeId={node.id} onHelp={() => onHelp('flow')} />}

        {tab === 'audit' && <ConfigAudit nodeId={node.id} />}

        {tab === 'tdr' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 11, padding: 13, marginBottom: 14 }}>
              <Icon path="M4 12h4l2-6 4 12 2-6h4" size={18} stroke="var(--accent)" strokeWidth={1.8} style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.55 }}>Reflectometría (TDR) del cable UTP en el MikroTik. Analiza los 4 pares e informa estado y distancia a la falla. Interrumpe el enlace ~1 s por puerto. <a href="#" onClick={(e) => { e.preventDefault(); onHelp('tdr'); }}>¿Cómo funciona?</a></div>
            </div>
            <button className="btn btn-block" style={{ marginBottom: 14 }} onClick={runCable} disabled={cableTesting}>
              <Icon path={cableTesting ? 'M21 12a9 9 0 1 1-6.2-8.5' : 'M4 12h4l2-6 4 12 2-6h4'} size={16} strokeWidth={2} style={cableTesting ? { animation: 'spin 1s linear infinite' } : undefined} />
              {cableTesting ? 'Ejecutando TDR…' : 'Ejecutar prueba TDR (todos los puertos)'}
            </button>
            {cable && (
              <div>
                {!cable.supported && <div className="status-line fail">{cable.note}</div>}
                {cable.results?.map((r) => (
                  <div key={r.name} style={{ border: '1px solid var(--border)', borderRadius: 11, overflow: 'hidden', marginBottom: 10 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr 1fr', background: 'var(--panel3)', padding: '9px 13px', fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 600 }}>
                      <span>{r.name}</span><span>Estado</span><span>Distancia</span>
                    </div>
                    {!r.supported && <div style={{ padding: '10px 13px', fontSize: 12, color: 'var(--muted)' }}>{r.note || 'Puerto sin soporte de prueba de cable'}</div>}
                    {r.pairs?.map((p, i) => {
                      const ok = p.status === 'ok';
                      const col = ok ? 'var(--up)' : p.status.includes('open') || p.status.includes('abierto') ? 'var(--warn)' : 'var(--down)';
                      const soft = ok ? 'var(--upSoft)' : p.status.includes('open') ? 'var(--warnSoft)' : 'var(--downSoft)';
                      return (
                        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr 1fr', padding: '11px 13px', borderTop: '1px solid var(--border)', alignItems: 'center' }}>
                          <span className="mono" style={{ fontSize: 12 }}>Par {p.pair}</span>
                          <span className="chip" style={{ background: soft, color: col, width: 'fit-content' }}>{p.status}</span>
                          <span className="mono" style={{ fontSize: 12, color: 'var(--text2)' }}>{p.distanceM != null && !ok ? `${p.distanceM} m` : '—'}</span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </DrawerChrome>
  );
}

export function EdgeDrawer({ edge, nodes, onChanged, onDeleted, onClose }: {
  edge: ApiEdge; nodes: ApiNode[]; onChanged: () => void; onDeleted: () => void; onClose: () => void;
}) {
  const source = nodes.find((n) => n.id === edge.source_id);
  const target = nodes.find((n) => n.id === edge.target_id);
  // El MikroTik puede estar en cualquier extremo del enlace: sus puertos y la utilización
  // se leen desde ahí sin importar la dirección en que se dibujó el enlace.
  const mkNode = source?.type === 'mikrotik' ? source : target?.type === 'mikrotik' ? target : undefined;
  const isFiberLink = !!(source && target && (FTTH_TYPES.includes(source.type) || FTTH_TYPES.includes(target.type)));
  const oltEndpoint = source?.type === 'olt' ? source : target?.type === 'olt' ? target : undefined;
  const [form, setForm] = useState({ label: edge.label, capacityMbps: edge.capacity_mbps?.toString() ?? '', sourceInterface: edge.source_interface });
  const [medium, setMedium] = useState(edge.medium || (isFiberLink ? 'fiber' : ''));
  const [fiber, setFiber] = useState<FiberInfo>(edge.fiber ?? {});
  const [ifaces, setIfaces] = useState<{ name: string; type: string; running: boolean; rxMbps: number; txMbps: number }[] | null>(null);
  const [ifaceBusy, setIfaceBusy] = useState(false);
  const [ifaceNote, setIfaceNote] = useState<string | null>(null);

  const autoLenM = (source?.lat != null && source.lng != null && target?.lat != null && target.lng != null)
    ? haversineM(source.lat, source.lng, target.lat, target.lng) : null;
  const setFiberField = (patch: Partial<FiberInfo>) => setFiber((f) => ({ ...f, ...patch }));

  const loadIfaces = async () => {
    if (!mkNode) return;
    setIfaceBusy(true); setIfaceNote(null);
    try {
      const r = await api.interfaces(mkNode.id);
      if (r.supported && r.interfaces) { setIfaces(r.interfaces); if (!r.interfaces.length) setIfaceNote('El router no devolvió interfaces.'); }
      else { setIfaces(null); setIfaceNote(r.note ?? 'No se pudieron leer los puertos.'); }
    } catch (err) { setIfaces(null); setIfaceNote(String(err)); }
    finally { setIfaceBusy(false); }
  };

  useEffect(() => {
    setForm({ label: edge.label, capacityMbps: edge.capacity_mbps?.toString() ?? '', sourceInterface: edge.source_interface });
    setMedium(edge.medium || (isFiberLink ? 'fiber' : ''));
    setFiber(edge.fiber ?? {});
    setIfaces(null); setIfaceNote(null);
    if (mkNode) void loadIfaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edge.id]);

  const save = async () => {
    // Longitud automática por haversine si el usuario no la fijó a mano.
    const fib = { ...fiber };
    if (medium === 'fiber' && (fib.lengthAuto || fib.lengthM == null) && autoLenM != null) { fib.lengthM = autoLenM; fib.lengthAuto = true; }
    await api.updateEdge(edge.id, {
      label: form.label, capacityMbps: form.capacityMbps ? parseFloat(form.capacityMbps) : null, sourceInterface: form.sourceInterface,
      medium, fiber: medium === 'fiber' ? fib : null,
    });
    onChanged();
  };

  return (
    <DrawerChrome icon="M7 5h10M6.5 6.8L17.5 15.5M12 7v10" color="var(--accent)" name="Enlace"
      sub={`${source?.name ?? '?'} → ${target?.name ?? '?'}`} onClose={onClose}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p className="card-sub" style={{ margin: 0 }}>Configura la capacidad e interfaz de origen para habilitar el % de utilización del enlace y la detección de saturación.</p>
        <label className="field"><span className="field-label">Etiqueta</span>
          <input className="inp" value={form.label} placeholder="PTP Icononzo-Paramitos" onChange={(e) => setForm({ ...form, label: e.target.value })} /></label>
        <label className="field"><span className="field-label">Capacidad real (Mbps)</span>
          <input className="inp" value={form.capacityMbps} placeholder="ej. 700 (real del enlace)" onChange={(e) => setForm({ ...form, capacityMbps: e.target.value })} /></label>
        <label className="field">
          <span className="field-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Interfaz {mkNode ? `del MikroTik (${mkNode.name})` : 'origen'}</span>
            {mkNode && (
              <button
                onClick={() => void loadIfaces()} disabled={ifaceBusy}
                style={{ background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, padding: 0 }}
              >
                <Icon path="M21 12a9 9 0 1 1-6.2-8.5M21 3v6h-6" size={12} strokeWidth={2} style={ifaceBusy ? { animation: 'spin 1s linear infinite' } : undefined} />
                {ifaceBusy ? 'leyendo…' : 'recargar tráfico'}
              </button>
            )}
          </span>
          {mkNode && ifaces && ifaces.length > 0 ? (
            <select className="inp sans" value={form.sourceInterface} onChange={(e) => setForm({ ...form, sourceInterface: e.target.value })}>
              <option value="">— elige el puerto —</option>
              {[...ifaces].sort((a, b) => Math.max(b.rxMbps, b.txMbps) - Math.max(a.rxMbps, a.txMbps)).map((i) => (
                <option key={i.name} value={i.name}>
                  {i.name} · ↓{i.rxMbps} ↑{i.txMbps} Mbps{i.running ? '' : ' · inactivo'}
                </option>
              ))}
            </select>
          ) : (
            <input className="inp" value={form.sourceInterface} placeholder="ether1, sfp1, wlan1…" onChange={(e) => setForm({ ...form, sourceInterface: e.target.value })} />
          )}
          {mkNode && ifaceNote && <span style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{ifaceNote} Puedes escribir el nombre a mano.</span>}
          {mkNode && ifaces && ifaces.length > 0 && <span style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Ordenados por tráfico actual — el del PTP suele ser el más cargado.</span>}
          {mkNode && ifaces && ifaces.length > 0 && form.sourceInterface && !ifaces.some((i) => i.name === form.sourceInterface) && (
            <input className="inp" style={{ marginTop: 6 }} value={form.sourceInterface} onChange={(e) => setForm({ ...form, sourceInterface: e.target.value })} placeholder="o escribe el nombre" />
          )}
        </label>

        {/* Medio físico */}
        <label className="field">
          <span className="field-label">Medio físico</span>
          <select className="inp sans" value={medium} onChange={(e) => setMedium(e.target.value)}>
            <option value="">Inalámbrico / sin especificar</option>
            <option value="fiber">Fibra óptica</option>
            <option value="copper">Cobre (UTP)</option>
          </select>
        </label>

        {/* Fibra: datos para el cálculo de potencia PON */}
        {medium === 'fiber' && (
          <div style={{ background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 11, padding: '12px 13px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="field-label">Cable de fibra</div>
            {oltEndpoint && (
              <label className="field"><span className="field-label">Puerto PON de la OLT ({oltEndpoint.name})</span>
                <select className="inp sans" value={fiber.oltPort ?? ''} onChange={(e) => setFiberField({ oltPort: e.target.value || undefined })}>
                  <option value="">— elegir puerto —</option>
                  {((oltEndpoint.meta ?? {}) as OltMeta).ports?.map((p) => <option key={p.name} value={p.name}>{p.name} · {p.txDbm} dBm</option>)}
                </select>
              </label>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label className="field"><span className="field-label">Longitud (m)</span>
                <input className="inp mono" type="number" value={fiber.lengthM ?? (autoLenM ?? '')} onChange={(e) => setFiberField({ lengthM: e.target.value ? parseFloat(e.target.value) : undefined, lengthAuto: false })} placeholder={autoLenM != null ? `${autoLenM} (auto)` : ''} /></label>
              <label className="field"><span className="field-label">Conectores</span>
                <input className="inp mono" type="number" value={fiber.connectors ?? ''} onChange={(e) => setFiberField({ connectors: e.target.value ? parseInt(e.target.value, 10) : undefined })} placeholder="2" /></label>
            </div>
            {autoLenM != null && (
              <button className="btn" style={{ alignSelf: 'flex-start', padding: '4px 10px' }} onClick={() => setFiberField({ lengthM: autoLenM, lengthAuto: true })}>Usar distancia del mapa ({autoLenM} m)</button>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label className="field"><span className="field-label">Buffers</span>
                <input className="inp mono" type="number" value={fiber.buffers ?? ''} onChange={(e) => setFiberField({ buffers: e.target.value ? parseInt(e.target.value, 10) : undefined })} placeholder="12" /></label>
              <label className="field"><span className="field-label">Hilos</span>
                <input className="inp mono" type="number" value={fiber.hilos ?? ''} onChange={(e) => setFiberField({ hilos: e.target.value ? parseInt(e.target.value, 10) : undefined })} placeholder="24" /></label>
            </div>
            <div className="field-label">Color del hilo (TIA)</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {TIA_COLORS.map((c) => (
                <button key={c.name} title={c.name} onClick={() => setFiberField({ hiloColor: c.name })}
                  style={{ width: 26, height: 26, borderRadius: 6, background: c.hex, cursor: 'pointer', border: fiber.hiloColor === c.name ? '2px solid var(--accent)' : '1px solid var(--border2)' }} />
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <label className="field"><span className="field-label">Tipo de cable</span>
                <input className="inp sans" value={fiber.cableType ?? ''} onChange={(e) => setFiberField({ cableType: e.target.value })} placeholder="ADSS, figura-8…" /></label>
              <label className="field"><span className="field-label">dB / km</span>
                <input className="inp mono" type="number" step="0.01" value={fiber.dbPerKm ?? ''} onChange={(e) => setFiberField({ dbPerKm: e.target.value ? parseFloat(e.target.value) : undefined })} placeholder="0.35" /></label>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 9, marginTop: 4 }}>
          <button className="btn primary" style={{ flex: 1 }} onClick={save}>Guardar</button>
          <button className="btn danger" onClick={() => { if (confirm('¿Eliminar este enlace?')) void api.deleteEdge(edge.id).then(onDeleted); }}>Eliminar</button>
        </div>
        {medium !== 'fiber' && (
          <>
            <div style={{ marginTop: 6 }} className="field-label">Utilización del enlace (24 h)</div>
            <Sparkline edgeId={edge.id} metric="utilization_pct" hoursBack={24} />
          </>
        )}
      </div>
    </DrawerChrome>
  );
}
