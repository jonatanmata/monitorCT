import ping from 'ping';

export interface PingResult {
  alive: boolean;
  avgMs: number | null;
  lossPct: number;
  sent: number;
  received: number;
}

/**
 * Ping desde este PC usando el binario del sistema (funciona en Windows sin
 * permisos de administrador). count paquetes con timeout corto.
 */
export async function pingHost(host: string, count = 5): Promise<PingResult> {
  const res = await ping.promise.probe(host, {
    timeout: 2,
    min_reply: count,
  });
  const loss = parseFloat(res.packetLoss);
  const avg = parseFloat(res.avg);
  const lossPct = Number.isFinite(loss) ? loss : res.alive ? 0 : 100;
  const received = Math.round(count * (1 - lossPct / 100));
  return {
    alive: res.alive,
    avgMs: Number.isFinite(avg) ? avg : null,
    lossPct,
    sent: count,
    received,
  };
}
