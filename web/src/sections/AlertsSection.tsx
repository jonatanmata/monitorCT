import { useEffect, useMemo, useState } from 'react';
import type { Alert } from '../types';
import { api } from '../api';
import { Icon } from '../ui/meta';

function relTime(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return 'hace segundos';
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

const SEV = {
  critical: { label: 'Crítica', color: 'var(--down)', soft: 'var(--downSoft)', icon: 'M12 3l9 16H3zM12 10v4M12 17h.01' },
  warning: { label: 'Advertencia', color: 'var(--warn)', soft: 'var(--warnSoft)', icon: 'M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' },
  info: { label: 'Info', color: 'var(--accent)', soft: 'var(--accentSoft)', icon: 'M12 16v-4M12 8h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z' },
} as const;

// Mapea sliders del diseño a las claves reales de umbral del backend.
const TH_DEF: { key: string; label: string; min: number; max: number; step: number; unit: string }[] = [
  { key: 'cpuPct', label: 'CPU alta', min: 50, max: 95, step: 1, unit: '%' },
  { key: 'signalDbm', label: 'Señal baja', min: -85, max: -55, step: 1, unit: ' dBm' },
  { key: 'lossPct', label: 'Pérdida alta', min: 1, max: 20, step: 0.5, unit: '%' },
  { key: 'latencyMs', label: 'Latencia alta', min: 20, max: 500, step: 10, unit: ' ms' },
  { key: 'crcErrorsPer5min', label: 'Errores CRC', min: 1, max: 50, step: 1, unit: '/5min' },
  { key: 'utilizationPct', label: 'Saturación', min: 40, max: 95, step: 1, unit: '%' },
  { key: 'saturationLossPct', label: 'Pérdida p/ saturación', min: 1, max: 20, step: 0.5, unit: '%' },
];

export function AlertsSection({ refreshKey, focusStart, onHelp }: { refreshKey: number; focusStart: number | null; onHelp: () => void }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [filter, setFilter] = useState<'open' | 'all' | 'resolved'>('open');
  const [thresholds, setThresholds] = useState<Record<string, number>>({});

  useEffect(() => {
    const load = () => api.alerts().then((r) => setAlerts(r.alerts)).catch(() => {});
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [refreshKey]);

  useEffect(() => { api.settings().then((s) => setThresholds(s.thresholds)).catch(() => {}); }, []);

  const setThreshold = (key: string, value: number) => {
    setThresholds((prev) => {
      const next = { ...prev, [key]: value };
      void api.saveSettings({ thresholds: next });
      return next;
    });
  };

  const list = useMemo(
    () => alerts.filter((a) => (filter === 'all' ? true : filter === 'open' ? !a.resolved_at : !!a.resolved_at)),
    [alerts, filter],
  );

  const resolve = (id: number) => void api.resolveAlert(id).then(() => api.alerts().then((r) => setAlerts(r.alerts)));

  return (
    <div className="section-scroll">
      {focusStart && (
        <div className="focus-banner-row">
          <Icon path="M12 2v4M12 18v4M2 12h4M18 12h4" size={14} stroke="var(--accent)" strokeWidth={2} />
          Modo enfoque: solo alertas desde {new Date(focusStart * 1000).toLocaleString('es-CO')} (más las abiertas).
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 20, maxWidth: 1200, margin: '0 auto', alignItems: 'start' }}>
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {(['open', 'all', 'resolved'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                style={{
                  padding: '7px 15px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5,
                  border: `1px solid ${filter === k ? 'var(--border2)' : 'var(--border)'}`,
                  background: filter === k ? 'var(--accentSoft)' : 'transparent',
                  color: filter === k ? 'var(--accent)' : 'var(--text2)',
                  fontWeight: filter === k ? 600 : 500,
                }}
              >
                {k === 'open' ? 'Abiertas' : k === 'all' ? 'Todas' : 'Resueltas'}
              </button>
            ))}
          </div>

          {list.length === 0 ? (
            <div className="empty-hint">Sin alertas en esta vista. Cuando se supere un umbral aparecerán aquí con su diagnóstico IA.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {list.map((a) => {
                const m = SEV[a.severity];
                const open = !a.resolved_at;
                return (
                  <div key={a.id} style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderLeft: `3px solid ${open ? m.color : 'var(--border2)'}`, borderRadius: 12, padding: '15px 17px', opacity: open ? 1 : 0.75 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                      <span style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: m.soft, color: m.color }}>
                        <Icon path={m.icon} size={16} strokeWidth={2} />
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 14, fontWeight: 600 }}>{a.message}</span>
                          <span className="chip" style={{ background: m.soft, color: m.color }}>{m.label}</span>
                          <span className="chip" style={{ background: open ? 'var(--downSoft)' : 'var(--upSoft)', color: open ? 'var(--down)' : 'var(--up)' }}>{open ? 'Abierta' : 'Resuelta'}</span>
                        </div>
                        <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                          {a.node_name || a.type} · {relTime(a.created_at)}
                        </div>
                        {a.ai_diagnosis && (
                          <div style={{ marginTop: 11, background: 'var(--panel3)', border: '1px solid var(--border)', borderRadius: 9, padding: '11px 12px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                              <Icon path="M12 2l1.9 5.6L19.5 9l-4.3 3.4L16.5 18 12 14.7 7.5 18l1.3-5.6L4.5 9l5.6-1.4z" size={14} fill="var(--accent)" stroke="none" />
                              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)' }}>Diagnóstico IA</span>
                            </div>
                            <div style={{ fontSize: 12.5, color: 'var(--text2)', lineHeight: 1.6 }}>{a.ai_diagnosis}</div>
                          </div>
                        )}
                      </div>
                    </div>
                    {open && (
                      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                        <button className="btn" onClick={() => resolve(a.id)}>Resolver manualmente</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card" style={{ position: 'sticky', top: 0, padding: '16px 17px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Umbrales de alerta</h3>
            <button className="help-dot" style={{ width: 16, height: 16, fontSize: 10 }} onClick={onHelp}>!</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {TH_DEF.map((t) => {
              const value = thresholds[t.key] ?? t.min;
              return (
                <div key={t.key}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 7 }}>
                    <span style={{ color: 'var(--text2)' }}>{t.label}</span>
                    <span className="mono" style={{ fontWeight: 600, color: 'var(--accent)' }}>{value}{t.unit}</span>
                  </div>
                  <input
                    className="range" type="range" min={t.min} max={t.max} step={t.step} value={value}
                    onChange={(e) => setThreshold(t.key, parseFloat(e.target.value))}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
