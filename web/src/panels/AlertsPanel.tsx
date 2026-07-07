import { useEffect, useState } from 'react';
import type { Alert } from '../types';
import { api } from '../api';
import { InfoTip } from '../components/InfoTip';

export function AlertsPanel({ refreshKey, focusStart }: { refreshKey: number; focusStart: number | null }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    const load = () => api.alerts().then((r) => setAlerts(r.alerts)).catch(() => {});
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [refreshKey]);

  const focusNote = focusStart ? (
    <div className="focus-note">
      🎯 Modo enfoque: solo alertas desde {new Date(focusStart * 1000).toLocaleString('es-CO')} (más las abiertas)
    </div>
  ) : null;

  const header = (
    <h3>
      Alertas
      <InfoTip text="Alertas automáticas por umbrales (configurables en ⚙ Ajustes): equipo caído, CPU alta, señal baja, pérdida alta y la crítica «saturación + pérdida» que delata las horas pico. Cada alerta nueva recibe un diagnóstico automático de la IA (🤖) que investiga la causa con los datos de la red. Se resuelven solas cuando la condición desaparece, o puedes marcarlas resueltas manualmente." />
    </h3>
  );

  if (alerts.length === 0) {
    return (
      <div>
        {focusNote}
        {header}
        <div className="empty-hint">Sin alertas. Cuando un umbral se supere aparecerán aquí con su diagnóstico IA.</div>
      </div>
    );
  }

  return (
    <div>
      {focusNote}
      {header}
      {alerts.map((a) => (
        <div key={a.id} className={`alert-item ${a.severity} ${a.resolved_at ? 'resolved' : ''}`}>
          <div>{a.message}</div>
          <div className="meta">
            {new Date(a.created_at * 1000).toLocaleString('es-CO')}
            {a.resolved_at ? ` · resuelta ${new Date(a.resolved_at * 1000).toLocaleTimeString('es-CO')}` : ''}
            {!a.resolved_at && (
              <>
                {' · '}
                <a
                  href="#"
                  style={{ color: '#7dd3fc' }}
                  onClick={(e) => {
                    e.preventDefault();
                    void api.resolveAlert(a.id).then(() => api.alerts().then((r) => setAlerts(r.alerts)));
                  }}
                >
                  marcar resuelta
                </a>
              </>
            )}
          </div>
          {a.ai_diagnosis && <div className="diag">🤖 {a.ai_diagnosis}</div>}
        </div>
      ))}
    </div>
  );
}
