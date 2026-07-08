import { useEffect, useState } from 'react';
import type { ApiNode, OnuMeta } from '../types';
import { api } from '../api';

type Budget = Awaited<ReturnType<typeof api.ponBudget>>;

/** Umbral de calidad de la potencia recibida (dBm). Bueno > -25, aviso -25..sens, malo < sens. */
function rxColor(rx: number, sens: number): string {
  if (rx > -25) return 'var(--up)';
  if (rx > sens) return 'var(--warn)';
  return 'var(--down)';
}

export function OnuBudget({ node }: { node: ApiNode }) {
  const [b, setB] = useState<Budget | null>(null);
  const [busy, setBusy] = useState(false);
  const sens = ((node.meta ?? {}) as OnuMeta).rxSensitivityDbm ?? -27;

  const load = () => { setBusy(true); api.ponBudget(node.id).then(setB).catch(() => setB(null)).finally(() => setBusy(false)); };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [node.id]);

  if (busy && !b) return <div className="empty-hint">Calculando potencia…</div>;
  if (!b) return <div className="status-line fail">No se pudo calcular.</div>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <p className="card-sub" style={{ margin: 0 }}>Potencia óptica estimada recibida, calculada desde la OLT restando fibra, conectores y splitters.</p>
        <button className="btn" style={{ flexShrink: 0 }} onClick={load} disabled={busy}>{busy ? '…' : 'Recalcular'}</button>
      </div>

      {!b.supported ? (
        <div className="status-line pending">{b.note ?? 'No hay un camino de fibra hasta una OLT.'}</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
            <div style={{ background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ fontSize: 9.5, color: 'var(--muted)', textTransform: 'uppercase' }}>Tx OLT</div>
              <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--accent)' }}>{b.txDbm} dBm</div>
            </div>
            <div style={{ background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ fontSize: 9.5, color: 'var(--muted)', textTransform: 'uppercase' }}>Pérdida</div>
              <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--text2)' }}>−{b.totalLossDb} dB</div>
            </div>
            <div style={{ background: 'var(--panel2)', border: `1px solid ${rxColor(b.rxDbm!, sens)}`, borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ fontSize: 9.5, color: 'var(--muted)', textTransform: 'uppercase' }}>Rx ONU</div>
              <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: rxColor(b.rxDbm!, sens) }}>{b.rxDbm} dBm</div>
            </div>
          </div>

          {b.warnings.map((w, i) => <div key={i} className="status-line pending" style={{ marginTop: 0, marginBottom: 8 }}>{w}</div>)}

          <div className="field-label" style={{ marginBottom: 6 }}>Desglose por salto</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {b.hops.map((h, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 11px' }}>
                <span className="chip" style={{ background: 'var(--panel3)', color: 'var(--text2)' }}>{h.kind}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.node}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>{h.detail}</div>
                </div>
                {h.lossDb > 0 && <span className="mono" style={{ fontSize: 12, color: 'var(--down)' }}>−{h.lossDb} dB</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
