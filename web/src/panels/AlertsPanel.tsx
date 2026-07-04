import { useEffect, useState } from 'react';
import type { Alert } from '../types';
import { api } from '../api';

export function AlertsPanel({ refreshKey }: { refreshKey: number }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    const load = () => api.alerts().then((r) => setAlerts(r.alerts)).catch(() => {});
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [refreshKey]);

  if (alerts.length === 0) {
    return <div className="empty-hint">Sin alertas. Cuando un umbral se supere aparecerán aquí con su diagnóstico IA.</div>;
  }

  return (
    <div>
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
