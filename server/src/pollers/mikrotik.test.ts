import { describe, it, expect } from 'vitest';
import { parseRosTime } from './mikrotik.js';

describe('parseRosTime', () => {
  it('convierte milisegundos simples', () => {
    expect(parseRosTime('12ms')).toBe(12);
  });
  it('convierte combinaciones ms+us', () => {
    expect(parseRosTime('1ms500us')).toBe(1.5);
  });
  it('convierte segundos + ms', () => {
    expect(parseRosTime('1s20ms')).toBe(1020);
  });
  it('convierte solo microsegundos', () => {
    expect(parseRosTime('750us')).toBe(0.75);
  });
  it('devuelve null para vacío o inválido', () => {
    expect(parseRosTime('')).toBeNull();
    expect(parseRosTime('timeout')).toBeNull();
  });
});
