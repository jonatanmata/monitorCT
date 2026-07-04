import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const SECRET = process.env.SECRET_KEY || 'monitorct-default-dev-key';
const KEY = scryptSync(SECRET, 'monitorct-salt', 32);

/** Cifra un objeto JSON con AES-256-GCM. Formato: iv.tag.cipher (base64). */
export function encryptJson(obj: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptJson<T>(payload: string, fallback: T): T {
  if (!payload) return fallback;
  try {
    const [ivB64, tagB64, dataB64] = payload.split('.');
    const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return JSON.parse(dec.toString('utf8')) as T;
  } catch {
    return fallback;
  }
}
