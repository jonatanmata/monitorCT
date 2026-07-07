import { useState } from 'react';
import { api } from '../api';
import { Icon } from './meta';

type Audit = Awaited<ReturnType<typeof api.audit>>;

const SEV = {
  critical: { color: 'var(--down)', soft: 'var(--downSoft)', label: 'Crítico', icon: 'M12 3l9 16H3zM12 10v4M12 17h.01' },
  warning: { color: 'var(--warn)', soft: 'var(--warnSoft)', label: 'Advertencia', icon: 'M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' },
  info: { color: 'var(--accent)', soft: 'var(--accentSoft)', label: 'Info', icon: 'M12 16v-4M12 8h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z' },
  ok: { color: 'var(--up)', soft: 'var(--upSoft)', label: 'OK', icon: 'M20 6L9 17l-5-5' },
} as const;

const ORDER = { critical: 0, warning: 1, info: 2, ok: 3 };

export function ConfigAudit({ nodeId }: { nodeId: number }) {
  const [audit, setAudit] = useState<Audit | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try { setAudit(await api.audit(nodeId)); }
    catch (err) { setAudit({ supported: false, note: String(err) }); }
    finally { setBusy(false); }
  };

  const findings = (audit?.findings ?? []).slice().sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 11, padding: 13, marginBottom: 14 }}>
        <Icon path="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" size={18} stroke="var(--accent)" strokeWidth={1.8} style={{ flexShrink: 0, marginTop: 1 }} />
        <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.55 }}>Auditoría de configuración RouterOS (solo lectura). Busca lo que puede esconder o causar la pérdida en hora pico: <b>FastTrack</b>, ausencia de QoS, MSS clamp, conntrack, CPU y dúplex de puertos.</div>
      </div>
      <button className="btn btn-block" style={{ marginBottom: 14 }} onClick={run} disabled={busy}>
        <Icon path={busy ? 'M21 12a9 9 0 1 1-6.2-8.5' : 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4'} size={16} strokeWidth={2} style={busy ? { animation: 'spin 1s linear infinite' } : undefined} />
        {busy ? 'Auditando…' : audit ? 'Volver a auditar' : 'Auditar configuración'}
      </button>

      {audit && !audit.supported && <div className="status-line fail">{audit.note}</div>}

      {audit?.supported && (
        <>
          {audit.facts && (
            <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 12 }}>
              {audit.facts.board} · RouterOS {audit.facts.version} · CPU {audit.facts.cpuPct}% · mem {audit.facts.memPct}% · uptime {audit.facts.uptime}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {findings.map((f, i) => {
              const s = SEV[f.severity];
              return (
                <div key={i} style={{ background: 'var(--panel2)', border: '1px solid var(--border)', borderLeft: `3px solid ${s.color}`, borderRadius: 11, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                    <span style={{ width: 24, height: 24, borderRadius: 7, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: s.soft, color: s.color }}>
                      <Icon path={s.icon} size={14} strokeWidth={2} />
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{f.title}</span>
                    <span className="chip" style={{ background: s.soft, color: s.color }}>{f.area}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.55, marginTop: 8 }}>{f.detail}</div>
                  {f.recommendation && (
                    <div style={{ marginTop: 9, background: 'var(--panel3)', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 11px', fontSize: 12, color: 'var(--text2)', lineHeight: 1.55 }}>
                      <span style={{ color: s.color, fontWeight: 600 }}>Recomendación: </span>{f.recommendation}
                    </div>
                  )}
                </div>
              );
            })}
            {findings.length === 0 && <div className="empty-hint">Sin hallazgos.</div>}
          </div>
        </>
      )}
    </div>
  );
}
