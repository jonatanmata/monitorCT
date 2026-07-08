import { describe, it, expect } from 'vitest';
import { computePonBudget, type PonNode, type PonEdge } from './budget.js';

// OLT(1, tx 3 dBm en pon1) —fibra 2km 2 conectores→ NAP(2, 1:8) —fibra 0.5km 2 conectores→ ONU(3)
const nodes: PonNode[] = [
  { id: 1, type: 'olt', name: 'OLT-Central', meta: { ports: [{ name: 'pon1', txDbm: 3 }] } },
  { id: 2, type: 'nap', name: 'NAP-Barrio', meta: { splitRatio: 8 } },
  { id: 3, type: 'onu', name: 'ONU-Cliente', meta: { rxSensitivityDbm: -27 } },
];
const edges: PonEdge[] = [
  { source_id: 1, target_id: 2, fiber: { lengthM: 2000, dbPerKm: 0.35, connectors: 2, oltPort: 'pon1' } },
  { source_id: 2, target_id: 3, fiber: { lengthM: 500, dbPerKm: 0.35, connectors: 2 } },
];

describe('presupuesto óptico PON', () => {
  it('calcula rxDbm restando fibra, conectores y splitter', () => {
    const b = computePonBudget(nodes, edges, 3);
    expect(b.supported).toBe(true);
    expect(b.txDbm).toBe(3);
    // fibra1 = 2*0.35 + 2*0.5 = 1.7 ; splitter 1:8 = 10.5 ; fibra2 = 0.5*0.35 + 2*0.5 = 1.175
    // total = 1.7 + 10.5 + 1.175 = 13.375 ; rx = 3 - 13.375 = -10.375 → -10.38 (redondeo)
    expect(b.totalLossDb).toBeCloseTo(13.38, 1);
    expect(b.rxDbm).toBeCloseTo(-10.38, 1);
    expect(b.path).toEqual([1, 2, 3]);
    expect(b.warnings).toHaveLength(0);
  });

  it('funciona con el enlace dibujado al revés (ONU→…→OLT)', () => {
    const rev: PonEdge[] = [
      { source_id: 2, target_id: 1, fiber: { lengthM: 2000, dbPerKm: 0.35, connectors: 2, oltPort: 'pon1' } },
      { source_id: 3, target_id: 2, fiber: { lengthM: 500, dbPerKm: 0.35, connectors: 2 } },
    ];
    const b = computePonBudget(nodes, rev, 3);
    expect(b.rxDbm).toBeCloseTo(-10.38, 1);
    expect(b.path).toEqual([1, 2, 3]);
  });

  it('sin OLT conectada devuelve supported=false con nota (no lanza)', () => {
    const b = computePonBudget([nodes[1], nodes[2]], [edges[1]], 3);
    expect(b.supported).toBe(false);
    expect(b.note).toBeTruthy();
  });

  it('usa el puerto del cable (source_port/target_port) del lado OLT', () => {
    // Sin fiber.oltPort: el puerto viene del cableado puerto→puerto. OLT es el source → source_port.
    const withPorts: PonEdge[] = [
      { source_id: 1, target_id: 2, fiber: { lengthM: 2000, dbPerKm: 0.35, connectors: 2 }, source_port: 'pon1', target_port: 'in' },
      { source_id: 2, target_id: 3, fiber: { lengthM: 500, dbPerKm: 0.35, connectors: 2 }, source_port: 'o1', target_port: 'in' },
    ];
    const b = computePonBudget(nodes, withPorts, 3);
    expect(b.txDbm).toBe(3);           // resolvió pon1 → 3 dBm vía source_port
    expect(b.warnings).toHaveLength(0);
    expect(b.rxDbm).toBeCloseTo(-10.38, 1);
  });

  it('resuelve el puerto OLT aunque el cable esté al revés (OLT como target)', () => {
    const rev: PonEdge[] = [
      { source_id: 2, target_id: 1, fiber: { lengthM: 2000, dbPerKm: 0.35, connectors: 2 }, source_port: 'in', target_port: 'pon1' },
      { source_id: 3, target_id: 2, fiber: { lengthM: 500, dbPerKm: 0.35, connectors: 2 } },
    ];
    const b = computePonBudget(nodes, rev, 3);
    expect(b.txDbm).toBe(3);           // OLT es target → target_port='pon1'
    expect(b.warnings).toHaveLength(0);
  });

  it('avisa (warning) si el puerto de la OLT no está asignado', () => {
    const noPort: PonEdge[] = [
      { source_id: 1, target_id: 2, fiber: { lengthM: 2000, connectors: 2 } },
      { source_id: 2, target_id: 3, fiber: { lengthM: 500, connectors: 2 } },
    ];
    const b = computePonBudget(nodes, noPort, 3);
    expect(b.supported).toBe(true);
    expect(b.warnings.length).toBeGreaterThan(0);
  });
});
