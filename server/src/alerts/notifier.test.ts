import { describe, it, expect } from 'vitest';
import { rootOf, downstreamCasualties, buildHierarchy, type Topo } from './notifier.js';

// Cadena tipo WISP:  Monitor(1) → RB-Core(2) → PTP-cerca(3) → PTP-lejos(4) → AP(5) → Cliente(6)
//                                                        (2) → Switch(7)
function makeTopo(down: number[]): Topo {
  const edges: [number, number][] = [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [2, 7]];
  const parent = new Map<number, number>();
  const children = new Map<number, number[]>();
  for (const [s, t] of edges) {
    parent.set(t, s);
    (children.get(s) ?? children.set(s, []).get(s)!).push(t);
  }
  const name = new Map<number, string>([[1, 'Monitor'], [2, 'RB-Core'], [3, 'PTP-cerca'], [4, 'PTP-lejos'], [5, 'AP'], [6, 'Cliente'], [7, 'Switch']]);
  return { name, parent, children, openDown: new Set(down), transparent: new Set<number>() };
}

describe('agrupación por causa raíz', () => {
  it('un cliente caído con todo lo demás arriba es su propia raíz', () => {
    const topo = makeTopo([6]);
    expect(rootOf(6, topo)).toBe(6);
    expect(downstreamCasualties(6, topo)).toEqual([]);
  });

  it('si un PTP intermedio cae, arrastra a los de aguas abajo bajo esa raíz', () => {
    // PTP-lejos(4), AP(5) y Cliente(6) caídos; el resto arriba → raíz = 4
    const topo = makeTopo([4, 5, 6]);
    expect(rootOf(6, topo)).toBe(4);
    expect(rootOf(5, topo)).toBe(4);
    expect(rootOf(4, topo)).toBe(4);
    expect(downstreamCasualties(4, topo).sort()).toEqual([5, 6]);
  });

  it('una caída en RB-Core arrastra ambas ramas', () => {
    const topo = makeTopo([2, 3, 4, 5, 6, 7]);
    expect(rootOf(6, topo)).toBe(2);
    expect(rootOf(7, topo)).toBe(2);
    expect(downstreamCasualties(2, topo).sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7]);
  });

  it('caídas independientes (con un nodo sano en medio) NO se agrupan', () => {
    // Cae RB-Core(2) y Cliente(6), pero 3,4,5 están arriba → 6 es su propia raíz
    const topo = makeTopo([2, 6]);
    expect(rootOf(6, topo)).toBe(6);
    expect(rootOf(2, topo)).toBe(2);
    expect(downstreamCasualties(2, topo)).toEqual([]); // sus hijos directos (3,7) están arriba
  });
});

describe('jerarquía por distancia al Monitor (independiente de la dirección del enlace)', () => {
  // Monitor(1) → 2 → 3 → 4.  Dibujado "bien" vs "al revés" debe dar la MISMA jerarquía.
  const forward = [{ source_id: 1, target_id: 2 }, { source_id: 2, target_id: 3 }, { source_id: 3, target_id: 4 }];
  const reversed = [{ source_id: 2, target_id: 1 }, { source_id: 3, target_id: 2 }, { source_id: 4, target_id: 3 }];

  it('el padre es siempre el vecino más cerca del Monitor, sin importar la flecha', () => {
    for (const edges of [forward, reversed]) {
      const { parent, children } = buildHierarchy(edges, 1);
      expect(parent.get(2)).toBe(1);
      expect(parent.get(3)).toBe(2);
      expect(parent.get(4)).toBe(3);
      expect(children.get(3)).toEqual([4]);
    }
  });

  it('con el enlace al revés, la raíz de la caída sigue siendo el nodo más cercano al Monitor', () => {
    // Enlace dibujado Mimosa(3)→MikroTik(2) (al revés). Caen 2,3,4 → raíz debe ser 2 (el más cerca del Monitor).
    const { parent, children } = buildHierarchy(reversed, 1);
    const topo: Topo = { name: new Map(), parent, children, openDown: new Set([2, 3, 4]), transparent: new Set() };
    expect(rootOf(4, topo)).toBe(2);
    expect(rootOf(3, topo)).toBe(2);
    expect(downstreamCasualties(2, topo).sort()).toEqual([3, 4]);
  });
});

describe('causa raíz atravesando nodos pasivos (fibra/NAP)', () => {
  // Monitor(1) → OLT(2) → NAP(3, pasivo) → ONU(4), ONU(5). El NAP nunca cae.
  const edges = [{ source_id: 1, target_id: 2 }, { source_id: 2, target_id: 3 }, { source_id: 3, target_id: 4 }, { source_id: 3, target_id: 5 }];
  it('caída de la OLT agrupa las ONUs aunque el NAP (pasivo) esté en medio', () => {
    const { parent, children } = buildHierarchy(edges, 1);
    // Caen OLT(2), ONU(4), ONU(5); el NAP(3) es transparente (nunca en openDown).
    const topo: Topo = { name: new Map(), parent, children, openDown: new Set([2, 4, 5]), transparent: new Set([3]) };
    expect(rootOf(4, topo)).toBe(2); // sube ONU→NAP(transparente)→OLT(caída)
    expect(rootOf(5, topo)).toBe(2);
    expect(downstreamCasualties(2, topo).sort()).toEqual([4, 5]); // baja OLT→NAP(transparente)→ONUs
  });
});
