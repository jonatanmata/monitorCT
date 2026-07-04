import { useEffect, useState } from 'react';
import type { ApiNode, NodeType } from '../types';
import { NODE_TYPE_LABELS } from '../types';
import { api } from '../api';
import { MetricChart } from './MetricChart';

interface Props {
  node: ApiNode;
  onChanged: () => void;
  onDeleted: () => void;
}

const METRIC_LABELS: Record<string, string> = {
  latency_ms: 'Latencia (ms)',
  loss_pct: 'Pérdida (%)',
  cpu_pct: 'CPU (%)',
  mem_pct: 'Memoria (%)',
  signal_dbm: 'Señal (dBm)',
  noise_dbm: 'Ruido (dBm)',
  ccq_pct: 'CCQ (%)',
  snr_db: 'SNR (dB)',
  stations: 'Estaciones',
  rx_mbps: 'RX (Mbps)',
  tx_mbps: 'TX (Mbps)',
  tx_drops: 'Drops TX',
  rx_errors: 'Errores RX',
  queue_drops: 'Drops de cola',
  phy_rx_mbps: 'PHY RX (Mbps)',
  phy_tx_mbps: 'PHY TX (Mbps)',
  airmax_quality_pct: 'airMAX quality (%)',
  airmax_capacity_pct: 'airMAX capacity (%)',
  tx_rate_mbps: 'Tasa TX (Mbps)',
  rx_rate_mbps: 'Tasa RX (Mbps)',
  rssi: 'RSSI',
};

export function NodePanel({ node, onChanged, onDeleted }: Props) {
  const [form, setForm] = useState({
    name: node.name,
    ip: node.ip,
    type: node.type as NodeType,
    routerosUser: '',
    routerosPass: '',
    snmpCommunity: node.snmpCommunity,
    probeTargets: node.probeTargets.join(', '),
    probeSrcAddresses: node.probeSrcAddresses.join(', '),
  });
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; detail: string }> | null>(null);
  const [testing, setTesting] = useState(false);
  const [available, setAvailable] = useState<string[]>([]);
  const [metric, setMetric] = useState('latency_ms');
  const [hoursBack, setHoursBack] = useState(6);

  useEffect(() => {
    setForm({
      name: node.name,
      ip: node.ip,
      type: node.type,
      routerosUser: '',
      routerosPass: '',
      snmpCommunity: node.snmpCommunity,
      probeTargets: node.probeTargets.join(', '),
      probeSrcAddresses: node.probeSrcAddresses.join(', '),
    });
    setTestResult(null);
    api.availableMetrics({ nodeId: node.id }).then((r) => {
      setAvailable(r.metrics);
      if (r.metrics.length && !r.metrics.includes('latency_ms')) setMetric(r.metrics[0]);
      else setMetric('latency_ms');
    }).catch(() => setAvailable([]));
  }, [node.id]);

  const parseList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

  const save = async () => {
    await api.updateNode(node.id, {
      name: form.name,
      ip: form.ip,
      type: form.type,
      probeTargets: parseList(form.probeTargets),
      probeSrcAddresses: parseList(form.probeSrcAddresses),
      credentials: {
        routerosUser: form.routerosUser,
        routerosPass: form.routerosPass,
        snmpCommunity: form.snmpCommunity,
      },
    });
    onChanged();
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await save();
      setTestResult(await api.testNode(node.id));
    } catch (err) {
      setTestResult({ error: { ok: false, detail: String(err) } });
    } finally {
      setTesting(false);
    }
  };

  const isMikrotik = form.type === 'mikrotik';
  const isSnmp = form.type === 'ptp-mimosa' || form.type === 'ap-ubiquiti' || form.type === 'cliente';

  return (
    <div>
      <h3>Equipo: {node.name}</h3>
      <div className="form-grid">
        <label>Nombre</label>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <label>Tipo</label>
        <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as NodeType })}>
          {Object.entries(NODE_TYPE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <label>IP</label>
        <input value={form.ip} placeholder="192.168.x.x" onChange={(e) => setForm({ ...form, ip: e.target.value })} />

        {isMikrotik && (
          <>
            <label>Usuario API</label>
            <input
              value={form.routerosUser}
              placeholder={node.hasRouterosCreds ? '(guardado — escribir para cambiar)' : 'admin'}
              onChange={(e) => setForm({ ...form, routerosUser: e.target.value })}
            />
            <label>Clave API</label>
            <input
              type="password"
              value={form.routerosPass}
              placeholder={node.hasRouterosCreds ? '(guardada)' : ''}
              onChange={(e) => setForm({ ...form, routerosPass: e.target.value })}
            />
            <label>Sondas externas</label>
            <input
              value={form.probeTargets}
              placeholder="8.8.8.8, IP gateway público"
              onChange={(e) => setForm({ ...form, probeTargets: e.target.value })}
            />
            <label>IPs origen (src)</label>
            <input
              value={form.probeSrcAddresses}
              placeholder="IP LAN del router (simula cliente)"
              onChange={(e) => setForm({ ...form, probeSrcAddresses: e.target.value })}
            />
          </>
        )}
        {isSnmp && (
          <>
            <label>Community SNMP</label>
            <input
              value={form.snmpCommunity}
              placeholder="public"
              onChange={(e) => setForm({ ...form, snmpCommunity: e.target.value })}
            />
          </>
        )}
      </div>

      <div className="btn-row">
        <button className="primary" onClick={() => void save()}>Guardar</button>
        <button className="ghost" onClick={() => void test()} disabled={testing}>
          {testing ? 'Probando…' : 'Probar conexión'}
        </button>
        <button
          className="danger"
          onClick={() => {
            if (confirm(`¿Eliminar ${node.name}? Se borran también sus métricas.`)) {
              void api.deleteNode(node.id).then(onDeleted);
            }
          }}
        >
          Eliminar
        </button>
      </div>

      {testResult && (
        <div className="test-result">
          {Object.entries(testResult).map(([k, v]) => (
            <div key={k} className={v.ok ? 'ok' : 'fail'}>
              {v.ok ? '✔' : '✘'} {k}: {v.detail}
            </div>
          ))}
        </div>
      )}

      <h3>Historial</h3>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <select value={metric} onChange={(e) => setMetric(e.target.value)}>
          {[...new Set(['latency_ms', 'loss_pct', ...available])].map((m) => (
            <option key={m} value={m}>{METRIC_LABELS[m] ?? m}</option>
          ))}
        </select>
        <select value={hoursBack} onChange={(e) => setHoursBack(parseInt(e.target.value, 10))}>
          <option value={1}>1 h</option>
          <option value={6}>6 h</option>
          <option value={24}>24 h</option>
          <option value={168}>7 días</option>
        </select>
      </div>
      <MetricChart nodeId={node.id} metric={metric} hoursBack={hoursBack} />
    </div>
  );
}
