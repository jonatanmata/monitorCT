import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { ApiNode, LiveNode } from '../types';
import { NODE_TYPE_ICONS } from '../types';

export type DeviceNodeData = {
  node: ApiNode;
  live: LiveNode | null;
};

export type DeviceFlowNode = Node<DeviceNodeData, 'device'>;

const SUMMARY_LABELS: Record<string, { label: string; unit: string }> = {
  cpu_pct: { label: 'CPU', unit: '%' },
  signal_dbm: { label: 'Señal', unit: ' dBm' },
  ccq_pct: { label: 'CCQ', unit: '%' },
  snr_db: { label: 'SNR', unit: ' dB' },
  stations: { label: 'Estac.', unit: '' },
};

export function DeviceNode({ data, selected }: NodeProps<DeviceFlowNode>) {
  const { node, live } = data;
  const isMonitor = node.type === 'monitor';
  const status = isMonitor ? 'up' : live?.status ?? 'unknown';
  const chips: string[] = [];
  if (isMonitor) {
    return (
      <div className={`device-node monitor-node status-up ${selected ? 'selected' : ''}`}>
        <div className="dn-header">
          <span className="dn-icon">{NODE_TYPE_ICONS.monitor}</span>
          <span className="dn-title">{node.name}</span>
          <span className="dn-dot up" />
        </div>
        <div className="dn-ip">Raíz de la red · sondas del PC</div>
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }
  if (live?.latencyMs != null) chips.push(`${live.latencyMs.toFixed(0)} ms`);
  if (live?.lossPct != null && live.lossPct > 0) chips.push(`pérd ${live.lossPct}%`);
  for (const [key, { label, unit }] of Object.entries(SUMMARY_LABELS)) {
    const v = live?.summary?.[key];
    if (v !== undefined) chips.push(`${label} ${v}${unit}`);
  }

  return (
    <div className={`device-node status-${status} ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="dn-header">
        <span className="dn-icon">{NODE_TYPE_ICONS[node.type]}</span>
        <span className="dn-title">{node.name}</span>
        <span className={`dn-dot ${status}`} />
      </div>
      {node.ip && <div className="dn-ip">{node.ip}</div>}
      {chips.length > 0 && (
        <div className="dn-stats">
          {chips.map((s, i) => (
            <span key={i} className="dn-chip">{s}</span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
