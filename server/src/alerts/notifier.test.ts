import { describe, it, expect } from 'vitest';
import { rootOf, downstreamCasualties, type Topo } from './notifier.js';

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
  return { name, parent, children, openDown: new Set(down) };
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
