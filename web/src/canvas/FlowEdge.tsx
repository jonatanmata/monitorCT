import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';

export type FlowEdgeData = {
  label?: string;
  /** Estado de salud del enlace, derivado del nodo destino: up | warning | down | unknown */
  health?: 'up' | 'warning' | 'down' | 'unknown';
  /** Abre el menú para insertar un equipo en este enlace ("romper el hilo"). */
  onInsert?: (edgeId: string, x: number, y: number) => void;
};

const COLOR: Record<string, string> = {
  up: 'var(--up)',
  warning: 'var(--warn)',
  down: 'var(--down)',
  unknown: 'var(--muted)',
};

/**
 * Arista con efecto de flujo estilo diseño v2: una línea base tenue coloreada por
 * la salud del enlace más una línea punteada animada (dashflow) que muestra la
 * dirección del tráfico. En estado "down" el flujo se detiene.
 */
export function FlowEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });
  const d = (data ?? {}) as FlowEdgeData;
  const health = d.health ?? 'unknown';
  const color = COLOR[health];
  const flowing = health !== 'down';

  return (
    <>
      {/* base tenue */}
      <BaseEdge
        id={id}
        path={path}
        style={{ stroke: color, strokeWidth: selected ? 3.5 : 3, opacity: 0.5 }}
      />
      {/* flujo animado */}
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray="7 9"
        style={{
          animation: flowing ? 'dashflow 0.9s linear infinite' : undefined,
          opacity: 0.95,
          filter: selected ? `drop-shadow(0 0 6px ${color})` : undefined,
        }}
      />
      <EdgeLabelRenderer>
        {d.label && (
          <div
            className="mono"
            style={{
              position: 'absolute',
              transform: `translate(-50%, calc(-50% - 15px)) translate(${labelX}px, ${labelY}px)`,
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '1px 7px',
              fontSize: 10,
              color: 'var(--text2)',
              pointerEvents: 'none',
            }}
          >
            {d.label}
          </div>
        )}
        {d.onInsert && (
          <button
            className="edge-plus"
            title="Insertar un equipo aquí (romper el hilo)"
            style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={(e) => {
              e.stopPropagation();
              d.onInsert!(id, e.clientX, e.clientY);
            }}
          >
            +
          </button>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
