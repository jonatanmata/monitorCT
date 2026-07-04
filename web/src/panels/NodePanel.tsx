import { useEffect, useState } from 'react';
import type { ApiNode, NodeType } from '../types';
import { NODE_TYPE_LABELS, ADDABLE_TYPES } from '../types';
import { api } from '../api';
import { MetricChart } from './MetricChart';
import { InfoTip } from '../components/InfoTip';

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

  // El nodo Monitor (PC) es la raíz: sin IP/credenciales/borrado; solo nombre.
  if (node.type === 'monitor') {
    return (
      <div>
        <h3>
          💻 {node.name}
          <InfoTip text="Este es el PC de monitoreo: la raíz de tu red y el origen de las sondas hacia internet (que se configuran en ⚙ Ajustes → «Sondas desde este PC»). Conéctalo al primer equipo arrastrando desde el punto azul de su borde derecho, y desde ahí construye la cadena hacia afuera. No se puede eliminar." />
        </h3>
        <div className="form-grid">
          <label>Nombre</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="btn-row">
          <button className="primary" onClick={() => void save()}>Guardar</button>
        </div>
        <p className="small" style={{ marginTop: 14 }}>
          Para «romper el hilo» y meter equipos intermedios (por ejemplo los 2 radios de un PTP),
          pasa el mouse sobre una conexión y pulsa el botón <b>+</b> que aparece en la mitad de la línea.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3>
        Equipo: {node.name}
        <InfoTip text="Configuración del equipo. Con la IP el sistema le hace ping cada 15 segundos. Con las credenciales correctas, además lee sus métricas cada 60 segundos: en MikroTik por API (CPU, memoria, tráfico, drops, colas) y en antenas por SNMP (señal, ruido, CCQ, SNR, capacidad). Usa «Probar conexión» después de guardar para validar cada protocolo." />
      </h3>
      <div className="form-grid">
        <label>Nombre</label>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <label>Tipo</label>
        <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as NodeType })}>
          {ADDABLE_TYPES.map((v) => (
            <option key={v} value={v}>{NODE_TYPE_LABELS[v]}</option>
          ))}
        </select>
        <label>IP</label>
        <input value={form.ip} placeholder="192.168.x.x" onChange={(e) => setForm({ ...form, ip: e.target.value })} />

        {isMikrotik && (
          <>
            <label>Usuario API<InfoTip text="Usuario del MikroTik para el protocolo API (puerto 8728). Habilítalo en el router: IP → Services → api. Basta un usuario con permisos de lectura + test (para poder ejecutar /ping). Se guarda cifrado en este PC." /></label>
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
            <label>Sondas externas<InfoTip text="IPs de internet a las que ESTE MikroTik hará ping cada 60 s vía su comando /ping (separadas por coma). Recomendado: 8.8.8.8 y la IP pública del gateway del proveedor. Sirve para comparar la pérdida desde cada punto de la red y delimitar el segmento que falla." /></label>
            <input
              value={form.probeTargets}
              placeholder="8.8.8.8, IP gateway público"
              onChange={(e) => setForm({ ...form, probeTargets: e.target.value })}
            />
            <label>IPs origen (src)<InfoTip text="LA CLAVE de esta red: el ping normal del router NO pasa por las colas ni el FastTrack, por eso «nunca pierde» aunque el enlace esté saturado. Si aquí pones una IP LAN del router (ej. la de su interfaz hacia los clientes), el ping se envía con esa IP de origen y se enruta/NATea como tráfico de cliente — revelando la pérdida real que sufren los clientes. Separa varias con coma." /></label>
            <input
              value={form.probeSrcAddresses}
              placeholder="IP LAN del router (simula cliente)"
              onChange={(e) => setForm({ ...form, probeSrcAddresses: e.target.value })}
            />
          </>
        )}
        {isSnmp && (
          <>
            <label>Community SNMP<InfoTip text="Contraseña de lectura SNMP de la antena (normalmente «public»). Habilita SNMP en el equipo: en Ubiquiti airOS → Services → SNMP Agent; en Mimosa → Preferences → Management → SNMP. Con esto el sistema lee señal, ruido, CCQ, SNR, capacidad airMAX y estaciones conectadas." /></label>
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

      <h3>
        Historial
        <InfoTip text="Series de tiempo de las métricas recolectadas de este equipo. Los datos crudos se guardan 48 horas y los promedios de 5 minutos, 30 días — suficiente para ver patrones de horas pico. La gráfica se actualiza sola cada 30 segundos." />
      </h3>
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
