import snmp, { type VarBind, type Session } from 'net-snmp';
import {
  UBNT_WLSTAT_TABLE, UBNT_WLSTAT_COLS,
  UBNT_AIRMAX_TABLE, UBNT_AIRMAX_COLS,
  MIMOSA_CHAIN_TABLE, MIMOSA_CHAIN_COLS,
  MIMOSA_PHY_TX, MIMOSA_PHY_RX,
  IF_NAME, IF_HC_IN_OCTETS, IF_HC_OUT_OCTETS,
  IF_HIGH_SPEED, IF_IN_ERRORS,
  DOT3_FCS_ERRORS, DOT3_ALIGN_ERRORS, DOT3_DUPLEX,
  SYS_DESCR, SYS_NAME,
} from '../snmp/oids.js';

function createSession(ip: string, community: string): Session {
  return snmp.createSession(ip, community || 'public', {
    timeout: 3000,
    retries: 1,
    version: snmp.Version2c,
  });
}

function subtree(session: Session, base: string): Promise<Map<string, VarBind>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, VarBind>();
    session.subtree(
      base,
      (varbinds: VarBind[]) => {
        for (const vb of varbinds) {
          if (!snmp.isVarbindError(vb)) out.set(vb.oid, vb);
        }
      },
      (error: Error | null) => (error ? reject(error) : resolve(out)),
    );
  });
}

function getOids(session: Session, oids: string[]): Promise<Map<string, VarBind>> {
  return new Promise((resolve, reject) => {
    session.get(oids, (error: Error | null, varbinds: VarBind[]) => {
      if (error) return reject(error);
      const out = new Map<string, VarBind>();
      for (const vb of varbinds) {
        if (!snmp.isVarbindError(vb)) out.set(vb.oid, vb);
      }
      resolve(out);
    });
  });
}

function num(vb: VarBind | undefined): number | null {
  if (!vb) return null;
  const v = vb.value;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (Buffer.isBuffer(v)) {
    const n = parseFloat(v.toString('utf8'));
    return Number.isFinite(n) ? n : null;
  }
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Extrae métricas de una tabla: para cada columna conocida, promedia sus filas. */
function mapTable(
  walk: Map<string, VarBind>,
  base: string,
  cols: Record<string, string>,
): Record<string, number> {
  const acc: Record<string, number[]> = {};
  for (const [oid, vb] of walk) {
    const rest = oid.slice(base.length + 1); // "col.index..."
    const col = rest.split('.')[0];
    const name = cols[col];
    if (!name) continue;
    const v = num(vb);
    if (v === null) continue;
    (acc[name] ??= []).push(v);
  }
  const out: Record<string, number> = {};
  for (const [name, values] of Object.entries(acc)) {
    out[name] = values.reduce((a, b) => a + b, 0) / values.length;
  }
  return out;
}

export interface SnmpIfCounters {
  name: string;
  inOctets: number;
  outOctets: number;
}

/** Métricas de radio Ubiquiti airMAX (señal, ruido, CCQ, tasas, estaciones, airMAX). */
export async function pollUbiquiti(ip: string, community: string): Promise<Record<string, number>> {
  const session = createSession(ip, community);
  try {
    const wl = await subtree(session, UBNT_WLSTAT_TABLE);
    const metrics = mapTable(wl, UBNT_WLSTAT_TABLE, UBNT_WLSTAT_COLS);
    try {
      const am = await subtree(session, UBNT_AIRMAX_TABLE);
      Object.assign(metrics, mapTable(am, UBNT_AIRMAX_TABLE, UBNT_AIRMAX_COLS));
    } catch {
      // equipos sin airMAX habilitado
    }
    return metrics;
  } finally {
    session.close();
  }
}

/** Métricas de radio Mimosa (señal/SNR por cadena promediado, throughput PHY). */
export async function pollMimosa(ip: string, community: string): Promise<Record<string, number>> {
  const session = createSession(ip, community);
  try {
    const metrics: Record<string, number> = {};
    try {
      const chains = await subtree(session, MIMOSA_CHAIN_TABLE);
      const chainMetrics = mapTable(chains, MIMOSA_CHAIN_TABLE, MIMOSA_CHAIN_COLS);
      // Algunos firmwares reportan potencia en centésimas de dB
      if (chainMetrics.signal_dbm !== undefined && Math.abs(chainMetrics.signal_dbm) > 200) {
        chainMetrics.signal_dbm = chainMetrics.signal_dbm / 100;
      }
      Object.assign(metrics, chainMetrics);
    } catch {
      // tabla no disponible en este firmware
    }
    try {
      const phy = await getOids(session, [MIMOSA_PHY_TX, MIMOSA_PHY_RX]);
      const tx = num(phy.get(MIMOSA_PHY_TX));
      const rx = num(phy.get(MIMOSA_PHY_RX));
      if (tx !== null) metrics.phy_tx_mbps = tx / 1000; // kbps -> Mbps
      if (rx !== null) metrics.phy_rx_mbps = rx / 1000;
    } catch {
      // escalares no disponibles
    }
    return metrics;
  } finally {
    session.close();
  }
}

/** Contadores de tráfico IF-MIB (para calcular Mbps por deltas). */
export async function pollIfCounters(ip: string, community: string): Promise<SnmpIfCounters[]> {
  const session = createSession(ip, community);
  try {
    const [names, inOct, outOct] = await Promise.all([
      subtree(session, IF_NAME),
      subtree(session, IF_HC_IN_OCTETS),
      subtree(session, IF_HC_OUT_OCTETS),
    ]);
    const out: SnmpIfCounters[] = [];
    for (const [oid, vb] of names) {
      const idx = oid.slice(IF_NAME.length + 1);
      const name = Buffer.isBuffer(vb.value) ? vb.value.toString('utf8') : String(vb.value);
      out.push({
        name,
        inOctets: num(inOct.get(`${IF_HC_IN_OCTETS}.${idx}`)) ?? 0,
        outOctets: num(outOct.get(`${IF_HC_OUT_OCTETS}.${idx}`)) ?? 0,
      });
    }
    return out;
  } finally {
    session.close();
  }
}

export interface SnmpLinkHealth {
  name: string;
  speedMbps: number | null;
  duplex: number | null;   // 1=full, 0=half, null=desconocido
  fcsErrors: number;       // acumulado (CRC/align)
  inErrors: number;        // acumulado
}

/**
 * Salud de enlace por interfaz vía IF-MIB + EtherLike-MIB: velocidad negociada,
 * dúplex y errores CRC/FCS. Best-effort: si un OID no está, se omite.
 */
export async function pollLinkHealth(ip: string, community: string): Promise<SnmpLinkHealth[]> {
  const session = createSession(ip, community);
  try {
    const [names, speed, inErr, fcs, align, duplex] = await Promise.all([
      subtree(session, IF_NAME),
      subtree(session, IF_HIGH_SPEED).catch(() => new Map<string, VarBind>()),
      subtree(session, IF_IN_ERRORS).catch(() => new Map<string, VarBind>()),
      subtree(session, DOT3_FCS_ERRORS).catch(() => new Map<string, VarBind>()),
      subtree(session, DOT3_ALIGN_ERRORS).catch(() => new Map<string, VarBind>()),
      subtree(session, DOT3_DUPLEX).catch(() => new Map<string, VarBind>()),
    ]);
    const out: SnmpLinkHealth[] = [];
    for (const [oid, vb] of names) {
      const idx = oid.slice(IF_NAME.length + 1);
      const name = Buffer.isBuffer(vb.value) ? vb.value.toString('utf8') : String(vb.value);
      const dpx = num(duplex.get(`${DOT3_DUPLEX}.${idx}`));
      out.push({
        name,
        speedMbps: num(speed.get(`${IF_HIGH_SPEED}.${idx}`)),
        duplex: dpx === null ? null : dpx === 3 ? 1 : dpx === 2 ? 0 : null,
        fcsErrors: (num(fcs.get(`${DOT3_FCS_ERRORS}.${idx}`)) ?? 0) + (num(align.get(`${DOT3_ALIGN_ERRORS}.${idx}`)) ?? 0),
        inErrors: num(inErr.get(`${IF_IN_ERRORS}.${idx}`)) ?? 0,
      });
    }
    return out;
  } finally {
    session.close();
  }
}

export async function testSnmp(ip: string, community: string): Promise<{ ok: boolean; detail: string }> {
  const session = createSession(ip, community);
  try {
    const res = await getOids(session, [SYS_DESCR, SYS_NAME]);
    const descr = res.get(SYS_DESCR);
    const name = res.get(SYS_NAME);
    const d = descr && Buffer.isBuffer(descr.value) ? descr.value.toString('utf8') : String(descr?.value ?? '');
    const n = name && Buffer.isBuffer(name.value) ? name.value.toString('utf8') : String(name?.value ?? '');
    return { ok: true, detail: `${n}: ${d}`.slice(0, 200) };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    session.close();
  }
}
