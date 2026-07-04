export type NodeType = 'gateway-isp' | 'mikrotik' | 'ptp-mimosa' | 'ap-ubiquiti' | 'cliente';

export interface ApiNode {
  id: number;
  type: NodeType;
  name: string;
  ip: string;
  posX: number;
  posY: number;
  enabled: boolean;
  probeTargets: string[];
  probeSrcAddresses: string[];
  hasRouterosCreds: boolean;
  snmpCommunity: string;
}

export interface ApiEdge {
  id: number;
  source_id: number;
  target_id: number;
  label: string;
  capacity_mbps: number | null;
  source_interface: string;
}

export interface LiveNode {
  status: 'up' | 'warning' | 'down' | 'unknown';
  latencyMs: number | null;
  lossPct: number | null;
  lastSeen: number | null;
  summary: Record<string, number>;
}

export interface Alert {
  id: number;
  node_id: number | null;
  edge_id: number | null;
  severity: 'info' | 'warning' | 'critical';
  type: string;
  message: string;
  ai_diagnosis: string | null;
  created_at: number;
  resolved_at: number | null;
  node_name: string | null;
}

export interface LossMatrixCell {
  origin: string;
  originName: string;
  srcAddress: string;
  target: string;
  samples: number;
  avgLossPct: number;
  avgMs: number | null;
}

export interface HourlyRow {
  hour: number;
  avgLossPct: number;
  avgUtilizationPct: number | null;
  samples: number;
}

export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  'gateway-isp': 'Gateway / ISP',
  'mikrotik': 'MikroTik',
  'ptp-mimosa': 'PTP Mimosa',
  'ap-ubiquiti': 'AP Ubiquiti',
  'cliente': 'Cliente (LiteBeam)',
};

export const NODE_TYPE_ICONS: Record<NodeType, string> = {
  'gateway-isp': '🌐',
  'mikrotik': '🖥️',
  'ptp-mimosa': '📡',
  'ap-ubiquiti': '📶',
  'cliente': '🏠',
};
