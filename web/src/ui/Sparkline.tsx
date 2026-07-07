import { useEffect, useState } from 'react';
import { api } from '../api';

export const METRIC_META: Record<string, { label: string; unit: string; color: string }> = {
  latency_ms: { label: 'Latencia', unit: 'ms', color: 'var(--accent)' },
  loss_pct: { label: 'Pérdida', unit: '%', color: 'var(--down)' },
  cpu_pct: { label: 'CPU', unit: '%', color: 'var(--warn)' },
  mem_pct: { label: 'Memoria', unit: '%', color: 'var(--accent2)' },
  signal_dbm: { label: 'Señal', unit: 'dBm', color: 'var(--up)' },
  noise_dbm: { label: 'Ruido', unit: 'dBm', color: 'var(--muted)' },
  ccq_pct: { label: 'CCQ', unit: '%', color: 'var(--up)' },
  snr_db: { label: 'SNR', unit: 'dB', color: 'var(--accent)' },
  stations: { label: 'Estaciones', unit: '', color: 'var(--accent2)' },
  rx_mbps: { label: 'RX', unit: 'Mbps', color: 'var(--up)' },
  tx_mbps: { label: 'TX', unit: 'Mbps', color: 'var(--accent)' },
  tx_drops: { label: 'Drops TX', unit: '', color: 'var(--down)' },
  rx_errors: { label: 'Errores RX', unit: '', color: 'var(--down)' },
  queue_drops: { label: 'Drops de cola', unit: '', color: 'var(--down)' },
  phy_rx_mbps: { label: 'PHY RX', unit: 'Mbps', color: 'var(--up)' },
  phy_tx_mbps: { label: 'PHY TX', unit: 'Mbps', color: 'var(--accent)' },
  airmax_quality_pct: { label: 'airMAX quality', unit: '%', color: 'var(--up)' },
  airmax_capacity_pct: { label: 'airMAX capacity', unit: '%', color: 'var(--accent)' },
  tx_rate_mbps: { label: 'Tasa TX', unit: 'Mbps', color: 'var(--accent)' },
  rx_rate_mbps: { label: 'Tasa RX', unit: 'Mbps', color: 'var(--up)' },
  rssi: { label: 'RSSI', unit: 'dBm', color: 'var(--up)' },
  utilization_pct: { label: 'Utilización', unit: '%', color: 'var(--warn)' },
  link_speed_mbps: { label: 'Velocidad enlace', unit: 'Mbps', color: 'var(--accent)' },
  duplex: { label: 'Dúplex', unit: '', color: 'var(--warn)' },
  crc_errors: { label: 'Errores CRC', unit: '', color: 'var(--down)' },
  collisions: { label: 'Colisiones', unit: '', color: 'var(--down)' },
};

export function Sparkline({ nodeId, edgeId, metric, hoursBack = 6 }: { nodeId?: number; edgeId?: number; metric: string; hoursBack?: number }) {
  const [pts, setPts] = useState<number[]>([]);
  const meta = METRIC_META[metric] ?? { label: metric, unit: '', color: 'var(--accent)' };

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.metrics(edgeId !== undefined ? { edgeId, metric, hoursBack } : { nodeId, metric, hoursBack })
        .then((r) => { if (alive) setPts(r.points.map((p) => p.value)); })
        .catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [nodeId, edgeId, metric, hoursBack]);

  const W = 200, H = 46;
  let line = '', area = '', last = '—', lo = '', hi = '';
  if (pts.length > 1) {
    const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
    const step = W / (pts.length - 1);
    const xy = pts.map((v, i) => [i * step, H - 4 - ((v - min) / span) * (H - 8)] as const);
    line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    area = `${line} L${W} ${H} L0 ${H} Z`;
    const lastV = pts[pts.length - 1];
    last = Number.isInteger(lastV) ? String(lastV) : lastV.toFixed(1);
    lo = String(Math.round(min)); hi = String(Math.round(max));
  } else if (pts.length === 1) {
    last = String(pts[0]);
  }

  return (
    <div style={{ background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 11, padding: '12px 13px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{meta.label}</span>
        <span className="mono" style={{ fontSize: 15, fontWeight: 700, color: meta.color }}>{last}<span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}> {meta.unit}</span></span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: H, display: 'block' }}>
        {area && <path d={area} fill={meta.color} opacity={0.13} />}
        {line && <path d={line} fill="none" stroke={meta.color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: 'var(--muted)', marginTop: 4 }}>
        <span>{lo}</span><span>últimas {hoursBack} h</span><span>{hi}</span>
      </div>
    </div>
  );
}
