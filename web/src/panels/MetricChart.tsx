import { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api } from '../api';

interface Props {
  nodeId?: number;
  edgeId?: number;
  metric: string;
  hoursBack: number;
  color?: string;
}

export function MetricChart({ nodeId, edgeId, metric, hoursBack, color = '#7dd3fc' }: Props) {
  const [data, setData] = useState<{ t: string; v: number }[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .metrics({ nodeId, edgeId, metric, hoursBack })
        .then((res) => {
          if (!alive) return;
          setData(
            res.points.map((p) => ({
              t: new Date(p.ts * 1000).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
              v: Math.round(p.value * 100) / 100,
            })),
          );
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [nodeId, edgeId, metric, hoursBack]);

  if (data.length === 0) return <div className="small" style={{ padding: 8 }}>Sin datos de {metric} aún.</div>;

  return (
    <div style={{ height: 160 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
          <XAxis dataKey="t" tick={{ fontSize: 10, fill: '#64748b' }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10, fill: '#64748b' }} width={50} />
          <Tooltip
            contentStyle={{ background: '#161d2e', border: '1px solid #2a3550', fontSize: 12 }}
            labelStyle={{ color: '#94a3b8' }}
          />
          <Line type="monotone" dataKey="v" stroke={color} dot={false} strokeWidth={1.5} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
