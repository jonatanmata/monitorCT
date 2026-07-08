import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { ApiNode, LiveNode } from '../types';
import { Icon, ICONS, typeMeta } from '../ui/meta';

/** Estado en vivo de un miembro, para la lista y el peor-estado del grupo. */
export interface GroupMember { node: ApiNode; live: LiveNode | null }

export type GroupNodeData = {
  container: ApiNode;
  members: GroupMember[];
  worst: 'up' | 'warning' | 'down' | 'unknown';
  collapsed: boolean;
  onOpen: (id: number) => void;
  onSelectMember: (id: number) => void;
  onToggleCollapse: (id: number) => void;
};

export type GroupFlowNode = Node<GroupNodeData, 'group'>;

const STATUS_COLOR: Record<string, string> = {
  up: 'var(--up)', warning: 'var(--warn)', down: 'var(--down)', unknown: 'var(--muted)',
};

export function GroupNode({ data, selected }: NodeProps<GroupFlowNode>) {
  const { container, members, worst, collapsed, onOpen, onSelectMember, onToggleCollapse } = data;
  const meta = typeMeta(container.type);
  const worstColor = STATUS_COLOR[worst];

  return (
    <div className={`group-card ${selected ? 'selected' : ''} ${collapsed ? 'collapsed' : ''}`}>
      {/* Handles del contenedor (conectar el rack/torre como un todo). */}
      <Handle type="target" position={Position.Left} id="c" />
      <Handle type="source" position={Position.Right} id="c" />
      <div className="group-head">
        <button
          className="group-collapse"
          title={collapsed ? 'Expandir equipos' : 'Colapsar equipos'}
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(container.id); }}
        >
          <Icon path={collapsed ? 'M9 6l6 6-6 6' : 'M6 9l6 6 6-6'} size={12} strokeWidth={2} />
        </button>
        <span className="group-ico" style={{ color: meta.color }}>
          <Icon path={ICONS[meta.icon]} size={15} strokeWidth={1.8} />
        </span>
        <span className="group-name">{container.name}</span>
        <span className="group-count">{members.length}{container.type === 'rack' ? 'u' : ''}</span>
        <span className="node-dot" style={{ background: worstColor, animation: worst === 'down' ? 'blink 1.4s infinite' : undefined }} />
        <button
          className="group-open"
          title="Abrir en vista física"
          onClick={(e) => { e.stopPropagation(); onOpen(container.id); }}
        >
          <Icon path="M9 18l6-6-6-6" size={12} strokeWidth={2} />
        </button>
      </div>
      {!collapsed && (
      <div className="group-body">
        {members.length === 0 && <div className="group-empty">Vacío · añade equipos</div>}
        {members.map((m) => {
          const mm = typeMeta(m.node.type);
          const st = m.node.type === 'monitor' ? 'up' : m.live?.status ?? 'unknown';
          // Cada equipo es seleccionable y conectable individualmente (handles por fila).
          return (
            <div
              key={m.node.id}
              className="group-member"
              title={`Conectar a ${m.node.name}`}
              onClick={(e) => { e.stopPropagation(); onSelectMember(m.node.id); }}
            >
              <Handle type="target" position={Position.Left} id={`m-${m.node.id}`} className="group-member-handle" />
              <span className="group-member-bar" style={{ background: mm.color }} />
              <span className="group-member-name">{m.node.name}</span>
              <span className="node-dot" style={{ width: 7, height: 7, background: STATUS_COLOR[st] }} />
              <Handle type="source" position={Position.Right} id={`m-${m.node.id}`} className="group-member-handle" />
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}
