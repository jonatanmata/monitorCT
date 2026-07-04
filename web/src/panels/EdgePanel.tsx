import { useEffect, useState } from 'react';
import type { ApiEdge, ApiNode } from '../types';
import { api } from '../api';
import { MetricChart } from './MetricChart';
import { InfoTip } from '../components/InfoTip';

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
      <h3>
        Enlace: {source?.name} → {target?.name}
        <InfoTip text="Un enlace representa el camino físico de la señal entre dos equipos (un PTP, un cable, la fibra del proveedor). Configurar su capacidad e interfaz de origen es lo que permite detectar SATURACIÓN: el sistema compara el tráfico real que pasa por la interfaz contra la capacidad y calcula el % de utilización cada minuto." />
      </h3>
      <div className="form-grid">
        <label>Etiqueta</label>
        <input value={form.label} placeholder="PTP Icononzo-Paramitos" onChange={(e) => setForm({ ...form, label: e.target.value })} />
        <label>Capacidad (Mbps)<InfoTip text="Capacidad REAL del enlace en Mbps, no la teórica: para un PTP Mimosa usa el throughput que de verdad entrega (visible en su interfaz); para el dedicado, el ancho de banda contratado; para un cable, la velocidad del puerto. Si el tráfico se acerca a este valor, el enlace se satura y descarta paquetes." /></label>
        <input
          value={form.capacityMbps}
          placeholder="ej. 100 (real del enlace)"
          onChange={(e) => setForm({ ...form, capacityMbps: e.target.value })}
        />
        <label>Interfaz origen<InfoTip text="Nombre de la interfaz EN EL EQUIPO ORIGEN del enlace por donde pasa este tráfico (ej. ether2, sfp1, wlan1 — como aparece en el MikroTik o en la antena). El sistema toma el tráfico de esa interfaz para calcular la utilización de este enlace." /></label>
        <input
          value={form.sourceInterface}
          placeholder="ether1, wlan1… (en el equipo origen)"
          onChange={(e) => setForm({ ...form, sourceInterface: e.target.value })}
        />
      </div>
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

      <h3>
        Utilización del enlace (%)
        <InfoTip text="Porcentaje de la capacidad configurada que está ocupando el tráfico real (el mayor entre subida y bajada). Por encima de ~85% sostenido, las colas del router empiezan a descartar paquetes — esa es la saturación de horas pico que el ping del router no muestra." />
      </h3>
      <MetricChart edgeId={edge.id} metric="utilization_pct" hoursBack={24} color="#f59e0b" />
    </div>
  );
}
