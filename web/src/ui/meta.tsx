import type { NodeType } from '../types';

/** SVG path data para los iconos de línea (portados del diseño). */
export const ICONS = {
  monitor: 'M3 4h18v12H3zM8.5 20h7M12 16v4',
  gateway:
    'M12 2a9 9 0 0 0-9 9c0 5 9 11 9 11s9-6 9-11a9 9 0 0 0-9-9zM3 11h18M12 2c2.5 2.5 2.5 15.5 0 20M12 2c-2.5 2.5-2.5 15.5 0 20',
  router:
    'M6 15h12a3 3 0 0 1 3 3 3 3 0 0 1-3 3H6a3 3 0 0 1-3-3 3 3 0 0 1 3-3zM6.5 18h.01M10 18h4M12 15V9M12 9l-3-3M12 9l3-3',
  mikrotik: 'M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01M11 7h6M11 17h6',
  switch:
    'M4 6h16v4H4zM4 14h16v4H4zM8 8h.01M12 8h.01M16 8h.01M8 16h.01M12 16h.01M16 16h.01',
  ptp:
    'M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  ap: 'M5 12.5a10 10 0 0 1 14 0M8 15.5a6 6 0 0 1 8 0M12 19h.01',
  litebeam: 'M12 3v9M12 12l7-7M12 12l-7-7M8 21h8M10 21l1-9M14 21l-1-9',
  client: 'M3 10l9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 21v-7h6v7',
  torre: 'M12 2v20M7 22l5-14 5 14M9 8h6M8 12h8M6.5 16h11',
  rack: 'M4 3h16v18H4zM4 8h16M4 13h16M4 18h16M7 5.5h.01M7 10.5h.01M7 15.5h.01',
  olt: 'M4 5h16v6H4zM4 13h16v6H4zM7 8h.01M7 16h.01M11 8h1M11 16h1M15 8h3M15 16h3',
  onu: 'M4 7h16v10H4zM8 7v10M4 11h4M15 10h2M15 13h2',
  nap: 'M5 3h14v18H5zM5 12h14M9 7h6M9 16h6',
  poste: 'M12 2v20M8 22h8M12 5h7M12 9h5M12 5L19 3M12 9l5-2',
  poe: 'M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5',
  patch: 'M3 6h18v12H3zM6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7 14h2M11 14h2M15 14h2',
} as const;

export type IconKey = keyof typeof ICONS;

export interface TypeMeta {
  icon: IconKey;
  color: string;
  label: string;
}

/** Mapea el tipo real del backend al icono/color/etiqueta del diseño. */
export const TYPE_META: Record<NodeType, TypeMeta> = {
  'monitor': { icon: 'monitor', color: '#8b5bff', label: 'PC de monitoreo' },
  'gateway-isp': { icon: 'gateway', color: '#4c8dff', label: 'Gateway / ISP' },
  'router': { icon: 'router', color: '#4c8dff', label: 'Router' },
  'mikrotik': { icon: 'mikrotik', color: '#f5b13d', label: 'MikroTik' },
  'switch': { icon: 'switch', color: '#57c7d4', label: 'Switch' },
  'ptp-mimosa': { icon: 'ptp', color: '#33cc7a', label: 'PTP Mimosa' },
  'ap-ubiquiti': { icon: 'ap', color: '#57c7d4', label: 'AP Ubiquiti' },
  'litebeam': { icon: 'litebeam', color: '#7aa2ff', label: 'LiteBeam / Estación' },
  'cliente': { icon: 'client', color: '#aab6cc', label: 'Cliente' },
  'torre': { icon: 'torre', color: '#57c7d4', label: 'Torre' },
  'rack': { icon: 'rack', color: '#8b5bff', label: 'Rack' },
  'olt': { icon: 'olt', color: '#4c8dff', label: 'OLT' },
  'onu': { icon: 'onu', color: '#33cc7a', label: 'ONU' },
  'nap': { icon: 'nap', color: '#f5b13d', label: 'NAP / Caja' },
  'poste': { icon: 'poste', color: '#8a5a2b', label: 'Poste' },
  'poe': { icon: 'poe', color: '#f5b13d', label: 'Fuente PoE' },
  'patch': { icon: 'patch', color: '#8b9cc4', label: 'Patch Panel' },
};

/** Metadatos del tipo con fallback (evita crash si el frontend es más viejo que un tipo nuevo). */
export function typeMeta(type: NodeType): TypeMeta {
  return TYPE_META[type] ?? TYPE_META.cliente;
}

/** Icono SVG de línea reutilizable. */
export function Icon({
  path,
  size = 18,
  stroke = 'currentColor',
  strokeWidth = 1.9,
  fill = 'none',
  style,
}: {
  path: string;
  size?: number;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      <path d={path} />
    </svg>
  );
}

/** Sección de la app (navegación de la barra lateral). */
export type Section = 'topology' | 'racktower' | 'map' | 'alerts' | 'saturation' | 'ai' | 'telegram' | 'settings';

export const SECTION_META: Record<Section, { title: string; subtitle: string; icon: string }> = {
  topology: {
    title: 'Topología',
    subtitle: 'Mapa en vivo de la red — arrastra, conecta y rompe enlaces',
    icon: 'M5 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM19 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM19 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 5h10M6.5 6.8L17.5 15.5M12 7v10',
  },
  racktower: {
    title: 'Rack y Torre',
    subtitle: 'Infraestructura física — equipos, puertos y cableado',
    icon: 'M4 3h16v18H4zM4 8h16M4 13h16M4 18h16M7 5.5h.01M7 10.5h.01M7 15.5h.01',
  },
  map: {
    title: 'Mapa',
    subtitle: 'Ubica tus equipos geográficamente con estado en vivo',
    icon: 'M9 3L3 6v15l6-3 6 3 6-3V3l-6 3-6-3zM9 3v15M15 6v15',
  },
  alerts: {
    title: 'Alertas',
    subtitle: 'Umbrales, estado y diagnóstico automático de la IA',
    icon: 'M12 2a7 7 0 0 0-7 7c0 4-2 5-2 7h18c0-2-2-3-2-7a7 7 0 0 0-7-7zM10 21a2 2 0 0 0 4 0',
  },
  saturation: {
    title: 'Saturación',
    subtitle: 'Matriz de pérdida y mapa de calor por hora',
    icon: 'M4 20V10M10 20V4M16 20v-6M22 20h-2M2 20h20',
  },
  ai: {
    title: 'Diagnóstico IA',
    subtitle: 'Chat con herramientas reales sobre tu red',
    icon: 'M12 2l1.9 5.6L19.5 9l-4.3 3.4L16.5 18 12 14.7 7.5 18l1.3-5.6L4.5 9l5.6-1.4z',
  },
  telegram: {
    title: 'Telegram',
    subtitle: 'Alertas y diagnósticos a tu chat o grupo',
    icon: 'M22 4L2 11l6 2 2 6 3-4 5 4z',
  },
  settings: {
    title: 'Ajustes',
    subtitle: 'IA, sondas, enfoque y actualizaciones',
    icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  },
};

/** Textos de ayuda por módulo (portados del diseño). */
export const HELP: Record<string, { title: string; body: string }> = {
  topology: {
    title: 'Mapa de topología',
    body: 'Construye tu red conectando equipos. El nodo raíz «PC de monitoreo» es fijo y de él parte toda la cadena. Añade equipos desde la paleta, arrástralos para colocarlos y tira del punto azul de un nodo hacia otro para crear un enlace. El color de cada nodo refleja su estado en vivo (verde=up, ámbar=warning, rojo=down) y las conexiones animan el flujo según la salud del enlace.',
  },
  palette: {
    title: 'Paleta de equipos',
    body: 'Cada botón añade un tipo de equipo al lienzo: Gateway/ISP, Router, MikroTik, Switch, PTP Mimosa, AP Ubiquiti, LiteBeam/Estación y Cliente. Un PTP inserta sus dos antenas al «romper el hilo» de un enlace existente con el botón + de la línea.',
  },
  map: {
    title: 'Mapa geográfico',
    body: 'Ubica tus equipos en un mapa real por coordenadas. Son los MISMOS equipos de la topología, con su estado en vivo (colores, anillo pulsante) y los enlaces animados. Arrastra un marcador para colocarlo; usa el panel «Sin ubicar» para los que aún no tienen posición. Clic en un equipo o enlace abre su panel. Requiere una API key gratuita de MapTiler (se configura en Ajustes → Mapa).',
  },
  racktower: {
    title: 'Rack y Torre — vista física',
    body: 'La misma red de la topología, vista por dentro: cada rack es un gabinete con sus equipos apilados y sus puertos; cada torre lleva sus radios a distintas alturas. Selecciona un rack o torre y añade equipos desde la barra. Conecta un cable haciendo clic en un puerto y luego en otro: ese cable ES un enlace de la topología (con puerto origen y destino), así que aparece también en el mapa y alimenta el cálculo PON. Arrastra los equipos para reordenarlos, enciende/apaga con el botón de power, y doble clic para renombrar.',
  },
  alerts: {
    title: 'Alertas',
    body: 'Se disparan por umbrales configurables: equipo caído, CPU alta, señal baja, pérdida alta, saturación+pérdida y fallas físicas de cable (bajada de velocidad, half-duplex, errores CRC). Cada alerta recibe un diagnóstico automático de la IA. Las alertas se resuelven solas cuando la condición cesa, o manualmente.',
  },
  saturation: {
    title: 'Saturación',
    body: 'La matriz muestra la pérdida de paquetes por par origen→destino: qué puntos pierden hacia internet. El mapa de calor cruza la hora del día con la utilización del enlace para revelar patrones de congestión recurrentes.',
  },
  ai: {
    title: 'Diagnóstico con IA',
    body: 'Chat con la IA (Claude) que investiga con herramientas reales sobre tu red: topología, métricas, ping en vivo, detalle de equipo, matriz de pérdida, correlación, alertas, prueba de cable y salud de enlace. Usa modelos híbridos: uno económico para diagnósticos automáticos de alertas y uno potente para el chat.',
  },
  telegram: {
    title: 'Alertas por Telegram',
    body: 'Envía alertas y diagnósticos a un chat o grupo de Telegram. Configura el token del bot, detecta el chat id automáticamente y ajusta preferencias: severidad mínima, aviso al resolver e inclusión del diagnóstico de la IA.',
  },
  settings: {
    title: 'Ajustes',
    body: 'API key de la IA (guardada cifrada localmente), selección de modelos, umbrales de alerta, targets de sonda del PC, Telegram y actualizaciones automáticas desde GitHub. El Modo enfoque centra el análisis en datos nuevos desde un momento dado, ignorando los antiguos.',
  },
  tdr: {
    title: 'Prueba TDR de cable',
    body: 'La reflectometría (TDR) en MikroTik analiza el cable UTP par por par. Para cada par informa si está OK, abierto o en corto, y la distancia estimada a la falla en metros. Útil para localizar cables dañados sin desconectar el equipo. Interrumpe el enlace ~1 s por puerto mientras mide.',
  },
  conntest: {
    title: 'Probar conexión',
    body: 'Lanza un ping y una consulta por API RouterOS (MikroTik) o SNMP (antenas/switches) para verificar credenciales y accesibilidad del equipo antes de monitorearlo.',
  },
  audit: {
    title: 'Auditoría de configuración',
    body: 'Revisa (solo lectura) la configuración del MikroTik buscando lo que puede esconder o causar la pérdida en hora pico. El sospechoso #1 es FastTrack: las conexiones fast-tracked saltan las colas y el mangle, así que la saturación no se moldea ni se contabiliza y el ping del router sale limpio aunque los clientes pierdan. También detecta ausencia de QoS, falta de MSS clamp con MTU/PPPoE reducida, tabla de conntrack casi llena, CPU alta y puertos en half-duplex o velocidad degradada. Cada hallazgo trae severidad y recomendación.',
  },
  flow: {
    title: 'Flujo RouterOS',
    body: 'Diagrama del recorrido de un paquete dentro del MikroTik. El internet entra por la interfaz WAN, se registra en Connection Tracking, se marca en Mangle, se aplica dst-nat (port forwarding), se toma la decisión de ruteo, se filtra en el Firewall (cadena forward), se aplica src-nat/masquerade a la salida, se limita el ancho de banda en las Simple Queues por cliente y finalmente sale por el bridge LAN hacia los abonados. Los contadores (tráfico, conexiones, drops, uso de cola) se leen en vivo por API RouterOS.',
  },
};
