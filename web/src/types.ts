export type NodeType = 'monitor' | 'gateway-isp' | 'mikrotik' | 'ptp-mimosa' | 'ap-ubiquiti' | 'cliente';

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
  'monitor': 'Monitor (PC)',
  'gateway-isp': 'Gateway / ISP',
  'mikrotik': 'MikroTik',
  'ptp-mimosa': 'PTP Mimosa',
  'ap-ubiquiti': 'AP Ubiquiti',
  'cliente': 'Cliente (LiteBeam)',
};

export const NODE_TYPE_ICONS: Record<NodeType, string> = {
  'monitor': '💻',
  'gateway-isp': '🌐',
  'mikrotik': '🖥️',
  'ptp-mimosa': '📡',
  'ap-ubiquiti': '📶',
  'cliente': '🏠',
};

/** Tipos que el usuario puede añadir/insertar (el monitor es singleton y automático). */
export const ADDABLE_TYPES: NodeType[] = ['gateway-isp', 'mikrotik', 'ptp-mimosa', 'ap-ubiquiti', 'cliente'];

/** Nodos a insertar al partir un enlace: PTP inserta la pareja (2 antenas); el resto, uno. */
export function nodesForInsert(type: NodeType): { type: NodeType; name?: string }[] {
  if (type === 'ptp-mimosa') {
    return [
      { type: 'ptp-mimosa', name: 'PTP (cercano)' },
      { type: 'ptp-mimosa', name: 'PTP (lejano)' },
    ];
  }
  return [{ type }];
}
