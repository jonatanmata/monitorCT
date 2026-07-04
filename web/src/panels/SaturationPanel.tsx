import { useEffect, useState } from 'react';
import type { LossMatrixCell, HourlyRow, ApiEdge, ApiNode } from '../types';
import { api } from '../api';

function lossClass(pct: number): string {
  if (pct >= 10) return 'loss-bad';
  if (pct >= 2) return 'loss-mid';
  return 'loss-good';
}

function heatColor(loss: number): string {
  if (loss <= 0.5) return '#14532d';
  if (loss <= 2) return '#4d7c0f';
  if (loss <= 5) return '#a16207';
  if (loss <= 10) return '#c2410c';
  return '#991b1b';
}

export function SaturationPanel({ edges, nodes }: { edges: ApiEdge[]; nodes: ApiNode[] }) {
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

  return (
    <div>
      <h3>Matriz de pérdida (24 h) — origen → destino externo</h3>
      <p className="small">
        Compara qué orígenes pierden hacia internet. Si el PC y los pings con IP de origen LAN pierden pero
        el ping normal del router no, la causa está en el camino de reenvío (colas/saturación), no en el ISP.
      </p>
      {matrix.length === 0 ? (
        <div className="empty-hint">
          Aún no hay sondas. Configura targets externos en cada MikroTik (panel del nodo) y en Ajustes los del PC.
        </div>
      ) : (
        <table className="matrix-table">
          <thead>
            <tr><th>Origen</th><th>Src</th><th>Destino</th><th>Pérdida</th><th>Lat.</th><th>N</th></tr>
          </thead>
          <tbody>
            {matrix.map((c, i) => (
              <tr key={i}>
                <td>{c.originName}</td>
                <td className="small">{c.srcAddress || '(defecto)'}</td>
                <td>{c.target}</td>
                <td className={lossClass(c.avgLossPct)}>{c.avgLossPct}%</td>
                <td>{c.avgMs !== null ? `${c.avgMs} ms` : '—'}</td>
                <td className="small">{c.samples}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Pérdida por hora del día (7 días) vs utilización</h3>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label className="small">Enlace:</label>
        <select value={edgeId ?? ''} onChange={(e) => setEdgeId(e.target.value ? parseInt(e.target.value, 10) : null)}>
          <option value="">Todos</option>
          {edges.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label || `${nodeName(e.source_id)} → ${nodeName(e.target_id)}`}
            </option>
          ))}
        </select>
      </div>
      <div className="heatmap">
        {hourly.map((h) => (
          <div
            key={h.hour}
            className="cell"
            style={{ background: h.samples > 0 ? heatColor(h.avgLossPct) : '#1e293b' }}
            title={`${h.hour}:00 — pérdida ${h.avgLossPct}%${h.avgUtilizationPct !== null ? `, utilización ${h.avgUtilizationPct}%` : ''} (${h.samples} muestras)`}
          >
            {h.hour}
          </div>
        ))}
      </div>
      <p className="small">
        Cada celda es una hora del día (0–23). Verde = sin pérdida, rojo = pérdida alta. Pasa el mouse para ver
        la utilización promedio del enlace en esa hora — si pérdida y utilización suben juntas en horas pico,
        es saturación.
      </p>
    </div>
  );
}
