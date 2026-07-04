import { useEffect, useState } from 'react';
import type { ApiEdge, ApiNode } from '../types';
import { api } from '../api';
import { MetricChart } from './MetricChart';

interface Props {
  edge: ApiEdge;
  nodes: ApiNode[];
  onChanged: () => void;
  onDeleted: () => void;
}

export function EdgePanel({ edge, nodes, onChanged, onDeleted }: Props) {
  const [form, setForm] = useState({
    label: edge.label,
    capacityMbps: edge.capacity_mbps?.toString() ?? '',
    sourceInterface: edge.source_interface,
  });

  useEffect(() => {
    setForm({
      label: edge.label,
      capacityMbps: edge.capacity_mbps?.toString() ?? '',
      sourceInterface: edge.source_interface,
    });
  }, [edge.id]);

  const source = nodes.find((n) => n.id === edge.source_id);
  const target = nodes.find((n) => n.id === edge.target_id);

  const save = async () => {
    await api.updateEdge(edge.id, {
      label: form.label,
      capacityMbps: form.capacityMbps ? parseFloat(form.capacityMbps) : null,
      sourceInterface: form.sourceInterface,
    });
    onChanged();
  };

  return (
    <div>
      <h3>Enlace: {source?.name} → {target?.name}</h3>
      <div className="form-grid">
        <label>Etiqueta</label>
        <input value={form.label} placeholder="PTP Icononzo-Paramitos" onChange={(e) => setForm({ ...form, label: e.target.value })} />
        <label>Capacidad (Mbps)</label>
        <input
          value={form.capacityMbps}
          placeholder="ej. 100 (real del enlace)"
          onChange={(e) => setForm({ ...form, capacityMbps: e.target.value })}
        />
        <label>Interfaz origen</label>
        <input
          value={form.sourceInterface}
          placeholder="ether1, wlan1… (en el equipo origen)"
          onChange={(e) => setForm({ ...form, sourceInterface: e.target.value })}
        />
      </div>
      <p className="small">
        La capacidad y la interfaz de origen permiten calcular el % de utilización del enlace —
        necesario para detectar saturación en horas pico.
      </p>
      <div className="btn-row">
        <button className="primary" onClick={() => void save()}>Guardar</button>
        <button
          className="danger"
          onClick={() => {
            if (confirm('¿Eliminar este enlace?')) void api.deleteEdge(edge.id).then(onDeleted);
          }}
        >
          Eliminar
        </button>
      </div>

      <h3>Utilización del enlace (%)</h3>
      <MetricChart edgeId={edge.id} metric="utilization_pct" hoursBack={24} color="#f59e0b" />
    </div>
  );
}
