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

export interface EthernetStatus {
  name: string;
  linkOk: boolean;
  rateMbps: number | null;   // velocidad negociada
  fullDuplex: boolean | null;
  autoNegotiation: boolean | null;
}

export interface EthernetErrorStats {
  name: string;
  crcErrors: number;   // rx-fcs-error + rx-align-error + rx-fragment (firma de cable/EMI)
  collisions: number;  // tx-collision + tx-late-collision (dúplex/cable)
}

export interface CablePair {
  pair: string;
  status: string;      // ok | open | short | open-short
  distanceM: number | null;
}

export interface CableTestResult {
  name: string;
  supported: boolean;
  status?: string;     // link-ok / no-link
  pairs?: CablePair[];
  note?: string;
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
  // Evita que un evento 'error' sin listener (o una respuesta inesperada del router)
  // se convierta en una excepción no controlada que tumbe el proceso.
  const emitter = conn as unknown as { on?: (ev: string, cb: (e: unknown) => void) => void };
  emitter.on?.('error', () => { /* contenido; la operación fallará y se reintenta al próximo ciclo */ });
  await conn.connect();
  try {
    return await fn(conn);
  } finally {
    try { conn.close(); } catch { /* ya cerrada */ }
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

/** Convierte una tasa RouterOS ("1Gbps", "100Mbps", "10Mbps") a Mbps. */
export function parseRateMbps(s: string | undefined): number | null {
  if (!s) return null;
  const m = /([\d.]+)\s*(G|M|k)?bps/i.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const unit = (m[2] || 'M').toUpperCase();
  if (unit === 'G') return v * 1000;
  if (unit === 'K') return v / 1000;
  return v;
}

/** Lista los nombres de interfaces ethernet del router. */
async function listEthernet(conn: RouterOSAPI): Promise<string[]> {
  const rows = (await conn.write('/interface/ethernet/print')) as Record<string, string>[];
  return rows.map((r) => r['name']).filter(Boolean);
}

/**
 * Estado de enlace por puerto ethernet (velocidad negociada + dúplex). NO invasivo.
 * Un puerto Gigabit negociado a 100 Mbps o en half-duplex sugiere cable dañado.
 */
export async function getEthernetStatus(ip: string, creds: Credentials): Promise<EthernetStatus[]> {
  return withConnection(ip, creds, async (conn) => {
    const names = await listEthernet(conn);
    const out: EthernetStatus[] = [];
    for (const name of names) {
      try {
        const rows = (await conn.write('/interface/ethernet/monitor', [`=numbers=${name}`, '=once=']) ) as Record<string, string>[];
        const r = rows[0] ?? {};
        out.push({
          name,
          linkOk: (r['status'] || '') === 'link-ok',
          rateMbps: parseRateMbps(r['rate']),
          fullDuplex: r['full-duplex'] === undefined ? null : r['full-duplex'] === 'true',
          autoNegotiation: r['auto-negotiation'] === undefined ? null : r['auto-negotiation'] === 'done' || r['auto-negotiation'] === 'true',
        });
      } catch {
        // puerto sin soporte de monitor; se omite
      }
    }
    return out;
  });
}

/** Contadores de error de capa 1 por puerto (CRC/FCS/align/colisiones). NO invasivo. */
export async function getEthernetErrorStats(ip: string, creds: Credentials): Promise<EthernetErrorStats[]> {
  return withConnection(ip, creds, async (conn) => {
    const rows = (await conn.write('/interface/ethernet/print', ['=stats='])) as Record<string, string>[];
    return rows.map((r) => {
      const n = (k: string) => parseInt(r[k], 10) || 0;
      return {
        name: r['name'],
        crcErrors: n('rx-fcs-error') + n('rx-align-error') + n('rx-fragment'),
        collisions: n('tx-collision') + n('tx-late-collision'),
      };
    });
  });
}

/**
 * Prueba de cable TDR: par por par ok/abierto/corto + distancia a la falla.
 * INTERRUMPE el enlace ~1 s — solo bajo demanda, nunca en el loop de sondeo.
 */
export async function runCableTest(ip: string, creds: Credentials, iface: string): Promise<CableTestResult> {
  return withConnection(ip, creds, async (conn) => {
    try {
      const rows = (await conn.write('/interface/ethernet/cable-test', [`=numbers=${iface}`, '=duration=1'])) as Record<string, string>[];
      const r = rows[rows.length - 1] ?? {};
      const pairs: CablePair[] = [];
      // Formato A: campos cable-pair-N = "ok" | "open:12" | "short:5"
      for (let i = 0; i < 8; i++) {
        const raw = r[`cable-pair${i}`] ?? r[`cable-pair-${i}`];
        if (raw === undefined) continue;
        const [status, dist] = raw.split(':');
        pairs.push({ pair: String(i), status, distanceM: dist ? parseFloat(dist) : null });
      }
      // Formato B: un solo campo cable-pairs = "ok,ok,open:12,ok" o "1:ok 2:open:12 ..."
      if (pairs.length === 0 && r['cable-pairs']) {
        const tokens = r['cable-pairs'].trim().split(/[\s,]+/).filter(Boolean);
        tokens.forEach((tok, idx) => {
          const parts = tok.split(':');
          // "1:open:12" -> pair 1, status open, dist 12 ; "ok" -> pair idx, status ok
          if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
            pairs.push({ pair: parts[0], status: parts[1], distanceM: parts[2] ? parseFloat(parts[2]) : null });
          } else {
            pairs.push({ pair: String(idx + 1), status: parts[0], distanceM: parts[1] ? parseFloat(parts[1]) : null });
          }
        });
      }
      return { name: iface, supported: true, status: r['status'], pairs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // El chip/puerto (ej. SFP) puede no soportar cable-test
      if (/not supported|no such|failure|unknown/i.test(msg)) {
        return { name: iface, supported: false, note: 'Este puerto no soporta la prueba de cable (TDR)' };
      }
      throw err;
    }
  });
}

/** Corre cable-test en todas las interfaces ethernet (o en una específica). */
export async function runCableTestAll(ip: string, creds: Credentials, iface?: string): Promise<CableTestResult[]> {
  if (iface) return [await runCableTest(ip, creds, iface)];
  const names = await withConnection(ip, creds, (conn) => listEthernet(conn));
  const out: CableTestResult[] = [];
  for (const name of names) {
    try {
      out.push(await runCableTest(ip, creds, name));
    } catch (err) {
      out.push({ name, supported: false, note: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
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
