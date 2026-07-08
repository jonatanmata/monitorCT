export type NodeType =
  | 'monitor' | 'gateway-isp' | 'router' | 'mikrotik' | 'switch'
  | 'ptp-mimosa' | 'ap-ubiquiti' | 'litebeam' | 'cliente'
  | 'torre' | 'rack';

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
  watched: boolean;
  /** Ubicación geográfica en el mapa (null = sin ubicar). */
  lat: number | null;
  lng: number | null;
  /** Contenedor (rack/torre) al que pertenece (null = suelto). */
  containerId: number | null;
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
  /** Mayor % de utilización de un enlace con capacidad que toca el nodo. */
  bwPct?: number;
  /** true cuando está cerca del ancho de banda configurado (antena en naranja). */
  bwNear?: boolean;
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
  'router': 'Router',
  'mikrotik': 'MikroTik',
  'switch': 'Switch',
  'ptp-mimosa': 'PTP Mimosa',
  'ap-ubiquiti': 'AP Ubiquiti',
  'litebeam': 'LiteBeam / Estación',
  'cliente': 'Cliente (LiteBeam)',
  'torre': 'Torre',
  'rack': 'Rack',
};

export const NODE_TYPE_ICONS: Record<NodeType, string> = {
  'monitor': '💻',
  'gateway-isp': '🌐',
  'router': '🧭',
  'mikrotik': '🖥️',
  'switch': '🔀',
  'ptp-mimosa': '📡',
  'ap-ubiquiti': '📶',
  'litebeam': '🛰️',
  'cliente': '🏠',
  'torre': '🗼',
  'rack': '🗄️',
};

/** Contenedores (agrupan equipos por pertenencia, no por enlaces). */
export const CONTAINER_TYPES: NodeType[] = ['torre', 'rack'];

/** Tipos que el usuario puede añadir desde la paleta (el monitor es singleton y automático). */
export const ADDABLE_TYPES: NodeType[] = [
  'gateway-isp', 'router', 'mikrotik', 'switch', 'ptp-mimosa', 'ap-ubiquiti', 'litebeam', 'cliente', 'torre', 'rack',
];

/** Tipos insertables al «romper el hilo» de un enlace (los contenedores no se insertan en enlaces). */
export const INSERTABLE_TYPES: NodeType[] = ADDABLE_TYPES.filter((t) => !CONTAINER_TYPES.includes(t));

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
