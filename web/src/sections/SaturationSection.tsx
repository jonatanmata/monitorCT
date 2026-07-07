import { useEffect, useMemo, useState } from 'react';
import type { LossMatrixCell, HourlyRow, ApiEdge, ApiNode } from '../types';
import { api } from '../api';
import { Icon } from '../ui/meta';

function lossColor(v: number): { c: string; soft: string } {
  if (v < 1) return { c: 'var(--up)', soft: 'var(--upSoft)' };
  if (v < 5) return { c: 'var(--warn)', soft: 'var(--warnSoft)' };
  return { c: 'var(--down)', soft: 'var(--downSoft)' };
}

export function SaturationSection({ edges, nodes, focusStart, onHelp }: { edges: ApiEdge[]; nodes: ApiNode[]; focusStart: number | null; onHelp: () => void }) {
  const [matrix, setMatrix] = useState<LossMatrixCell[]>([]);
  const [hourly, setHourly] = useState<HourlyRow[]>([]);
  const [edgeId, setEdgeId] = useState<number | null>(null);
  const nodeName = (id: number) => nodes.find((n) => n.id === id)?.name ?? `#${id}`;

  useEffect(() => {
    const load = () => {
      api.lossMatrix(24).then((r) => setMatrix(r.matrix)).catch(() => {});
      api.correlation(edgeId, 7).then((r) => setHourly(r.hourly)).catch(() => {});
    };
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [edgeId]);

  // Pivotar la matriz plana en filas (origen) × columnas (destino).
  const { cols, rows } = useMemo(() => {
    const cols = Array.from(new Set(matrix.map((c) => c.target)));
    const rowKeys = new Map<string, { label: string }>();
    for (const c of matrix) {
      const key = c.originName + (c.srcAddress ? ` (${c.srcAddress})` : '');
      if (!rowKeys.has(key)) rowKeys.set(key, { label: key });
    }
    const rows = Array.from(rowKeys.entries()).map(([key, { label }]) => ({
      label,
      cells: cols.map((target) => {
        const cell = matrix.find((c) => (c.originName + (c.srcAddress ? ` (${c.srcAddress})` : '')) === key && c.target === target);
        return cell ? { v: cell.avgLossPct, samples: cell.samples } : null;
      }),
    }));
    return { cols, rows };
  }, [matrix]);

  return (
    <div className="section-scroll">
      <div style={{ maxWidth: 1150, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
        {focusStart && (
          <div className="focus-banner-row">
            <Icon path="M12 2v4M12 18v4M2 12h4M18 12h4" size={14} stroke="var(--accent)" strokeWidth={2} />
            Modo enfoque: mostrando solo datos desde {new Date(focusStart * 1000).toLocaleString('es-CO')}.
          </div>
        )}

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 4 }}>
            <h3>Matriz de pérdida origen → destino</h3>
            <button className="help-dot" style={{ width: 17, height: 17 }} onClick={onHelp}>!</button>
          </div>
          <p className="card-sub">Pérdida de paquetes (%) medida desde cada punto hacia cada target de internet (últimas 24 h).</p>
          {matrix.length === 0 ? (
            <div className="empty-hint">Aún no hay sondas. Configura targets externos en cada MikroTik (drawer del nodo) y en Ajustes los del PC.</div>
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table className="matrix">
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '0 8px' }} />
                      {cols.map((c) => (
                        <th key={c} style={{ fontSize: 10.5, color: 'var(--text2)', fontWeight: 600, padding: '0 4px 6px', textAlign: 'center', whiteSpace: 'nowrap' }}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.label}>
                        <td style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 500, paddingRight: 8, whiteSpace: 'nowrap' }}>{r.label}</td>
                        {r.cells.map((cell, i) => {
                          if (!cell) return <td key={i}><div style={{ width: 62, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 11 }}>—</div></td>;
                          const { c, soft } = lossColor(cell.v);
                          return (
                            <td key={i}>
                              <div
                                title={`${r.label} → ${cols[i]}: ${cell.v.toFixed(1)}% (${cell.samples} muestras)`}
                                style={{ width: 62, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, background: soft, color: c, fontSize: 12, fontWeight: 600, border: `1px solid ${c}`, opacity: 0.55 + Math.min(0.45, cell.v / 12) }}
                              >
                                {cell.v.toFixed(1)}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, fontSize: 10.5, color: 'var(--muted)' }}>
                <span>Pérdida:</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 14, height: 14, borderRadius: 4, background: 'var(--up)' }} />&lt;1%</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 14, height: 14, borderRadius: 4, background: 'var(--warn)' }} />1–5%</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 14, height: 14, borderRadius: 4, background: 'var(--down)' }} />&gt;5%</span>
              </div>
            </>
          )}
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <h3 style={{ marginBottom: 4 }}>Pérdida por hora del día vs utilización</h3>
            <select className="inp sans" style={{ width: 'auto' }} value={edgeId ?? ''} onChange={(e) => setEdgeId(e.target.value ? parseInt(e.target.value, 10) : null)}>
              <option value="">Todos los enlaces</option>
              {edges.map((e) => (
                <option key={e.id} value={e.id}>{e.label || `${nodeName(e.source_id)} → ${nodeName(e.target_id)}`}</option>
              ))}
            </select>
          </div>
          <p className="card-sub">Cada celda es una hora (0–23) con la pérdida media hacia internet de los últimos 7 días. Pasa el mouse para ver la utilización del enlace en esa hora.</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24,1fr)', gap: 3 }}>
            {hourly.map((h) => {
              const { soft, c } = lossColor(h.avgLossPct);
              const has = h.samples > 0;
              return (
                <div
                  key={h.hour}
                  title={`${String(h.hour).padStart(2, '0')}:00 · pérdida ${h.avgLossPct}%${h.avgUtilizationPct !== null ? ` · util ${h.avgUtilizationPct}%` : ''} (${h.samples} muestras)`}
                  style={{ height: 30, borderRadius: 4, background: has ? soft : 'var(--panel2)', border: `1px solid ${has && h.avgLossPct >= 1 ? c : 'var(--border)'}`, opacity: has ? 0.5 + Math.min(0.5, h.avgLossPct / 8) : 0.5 }}
                />
              );
            })}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24,1fr)', gap: 3, marginTop: 5 }}>
            {hourly.map((h) => (
              <span key={h.hour} className="mono" style={{ fontSize: 8.5, color: 'var(--muted)', textAlign: 'center' }}>{h.hour % 3 === 0 ? String(h.hour).padStart(2, '0') : ''}</span>
            ))}
          </div>
          <div style={{ textAlign: 'center', fontSize: 10, color: 'var(--muted)', marginTop: 6 }}>hora del día</div>
        </div>
      </div>
    </div>
  );
}
