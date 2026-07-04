import { RouterOSAPI } from 'node-routeros';
import type { Credentials } from '../db/index.js';

export interface MikrotikSystemInfo {
  cpuPct: number;
  memPct: number;
  uptime: string;
  boardName: string;
  version: string;
}

export interface MikrotikInterfaceStats {
  name: string;
  running: boolean;
  rxBytes: number;
  txBytes: number;
  txDrops: number;
  rxErrors: number;
}

export interface MikrotikPingResult {
  sent: number;
  received: number;
  lossPct: number;
  avgMs: number | null;
}

async function withConnection<T>(
  ip: string,
  creds: Credentials,
  fn: (conn: RouterOSAPI) => Promise<T>,
): Promise<T> {
  const conn = new RouterOSAPI({
    host: ip,
    user: creds.routerosUser || 'admin',
    password: creds.routerosPass || '',
    port: 8728,
    timeout: 8,
  });
  await conn.connect();
  try {
    return await fn(conn);
  } finally {
    conn.close();
  }
}

export async function getSystemInfo(ip: string, creds: Credentials): Promise<MikrotikSystemInfo> {
  return withConnection(ip, creds, async (conn) => {
    const rows = await conn.write('/system/resource/print');
    const r = rows[0] as Record<string, string>;
    const total = parseInt(r['total-memory'], 10);
    const free = parseInt(r['free-memory'], 10);
    return {
      cpuPct: parseInt(r['cpu-load'], 10) || 0,
      memPct: total > 0 ? Math.round(((total - free) / total) * 100) : 0,
      uptime: r['uptime'] || '',
      boardName: r['board-name'] || '',
      version: r['version'] || '',
    };
  });
}

export async function getInterfaceStats(ip: string, creds: Credentials): Promise<MikrotikInterfaceStats[]> {
  return withConnection(ip, creds, async (conn) => {
    const rows = await conn.write('/interface/print', ['=stats=']);
    return (rows as Record<string, string>[]).map((r) => ({
      name: r['name'],
      running: r['running'] === 'true',
      rxBytes: parseInt(r['rx-byte'], 10) || 0,
      txBytes: parseInt(r['tx-byte'], 10) || 0,
      txDrops: parseInt(r['tx-drop'], 10) || 0,
      rxErrors: parseInt(r['rx-error'], 10) || 0,
    }));
  });
}

/** Drops acumulados de simple queues (firma directa de saturación con QoS). */
export async function getQueueDrops(ip: string, creds: Credentials): Promise<{ name: string; dropped: number }[]> {
  return withConnection(ip, creds, async (conn) => {
    try {
      const rows = await conn.write('/queue/simple/print', ['=stats=']);
      return (rows as Record<string, string>[]).map((r) => {
        // 'dropped' viene como "up/down" (ej. "1234/567")
        const parts = (r['dropped'] || '0/0').split('/').map((x) => parseInt(x, 10) || 0);
        return { name: r['name'] || '?', dropped: parts.reduce((a, b) => a + b, 0) };
      });
    } catch {
      return []; // sin colas configuradas
    }
  });
}

/**
 * /ping desde el propio MikroTik. Con srcAddress se puede forzar el origen a
 * una IP LAN del router para que el tráfico se enrute/NATee como el de un
 * cliente — clave para detectar pérdida que el ping "normal" del router no ve.
 */
export async function pingFromMikrotik(
  ip: string,
  creds: Credentials,
  target: string,
  srcAddress?: string,
  count = 5,
): Promise<MikrotikPingResult> {
  return withConnection(ip, creds, async (conn) => {
    const params = [`=address=${target}`, `=count=${count}`];
    if (srcAddress) params.push(`=src-address=${srcAddress}`);
    const rows = (await conn.write('/ping', params)) as Record<string, string>[];
    // Cada respuesta trae los acumulados; la última tiene el resumen final.
    const last = rows[rows.length - 1] ?? {};
    const sent = parseInt(last['sent'], 10) || count;
    const received = parseInt(last['received'], 10) || 0;
    const avgRtt = last['avg-rtt'] ? parseRosTime(last['avg-rtt']) : null;
    return {
      sent,
      received,
      lossPct: sent > 0 ? Math.round(((sent - received) / sent) * 1000) / 10 : 100,
      avgMs: avgRtt,
    };
  });
}

/** Convierte tiempos RouterOS ("12ms", "1ms500us", "1s20ms") a milisegundos. */
export function parseRosTime(s: string): number | null {
  if (!s) return null;
  let ms = 0;
  const re = /(\d+)(us|ms|s)/g;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const v = parseInt(m[1], 10);
    if (m[2] === 's') ms += v * 1000;
    else if (m[2] === 'ms') ms += v;
    else ms += v / 1000;
  }
  return matched ? ms : null;
}

/** Prueba de conexión rápida para el botón del panel. */
export async function testConnection(ip: string, creds: Credentials): Promise<{ ok: boolean; detail: string }> {
  try {
    const info = await getSystemInfo(ip, creds);
    return { ok: true, detail: `${info.boardName} RouterOS ${info.version}, CPU ${info.cpuPct}%` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
