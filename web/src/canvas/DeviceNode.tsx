import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { ApiNode, LiveNode } from '../types';
import { NODE_TYPE_ICONS } from '../types';

export type DeviceNodeData = {
  node: ApiNode;
  live: LiveNode | null;
};

export type DeviceFlowNode = Node<DeviceNodeData, 'device'>;

const SUMMARY_LABELS: Record<string, string> = {
  cpu_pct: 'CPU',
  signal_dbm: 'Señal',
  ccq_pct: 'CCQ',
  snr_db: 'SNR',
  stations: 'Estac.',
};

export function DeviceNode({ data }: NodeProps<DeviceFlowNode>) {
  const { node, live } = data;
  const status = live?.status ?? 'unknown';
  const stats: string[] = [];
  if (live?.latencyMs != null) stats.push(`${live.latencyMs.toFixed(0)} ms`);
  if (live?.lossPct != null && live.lossPct > 0) stats.push(`pérd ${live.lossPct}%`);
  for (const [key, label] of Object.entries(SUMMARY_LABELS)) {
    const v = live?.summary?.[key];
    if (v !== undefined) {
      const unit = key === 'cpu_pct' || key === 'ccq_pct' ? '%' : key === 'signal_dbm' ? ' dBm' : key === 'snr_db' ? ' dB' : '';
      stats.push(`${label} ${v}${unit}`);
    }
  }

  return (
    <div className={`device-node status-${status}`}>
      <Handle type="target" position={Position.Left} />
      <div className="dn-title">
        <span>{NODE_TYPE_ICONS[node.type]}</span>
        <span>{node.name}</span>
      </div>
      {node.ip && <div className="dn-ip">{node.ip}</div>}
      {stats.length > 0 && (
        <div className="dn-stats">
          {stats.map((s, i) => (
            <span key={i}>{s}</span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
