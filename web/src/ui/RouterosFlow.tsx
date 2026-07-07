import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from './meta';

type Flow = Awaited<ReturnType<typeof api.routerosFlow>>;

export function RouterosFlow({ nodeId, onHelp }: { nodeId: number; onHelp: () => void }) {
  const [flow, setFlow] = useState<Flow | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.routerosFlow(nodeId).then((f) => { if (alive) { setFlow(f); setErr(null); } }).catch((e) => { if (alive) setErr(String(e)); });
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [nodeId]);

  if (err) return <div className="status-line fail">No se pudo leer el flujo RouterOS: {err}</div>;
  if (!flow) return <div className="empty-hint">Leyendo el flujo del router…</div>;
  if (!flow.supported) return <div className="status-line pending">{flow.note ?? 'Este equipo no expone el flujo RouterOS.'}</div>;

  const drops = flow.firewallDrops;
  const kpis = [
    { label: 'WAN ↓', value: `${flow.wanDownMbps} M`, color: 'var(--accent)' },
    { label: 'WAN ↑', value: `${flow.wanUpMbps} M`, color: 'var(--up)' },
    { label: 'Conexiones', value: flow.connections.toLocaleString('es'), color: 'var(--accent2)' },
    { label: 'CPU', value: `${flow.cpu}%`, color: flow.cpu > 75 ? 'var(--down)' : 'var(--text)' },
  ];

  const stages = [
    { icon: 'M12 3v12M7 10l5 5 5-5M4 21h16', accent: 'var(--accent)', title: 'Entrada WAN · Internet ISP', tag: 'wan', desc: 'El tráfico de internet del ISP entra por la interfaz WAN del router.', stat: `${flow.wanDownMbps} Mbps ↓`, statColor: 'var(--accent)' },
    { icon: 'M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8', accent: '#57c7d4', title: 'Connection Tracking', tag: 'conntrack', desc: 'Registra cada conexión (new / established / related) para NAT y firewall.', stat: `${flow.connections.toLocaleString('es')} conex`, statColor: '#57c7d4' },
    { icon: 'M20.6 8.6L12 17l-3.4-3.4M7 3h2l1 4-2 1-3-3zM3 7v2l4 1', accent: '#8b5bff', title: 'Mangle · Prerouting', tag: 'mangle', desc: 'Marca paquetes y conexiones para colas y ruteo por política (PBR).', stat: `${flow.mangleRules} reglas`, statColor: 'var(--text2)' },
    { icon: 'M16 3h5v5M21 3l-7 7M8 21H3v-5M3 21l7-7', accent: 'var(--warn)', title: 'NAT · dst-nat', tag: 'dstnat', desc: 'Traducción de destino: port forwarding hacia servidores internos.', stat: `${flow.dstnatRules} reglas`, statColor: 'var(--text2)' },
    { icon: 'M6 3v12a3 3 0 0 0 3 3h6M6 3l-2 3M6 3l2 3M15 12l3 3-3 3', accent: 'var(--accent2)', title: 'Decisión de ruteo', tag: 'routing', desc: 'Consulta la tabla de rutas y elige la interfaz de salida.', stat: 'OK', statColor: 'var(--up)' },
    { icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', accent: 'var(--down)', title: 'Firewall · Filter (forward)', tag: 'forward', desc: 'Acepta lo establecido, descarta lo no permitido y bloquea escaneos.', stat: `${flow.filterRules} reglas · ${drops} drop`, statColor: 'var(--text2)' },
    { icon: 'M8 21h8M8 21l-4-4M8 21l-4 4M16 3h5v5M21 3l-8 8', accent: 'var(--up)', title: 'NAT · src-nat / masquerade', tag: 'srcnat', desc: 'Enmascara la IP privada de los clientes con la IP pública de salida.', stat: 'masquerade', statColor: 'var(--text2)' },
    { icon: 'M4 20V10M10 20V4M16 20v-6M22 20h-2M2 20h20', accent: '#f5b13d', title: 'Simple Queues · por cliente', tag: 'queue', desc: 'Limita el ancho de banda contratado de cada abonado.', stat: `${flow.queues.length} colas`, statColor: '#f5b13d', isQueue: true },
    { icon: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8-4M8.6 16.5l6.8 4', accent: 'var(--up)', title: 'Bridge LAN → Clientes', tag: 'bridge', desc: 'Sale por el bridge LAN / wlan hacia los abonados.', stat: `${flow.wanUpMbps} Mbps ↑`, statColor: 'var(--up)' },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginBottom: 16 }}>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.55, flex: 1 }}>Recorrido del paquete dentro de RouterOS: cómo entra el internet por la WAN, se procesa y sale hacia los clientes. Contadores en vivo por API RouterOS.</p>
        <button className="help-dot" style={{ width: 17, height: 17 }} onClick={onHelp}>!</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 20 }}>
        {kpis.map((k) => (
          <div key={k.label} style={{ background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 10, padding: '9px 10px' }}>
            <div style={{ fontSize: 9.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.4px', whiteSpace: 'nowrap' }}>{k.label}</div>
            <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: k.color, marginTop: 3 }}>{k.value}</div>
          </div>
        ))}
      </div>

      <div style={{ position: 'relative', paddingLeft: 2 }}>
        <div style={{ position: 'absolute', left: 19, top: 16, bottom: 16, width: 2, background: 'linear-gradient(var(--accent),#8b5bff)', opacity: 0.35, overflow: 'hidden' }}>
          {[0, 0.8, 1.6].map((delay, i) => (
            <span key={i} style={{ position: 'absolute', left: -3, width: 8, height: 8, borderRadius: '50%', background: i === 2 ? 'var(--up)' : i === 1 ? '#8b5bff' : 'var(--accent)', boxShadow: `0 0 8px ${i === 2 ? 'var(--up)' : i === 1 ? '#8b5bff' : 'var(--accent)'}`, animation: `pktdown 2.4s linear infinite`, animationDelay: `${delay}s` }} />
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {stages.map((st) => (
            <div key={st.tag} style={{ display: 'flex', gap: 14, alignItems: 'stretch' }}>
              <div style={{ width: 40, flexShrink: 0, display: 'flex', justifyContent: 'center', position: 'relative', zIndex: 2, paddingTop: 14 }}>
                <span style={{ width: 30, height: 30, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--panel3)', border: `1.5px solid ${st.accent}`, color: st.accent }}>
                  <Icon path={st.icon} size={14} strokeWidth={2} />
                </span>
              </div>
              <div style={{ flex: 1, minWidth: 0, background: 'var(--panel2)', border: '1px solid var(--border)', borderLeft: `3px solid ${st.accent}`, borderRadius: 11, padding: '11px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{st.title}</span>
                  <span className="mono" style={{ fontSize: 9.5, color: 'var(--muted)', background: 'var(--panel3)', borderRadius: 5, padding: '1px 6px' }}>{st.tag}</span>
                  <span style={{ flex: 1 }} />
                  <span className="mono" style={{ fontSize: 11.5, fontWeight: 600, color: st.statColor }}>{st.stat}</span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text2)', lineHeight: 1.5, marginTop: 4 }}>{st.desc}</div>
                {st.isQueue && flow.queues.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 11 }}>
                    {flow.queues.slice(0, 6).map((q) => {
                      const pct = q.limitMbps ? Math.min(100, Math.round((q.usedMbps / q.limitMbps) * 100)) : 0;
                      const col = q.down ? 'var(--down)' : pct > 85 ? 'var(--warn)' : 'var(--up)';
                      return (
                        <div key={q.name}>
                          <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, marginBottom: 3 }}>
                            <span style={{ color: 'var(--text2)' }}>{q.name}</span>
                            <span style={{ color: col }}>{q.down ? 'caído' : `${q.usedMbps} Mbps`}{q.limitMbps ? ` / ${q.limitMbps}` : ''}</span>
                          </div>
                          <div style={{ height: 6, borderRadius: 4, background: 'var(--panel3)', overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${q.down ? 0 : pct}%`, borderRadius: 4, background: col, backgroundImage: 'linear-gradient(90deg,rgba(255,255,255,.25) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.25) 50%,rgba(255,255,255,.25) 75%,transparent 75%)', backgroundSize: '22px 22px', animation: 'barflow .8s linear infinite' }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {st.isQueue && flow.queues.length === 0 && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>Sin simple queues configuradas en este router.</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
