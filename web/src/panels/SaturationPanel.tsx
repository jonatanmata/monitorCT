import { useEffect, useState } from 'react';
import type { LossMatrixCell, HourlyRow, ApiEdge, ApiNode } from '../types';
import { api } from '../api';
import { InfoTip } from '../components/InfoTip';

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

export function SaturationPanel({ edges, nodes, focusStart }: { edges: ApiEdge[]; nodes: ApiNode[]; focusStart: number | null }) {
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
      {focusStart && (
        <div className="focus-note">
          🎯 Modo enfoque: mostrando solo datos desde {new Date(focusStart * 1000).toLocaleString('es-CO')}
        </div>
      )}
      <h3>
        Matriz de pérdida (24 h) — origen → destino externo
        <InfoTip text="Cada fila es un par «desde dónde se hace ping → hacia qué IP de internet» con su pérdida promedio de las últimas 24 h. Cómo leerla: si el PC de monitoreo y los pings con IP de origen LAN («Src») pierden, pero el ping por defecto de los routers no, la pérdida está en el camino de reenvío (colas/saturación de un enlace), NO en el proveedor. Si TODOS los orígenes pierden, incluso los routers, el problema está aguas arriba (el dedicado o el ISP). Verde <2%, amarillo 2–10%, rojo >10%." />
      </h3>
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

      <h3>
        Pérdida por hora del día (7 días) vs utilización
        <InfoTip text="Confirma o descarta la hipótesis de horas pico: cada celda es una hora del día (0–23) con la pérdida promedio hacia internet de los últimos 7 días. Pasa el mouse sobre una celda para ver también la utilización promedio del enlace seleccionado en esa hora. Si las celdas rojas coinciden con utilización alta (ej. 18:00–22:00), es saturación — hay que ampliar capacidad o priorizar tráfico. Si la pérdida es pareja a toda hora, apunta a un problema físico (cable, RF, interferencia)." />
      </h3>
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
        Verde = sin pérdida, rojo = pérdida alta. Pasa el mouse sobre cada celda para el detalle.
      </p>
    </div>
  );
}
