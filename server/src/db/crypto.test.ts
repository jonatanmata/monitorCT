import { describe, it, expect } from 'vitest';
import { encryptJson, decryptJson } from './crypto.js';

describe('cifrado de credenciales', () => {
  it('cifra y descifra un objeto', () => {
    const creds = { routerosUser: 'admin', routerosPass: 'secreto123', snmpCommunity: 'public' };
    const enc = encryptJson(creds);
    expect(enc).not.toContain('secreto123');
    expect(decryptJson(enc, {})).toEqual(creds);
  });
  it('devuelve el fallback con payload corrupto', () => {
    expect(decryptJson('basura.invalida.xx', { a: 1 })).toEqual({ a: 1 });
    expect(decryptJson('', null)).toBeNull();
  });
  it('produce cifrados distintos para el mismo contenido (IV aleatorio)', () => {
    const a = encryptJson({ x: 1 });
    const b = encryptJson({ x: 1 });
    expect(a).not.toEqual(b);
  });
});
