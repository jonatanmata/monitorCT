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

export interface RouterosFlow {
  wanDownMbps: number;
  wanUpMbps: number;
  connections: number;
  cpu: number;
  firewallDrops: number;   // nº de reglas filter con action=drop
  mangleRules: number;
  dstnatRules: number;
  filterRules: number;
  queues: { name: string; usedMbps: number; limitMbps: number | null; down: boolean }[];
}

/** Segundo valor de un par RouterOS "up/down" (ej. "1000000/2000000", "0/10M"). */
function pairDown(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const parts = s.split('/');
  return parts[1] ?? parts[0];
}
/** "10M" | "512k" | "1000000" -> Mbps */
function toMbps(s: string | undefined): number | null {
  if (!s) return null;
  const m = /([\d.]+)\s*(G|M|k)?/i.exec(s.trim());
  if (!m) return null;
  const v = parseFloat(m[1]);
  const u = (m[2] || '').toUpperCase();
  if (u === 'G') return v * 1000;
  if (u === 'M') return v;
  if (u === 'K') return v / 1000;
  return v / 1e6; // bits/s crudos
}

/**
 * Lee, en vivo por API RouterOS, los datos que alimentan la vista «Flujo RouterOS»:
 * throughput WAN (interfaz más cargada), nº de conexiones (conntrack), CPU,
 * conteos de reglas (mangle, dst-nat, filter/drop) y las simple queues por cliente.
 * Best-effort: cada consulta que falle degrada a 0/[] sin romper el conjunto.
 */
export async function getRouterosFlow(ip: string, creds: Credentials): Promise<RouterosFlow> {
  return withConnection(ip, creds, async (conn) => {
    const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
      try { return await fn(); } catch { return fallback; }
    };

    const cpu = await safe(async () => {
      const rows = (await conn.write('/system/resource/print')) as Record<string, string>[];
      return parseInt(rows[0]?.['cpu-load'], 10) || 0;
    }, 0);

    // Throughput por interfaz ethernet -> la más cargada es la "WAN".
    let wanDownMbps = 0, wanUpMbps = 0;
    await safe(async () => {
      const names = await listEthernet(conn);
      for (const name of names) {
        try {
          const rows = (await conn.write('/interface/monitor-traffic', [`=interface=${name}`, '=once=']))as Record<string, string>[];
          const r = rows[rows.length - 1] ?? {};
          const rx = (parseInt(r['rx-bits-per-second'], 10) || 0) / 1e6;
          const tx = (parseInt(r['tx-bits-per-second'], 10) || 0) / 1e6;
          if (rx > wanDownMbps) wanDownMbps = rx;
          if (tx > wanUpMbps) wanUpMbps = tx;
        } catch { /* interfaz sin monitor-traffic */ }
      }
    }, undefined);
    wanDownMbps = Math.round(wanDownMbps);
    wanUpMbps = Math.round(wanUpMbps);

    const connections = await safe(async () => {
      const rows = (await conn.write('/ip/firewall/connection/print', ['=count-only='])) as Record<string, string>[];
      const r0 = rows[0] as Record<string, string> | undefined;
      const ret = r0?.['ret'] ?? r0?.['count'];
      return ret ? parseInt(ret, 10) || 0 : rows.length;
    }, 0);

    const countChain = async (path: string, chain?: string) =>
      safe(async () => {
        const rows = (await conn.write(path)) as Record<string, string>[];
        return chain ? rows.filter((r) => r['chain'] === chain).length : rows.length;
      }, 0);

    const mangleRules = await countChain('/ip/firewall/mangle/print');
    const dstnatRules = await countChain('/ip/firewall/nat/print', 'dstnat');
    const filterRows = await safe(async () => (await conn.write('/ip/firewall/filter/print')) as Record<string, string>[], []);
    const filterRules = filterRows.length;
    const firewallDrops = filterRows.filter((r) => r['action'] === 'drop' || r['action'] === 'reject').length;

    const queues = await safe(async () => {
      const rows = (await conn.write('/queue/simple/print', ['=stats='])) as Record<string, string>[];
      return rows.map((r) => {
        const rateDown = pairDown(r['rate']);
        const limitDown = pairDown(r['max-limit']);
        const usedMbps = Math.round(((toMbps(rateDown) ?? 0)) * 10) / 10;
        const limMbps = toMbps(limitDown);
        return {
          name: r['name'] || '?',
          usedMbps,
          limitMbps: limMbps && limMbps > 0 ? Math.round(limMbps) : null,
          down: r['disabled'] === 'true',
        };
      });
    }, [] as RouterosFlow['queues']);

    return { wanDownMbps, wanUpMbps, connections, cpu, firewallDrops, mangleRules, dstnatRules, filterRules, queues };
  });
}

export type AuditSeverity = 'critical' | 'warning' | 'info' | 'ok';
export interface AuditFinding {
  severity: AuditSeverity;
  area: string;
  title: string;
  detail: string;
  recommendation?: string;
}
export interface AuditResult {
  findings: AuditFinding[];
  facts: { board: string; version: string; cpuPct: number; memPct: number; uptime: string };
}

/**
 * Auditoría de configuración MikroTik (SOLO LECTURA) enfocada en el síntoma WISP:
 * pérdida hacia internet en horas pico que el ping del propio router no muestra.
 * El sospechoso principal es FastTrack: las conexiones fast-tracked saltan las
 * colas/mangle, así que la saturación no se moldea ni se contabiliza — y el ping
 * del router (que tampoco pasa por colas) sale limpio. También revisa QoS, MSS
 * clamp con MTU reducida, conntrack, CPU y dúplex/velocidad de los puertos.
 */
export async function auditMikrotik(ip: string, creds: Credentials): Promise<AuditResult> {
  return withConnection(ip, creds, async (conn) => {
    const rows = async (path: string, params: string[] = []) => {
      try { return (await conn.write(path, params)) as Record<string, string>[]; } catch { return []; }
    };

    const res = (await rows('/system/resource/print'))[0] ?? {};
    const totalMem = parseInt(res['total-memory'], 10) || 0;
    const freeMem = parseInt(res['free-memory'], 10) || 0;
    const facts = {
      board: res['board-name'] || '?',
      version: res['version'] || '?',
      cpuPct: parseInt(res['cpu-load'], 10) || 0,
      memPct: totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0,
      uptime: res['uptime'] || '',
    };

    const filter = await rows('/ip/firewall/filter/print');
    const mangle = await rows('/ip/firewall/mangle/print');
    const simple = await rows('/queue/simple/print');
    const tree = await rows('/queue/tree/print');
    const ifaces = await rows('/interface/print');
    const track = (await rows('/ip/firewall/connection/tracking/print'))[0] ?? {};
    const eth = await getEthStatusInline(conn);

    const enabled = (r: Record<string, string>) => r['disabled'] !== 'true';
    const fasttrack = filter.filter((r) => r['action'] === 'fasttrack-connection' && enabled(r));
    const simpleCount = simple.length;
    const treeCount = tree.length;
    const hasQoS = simpleCount > 0 || treeCount > 0;
    const mssRules = mangle.filter((r) => r['action'] === 'change-mss' && enabled(r));
    const pppoe = ifaces.some((r) => (r['type'] || '').includes('pppoe'));
    const lowMtu = ifaces.some((r) => { const m = parseInt(r['mtu'], 10); return m && m < 1500; });

    const findings: AuditFinding[] = [];

    // 1) FastTrack — el sospechoso principal
    if (fasttrack.length > 0 && hasQoS) {
      findings.push({
        severity: 'critical', area: 'FastTrack',
        title: 'FastTrack activo junto con colas de QoS',
        detail: `Hay ${fasttrack.length} regla(s) fasttrack-connection activas y ${simpleCount + treeCount} cola(s) configuradas. Las conexiones fast-tracked SALTAN las simple queues, el queue tree y el mangle: no se moldean ni cuentan para la utilización. El tráfico que satura tus enlaces se vuelve invisible y sin control, mientras el ping del router (que tampoco pasa por colas) sale limpio — exactamente el síntoma que estás persiguiendo.`,
        recommendation: 'Desactiva FastTrack en el router donde aplicas QoS, o restringe la regla para que NO aplique al tráfico que quieres encolar. Al quitarlo, la utilización y los drops de cola empezarán a reflejar la saturación real.',
      });
    } else if (fasttrack.length > 0) {
      findings.push({
        severity: 'warning', area: 'FastTrack',
        title: 'FastTrack activo (sin colas todavía)',
        detail: `${fasttrack.length} regla(s) fasttrack-connection activas. FastTrack acelera el reenvío pero el tráfico fast-tracked ignora colas y mangle. Si más adelante configuras QoS aquí, la saturación no se moldeará para ese tráfico.`,
        recommendation: 'Cuando agregues colas, excluye de FastTrack el tráfico que quieras encolar (o quítalo en el router de borde).',
      });
    } else {
      findings.push({ severity: 'ok', area: 'FastTrack', title: 'FastTrack no está activo', detail: 'El tráfico reenviado pasa por el camino normal (mangle/colas), así que la utilización y los drops de cola son representativos.' });
    }

    // 2) QoS
    if (!hasQoS) {
      findings.push({
        severity: 'warning', area: 'Colas / QoS',
        title: 'Sin QoS configurado',
        detail: 'No hay simple queues ni queue tree. Cuando un enlace se satura, los descartes son arbitrarios y afectan por igual a todo (incluidos ACK, DNS y VoIP), lo que amplifica la pérdida percibida por los clientes.',
        recommendation: 'Define colas por cliente o por sector con el ancho realmente contratado, priorizando tráfico interactivo. Empieza por los routers cuyos PTP se saturan en hora pico.',
      });
    } else {
      findings.push({ severity: 'info', area: 'Colas / QoS', title: `${simpleCount} simple queues · ${treeCount} queue tree`, detail: 'Hay QoS configurado. Revisa que los límites coincidan con la capacidad real de cada enlace y que no haya colas huérfanas.' });
    }

    // 3) MSS clamp con MTU reducida
    if ((pppoe || lowMtu) && mssRules.length === 0) {
      findings.push({
        severity: 'warning', area: 'MTU / MSS',
        title: 'MTU reducida sin MSS clamp',
        detail: `Detecté ${pppoe ? 'PPPoE' : 'una interfaz con MTU < 1500'} pero ninguna regla mangle change-mss. Sin clamp, los paquetes TCP grandes se fragmentan o se descartan en silencio (PMTUD roto), causando pérdida intermitente que parece de RF pero no lo es.`,
        recommendation: 'Añade en mangle una regla chain=forward, protocol=tcp, tcp-flags=syn, action=change-mss, new-mss=clamp-to-pmtu.',
      });
    } else if (pppoe || lowMtu) {
      findings.push({ severity: 'ok', area: 'MTU / MSS', title: 'MSS clamp presente', detail: 'Hay regla change-mss para la MTU reducida detectada.' });
    }

    // 4) Conntrack
    const totalC = parseInt(track['total-entries'], 10) || 0;
    const maxC = parseInt(track['max-entries'], 10) || 0;
    if (maxC > 0 && totalC / maxC > 0.8) {
      findings.push({
        severity: 'warning', area: 'Conntrack',
        title: 'Tabla de conexiones casi llena',
        detail: `${totalC.toLocaleString('es')} / ${maxC.toLocaleString('es')} conexiones (${Math.round((totalC / maxC) * 100)}%). Con la tabla llena, las conexiones nuevas se descartan → pérdida y timeouts para los clientes.`,
        recommendation: 'Sube max-entries acorde a la RAM, o localiza equipos con muchísimas conexiones (P2P/escaneos) y limítalos.',
      });
    }

    // 5) CPU
    if (facts.cpuPct > 75) {
      findings.push({
        severity: 'warning', area: 'CPU',
        title: `CPU alta (${facts.cpuPct}%)`,
        detail: 'Con la CPU saturada el reenvío por software empieza a descartar paquetes en hora pico.',
        recommendation: 'Revisa reglas de firewall/mangle ineficientes o desordenadas, procesos torch/bandwidth-test corriendo, y considera hardware offload en los puertos donde no apliques QoS.',
      });
    }

    // 6) Dúplex / velocidad de puertos (capa física — cable)
    for (const p of eth) {
      if (!p.linkOk) continue;
      if (p.fullDuplex === false) {
        findings.push({ severity: 'warning', area: 'Cable', title: `Puerto ${p.name} en half-duplex`, detail: 'Half-duplex genera colisiones y pérdida; casi siempre es cable/conector o negociación fallida.', recommendation: `Revisa el UTP y conectores del puerto ${p.name}; corre la prueba TDR de cable.` });
      } else if (p.rateMbps !== null && p.rateMbps > 0 && p.rateMbps < 1000) {
        findings.push({ severity: 'info', area: 'Cable', title: `Puerto ${p.name} negociado a ${p.rateMbps} Mbps`, detail: 'Si el puerto y el equipo del otro extremo son Gigabit, negociar a 100/10 Mbps suele indicar un par del cable dañado.', recommendation: `Confirma la capacidad esperada del puerto ${p.name}; si debería ser Gigabit, revisa el cable (TDR).` });
      }
    }

    return { findings, facts };
  });
}

/** Estado de puertos ethernet reutilizando una conexión ya abierta (para la auditoría). */
async function getEthStatusInline(conn: RouterOSAPI): Promise<EthernetStatus[]> {
  const out: EthernetStatus[] = [];
  let names: string[] = [];
  try { names = await listEthernet(conn); } catch { return out; }
  for (const name of names) {
    try {
      const r = ((await conn.write('/interface/ethernet/monitor', [`=numbers=${name}`, '=once='])) as Record<string, string>[])[0] ?? {};
      out.push({
        name,
        linkOk: (r['status'] || '') === 'link-ok',
        rateMbps: parseRateMbps(r['rate']),
        fullDuplex: r['full-duplex'] === undefined ? null : r['full-duplex'] === 'true',
        autoNegotiation: r['auto-negotiation'] === undefined ? null : r['auto-negotiation'] === 'done' || r['auto-negotiation'] === 'true',
      });
    } catch { /* puerto sin monitor */ }
  }
  return out;
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
