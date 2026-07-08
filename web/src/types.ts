export type NodeType =
  | 'monitor' | 'gateway-isp' | 'router' | 'mikrotik' | 'switch'
  | 'ptp-mimosa' | 'ap-ubiquiti' | 'litebeam' | 'cliente'
  | 'torre' | 'rack'
  | 'olt' | 'onu' | 'nap' | 'poste'
  | 'poe' | 'patch';

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
  /** Metadatos por tipo (puertos OLT, ratio splitter NAP, sensibilidad ONU, etc.). */
  meta: unknown;
}

export interface FiberInfo {
  cableType?: string;
  buffers?: number;
  hilos?: number;
  hiloColor?: string;
  lengthM?: number;
  lengthAuto?: boolean;
  dbPerKm?: number;
  connectors?: number;
  oltPort?: string;
}

export interface ApiEdge {
  id: number;
  source_id: number;
  target_id: number;
  label: string;
  capacity_mbps: number | null;
  source_interface: string;
  medium: string;
  fiber: FiberInfo | null;
  /** Cableado puerto→puerto: id de puerto en el equipo origen/destino ('' = sin asignar). */
  source_port: string;
  target_port: string;
}

/** Metadatos tipados por tipo de nodo. */
export interface OltMeta { ports?: { name: string; txDbm: number }[] }
export interface NapMeta { splitRatio?: number }
export interface OnuMeta { rxSensitivityDbm?: number }

/** Posición en el lienzo físico de «Rack y Torre». */
export interface PhysPos { x: number; y: number }

/**
 * Superset de `meta` para las vistas física/topología. Todos los campos son
 * opcionales; cada tipo de nodo usa los que le aplican. Convive con OltMeta/NapMeta/OnuMeta.
 */
export interface NodeMeta {
  // OLT / NAP / ONU (existentes)
  ports?: { name: string; txDbm: number }[];
  splitRatio?: number;
  rxSensitivityDbm?: number;
  // Contenedor (rack/torre): posición en el lienzo físico.
  phys?: PhysPos;
  // Miembro de rack: orden del slot (arriba→abajo). Radio de torre: altura 0..1 y lado (L/R).
  slot?: number;
  mountF?: number;
  side?: 'L' | 'R';
  // Conteo de puertos (auto-derivado del tipo, ajustable por equipo).
  ponPorts?: number;
  switchPorts?: number;
  poePorts?: number;
  patchPorts?: number;
  splitterOut?: number;
  lanPorts?: number;
}

/** Código de colores estándar TIA-598 para hilos/buffers de fibra. */
export const TIA_COLORS: { name: string; hex: string }[] = [
  { name: 'Azul', hex: '#2f6fe0' }, { name: 'Naranja', hex: '#f08a24' }, { name: 'Verde', hex: '#2faa4a' },
  { name: 'Marrón', hex: '#8a5a2b' }, { name: 'Gris', hex: '#9aa4b2' }, { name: 'Blanco', hex: '#f3f4f6' },
  { name: 'Rojo', hex: '#e0403b' }, { name: 'Negro', hex: '#2b2f38' }, { name: 'Amarillo', hex: '#e7c93a' },
  { name: 'Violeta', hex: '#8b5bff' }, { name: 'Rosado', hex: '#f06ca8' }, { name: 'Aqua', hex: '#3fb6c8' },
];

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
  'olt': 'OLT',
  'onu': 'ONU',
  'nap': 'NAP / Caja',
  'poste': 'Poste',
  'poe': 'Fuente PoE',
  'patch': 'Patch Panel',
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
  'olt': '🔌',
  'onu': '📦',
  'nap': '🗃️',
  'poste': '📍',
  'poe': '⚡',
  'patch': '🎛️',
};

/** Contenedores (agrupan equipos por pertenencia, no por enlaces). */
export const CONTAINER_TYPES: NodeType[] = ['torre', 'rack'];

/** Tipos que el usuario puede añadir desde la paleta (el monitor es singleton y automático). */
export const ADDABLE_TYPES: NodeType[] = [
  'gateway-isp', 'router', 'mikrotik', 'switch', 'ptp-mimosa', 'ap-ubiquiti', 'litebeam', 'cliente',
  'olt', 'onu', 'nap', 'poste', 'poe', 'patch', 'torre', 'rack',
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
