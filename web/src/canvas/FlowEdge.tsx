import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';

export type FlowEdgeData = {
  label?: string;
  /** Estado de salud del enlace, derivado del nodo destino: up | warning | down | unknown */
  health?: 'up' | 'warning' | 'down' | 'unknown';
  /** Abre el menú para insertar un equipo en este enlace ("romper el hilo"). */
  onInsert?: (edgeId: string, x: number, y: number) => void;
};

const COLOR: Record<string, string> = {
  up: '#10b981',
  warning: '#f59e0b',
  down: '#f43f5e',
  unknown: '#5d6980',
};

/**
 * Arista con efecto de flujo: una línea base coloreada por la salud del enlace
 * más un punto animado que viaja del origen al destino, mostrando la dirección
 * del tráfico. En estado "down" el flujo se detiene.
 */
export function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  });
  const d = (data ?? {}) as FlowEdgeData;
  const health = d.health ?? 'unknown';
  const color = COLOR[health];
  const flowing = health !== 'down';

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: color,
          strokeWidth: selected ? 3.5 : 2.2,
          opacity: health === 'unknown' ? 0.5 : 0.9,
          filter: selected ? `drop-shadow(0 0 6px ${color})` : undefined,
          transition: 'stroke 0.3s',
        }}
      />
      {flowing && (
        <circle r={3.4} fill={color} opacity={0.95}>
          <animateMotion dur={health === 'warning' ? '2.6s' : '1.8s'} repeatCount="indefinite" path={path} />
        </circle>
      )}
      <EdgeLabelRenderer>
        {d.label && (
          <div
            className="edge-label"
            style={{ transform: `translate(-50%, calc(-50% - 14px)) translate(${labelX}px, ${labelY}px)` }}
          >
            {d.label}
          </div>
        )}
        {d.onInsert && (
          <button
            className="edge-insert-btn"
            title="Insertar un equipo aquí (romper el hilo)"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
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
