import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { ApiNode, LiveNode } from '../types';
import { Icon, ICONS, TYPE_META } from '../ui/meta';

export type DeviceNodeData = {
  node: ApiNode;
  live: LiveNode | null;
};

export type DeviceFlowNode = Node<DeviceNodeData, 'device'>;

const STATUS_COLOR: Record<string, string> = {
  up: 'var(--up)', warning: 'var(--warn)', down: 'var(--down)', unknown: 'var(--muted)',
};

const SUMMARY_META: Record<string, { k: string; unit: string }> = {
  cpu_pct: { k: 'cpu', unit: '%' },
  signal_dbm: { k: 'sig', unit: '' },
  ccq_pct: { k: 'ccq', unit: '%' },
  snr_db: { k: 'snr', unit: '' },
  stations: { k: 'sta', unit: '' },
};

export function DeviceNode({ data, selected }: NodeProps<DeviceFlowNode>) {
  const { node, live } = data;
  const isMonitor = node.type === 'monitor';
  const status = isMonitor ? 'up' : live?.status ?? 'unknown';
  const meta = TYPE_META[node.type];
  const color = STATUS_COLOR[status];

  const metrics: { k: string; v: string }[] = [];
  if (!isMonitor) {
    if (live?.latencyMs != null) metrics.push({ k: 'lat', v: `${live.latencyMs.toFixed(0)}ms` });
    if (live?.lossPct != null && live.lossPct > 0) metrics.push({ k: 'pérd', v: `${live.lossPct}%` });
    for (const [key, { k, unit }] of Object.entries(SUMMARY_META)) {
      const v = live?.summary?.[key];
      if (v !== undefined && metrics.length < 3) metrics.push({ k, v: `${v}${unit}` });
    }
  }

  return (
    <div className={`node-card ${selected ? 'selected' : ''}`}>
      {status !== 'unknown' && (
        <div
          className="node-ring"
          style={{ boxShadow: `0 0 0 1.5px ${color}`, opacity: status === 'down' ? 0.9 : 0.55 }}
        />
      )}
      {!isMonitor && <Handle type="target" position={Position.Left} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="node-ico" style={{ color: meta.color }}>
          <Icon path={ICONS[meta.icon]} size={17} strokeWidth={1.85} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="node-name">{node.name}</div>
          <div className="node-ip">{isMonitor ? 'raíz de la red' : node.ip || 'sin IP'}</div>
        </div>
        <span className="node-dot" style={{ background: color, animation: status === 'down' ? 'blink 1.4s infinite' : undefined }} />
      </div>
      {metrics.length > 0 && (
        <div className="node-metrics">
          {metrics.map((m, i) => (
            <span key={i} className="node-metric"><b>{m.k}</b>{m.v}</span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
