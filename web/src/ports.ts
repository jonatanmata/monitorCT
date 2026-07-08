import type { ApiNode, NodeMeta, NodeType } from './types';

/** Tipo eléctrico/óptico/RF del puerto (define color e ícono del pin). */
export type PortKind = 'rj45' | 'sfp' | 'pon' | 'poe' | 'lan' | 'wireless';

export interface Port {
  /** Id estable, guardado en edge.source_port/target_port (ej. 'pon1', 'e1', 'o3'). */
  id: string;
  /** Etiqueta completa (ej. 'ether1', 'PON 1'). */
  label: string;
  /** Etiqueta corta para el pin (ej. 'e1', '1', 'UP'). */
  tag: string;
  kind: PortKind;
  /** Puerto de subida/uplink (se dibuja destacado). */
  uplink: boolean;
}

function metaOf(node: ApiNode): NodeMeta {
  return (node.meta ?? {}) as NodeMeta;
}

function p(id: string, label: string, tag: string, kind: PortKind, uplink = false): Port {
  return { id, label, tag, kind, uplink };
}

/** N puertos numerados con prefijos de id/etiqueta. */
function seq(n: number, idPrefix: string, labelPrefix: string, kind: PortKind): Port[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) =>
    p(idPrefix + (i + 1), labelPrefix + (i + 1), '' + (i + 1), kind),
  );
}

/** Nº de puertos por defecto según el tipo (ajustable en meta). */
export function defaultPortCount(type: NodeType): number {
  switch (type) {
    case 'olt': return 8;      // PON
    case 'switch': return 24;  // bocas
    case 'poe': return 8;      // salidas PoE
    case 'patch': return 24;   // puertos patch
    case 'nap': return 8;      // salidas del splitter
    default: return 0;
  }
}

/**
 * Catálogo de puertos derivado del tipo del equipo + conteos en `meta`.
 * Reutilizado por la vista física (pines) y el EdgeDrawer (selector por extremo).
 * Los contenedores (rack/torre) y el poste no exponen puertos.
 */
export function portsForType(node: ApiNode): Port[] {
  const m = metaOf(node);
  switch (node.type) {
    case 'olt': {
      const n = m.ponPorts ?? 8;
      return [p('up', 'UPLINK', 'UP', 'sfp', true), ...seq(n, 'pon', 'PON ', 'pon')];
    }
    case 'mikrotik':
      return [
        p('e1', 'ether1', 'e1', 'rj45', true), p('e2', 'ether2', 'e2', 'rj45'),
        p('e3', 'ether3', 'e3', 'rj45'), p('e4', 'ether4', 'e4', 'rj45'),
        p('e5', 'ether5', 'e5', 'rj45'), p('sfp1', 'sfp1', 'S1', 'sfp'), p('sfp2', 'sfp2', 'S2', 'sfp'),
      ];
    case 'router':
      return [
        p('e1', 'ether1', 'e1', 'rj45', true), p('e2', 'ether2', 'e2', 'rj45'),
        p('e3', 'ether3', 'e3', 'rj45'), p('e4', 'ether4', 'e4', 'rj45'), p('e5', 'ether5', 'e5', 'rj45'),
      ];
    case 'switch': {
      const n = m.switchPorts ?? 24;
      return [p('up', 'SFP+ uplink', 'UP', 'sfp', true), ...seq(n, 'p', 'Puerto ', 'rj45'), p('sfp1', 'sfp1', 'S1', 'sfp')];
    }
    case 'poe': {
      const n = m.poePorts ?? 8;
      return [p('in', 'IN', 'IN', 'rj45', true), ...seq(n, 'o', 'Salida ', 'poe')];
    }
    case 'patch': {
      const n = m.patchPorts ?? 24;
      return seq(n, 'a', 'Puerto ', 'rj45');
    }
    case 'nap': {
      const n = m.splitRatio ?? m.splitterOut ?? 8;
      return [p('in', 'IN PON', 'IN', 'pon', true), ...seq(n, 'o', 'OUT ', 'pon')];
    }
    case 'onu': {
      const lan = m.lanPorts ?? 1;
      return [p('in', 'PON', 'PON', 'pon', true), ...seq(lan, 'lan', 'LAN ', 'lan')];
    }
    case 'ptp-mimosa':
    case 'ap-ubiquiti':
    case 'litebeam':
      // Radios: enlace de aire (RF) hacia el par en otra torre + alimentación PoE + LAN.
      return [p('air', 'Enlace aire (RF)', 'AIR', 'wireless'), p('poe', 'PoE / Data', 'PoE', 'poe', true), p('lan', 'LAN', 'LAN', 'rj45')];
    case 'gateway-isp':
      return [p('out', 'Salida', 'OUT', 'sfp', true)];
    case 'monitor':
      return [p('lan', 'LAN', 'LAN', 'rj45', true)];
    // Contenedores y pasivos sin puertos gestionados.
    case 'torre':
    case 'rack':
    case 'poste':
    case 'cliente':
    default:
      return [];
  }
}

/** Busca un puerto por id dentro de un equipo. */
export function findPort(node: ApiNode, portId: string): Port | undefined {
  if (!portId) return undefined;
  return portsForType(node).find((pt) => pt.id === portId);
}

/** Color del pin/cable según el tipo de puerto. */
export function portColor(kind: PortKind): string {
  if (kind === 'wireless') return '#8b5bff'; // enlace de aire (RF)
  if (kind === 'poe') return '#57c7d4';
  if (kind === 'pon' || kind === 'sfp' || kind === 'lan') return '#f5b13d';
  return '#4c8dff'; // rj45
}

/** Etiqueta corta «Equipo:puerto» para cables (ej. «RB-Core:sfp1»). */
export function portRef(node: ApiNode | undefined, portId: string): string {
  if (!node) return portId || '?';
  const pt = findPort(node, portId);
  return `${node.name}${pt ? ':' + pt.label : ''}`;
}
