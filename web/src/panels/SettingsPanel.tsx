import { useEffect, useState } from 'react';
import { api } from '../api';
import { InfoTip } from '../components/InfoTip';

interface Props {
  onAiChanged: () => void; // recargar topología para refrescar el badge "IA activa"
}

type KeyStatus = { kind: 'ok' | 'fail' | 'pending'; text: string } | null;

const THRESHOLD_FIELDS: { key: string; label: string; help: string }[] = [
  { key: 'cpuPct', label: 'CPU máx (%)', help: 'CPU promedio de un MikroTik en 5 minutos por encima de este valor dispara alerta. Un router con CPU sostenida alta pierde paquetes en el reenvío.' },
  { key: 'signalDbm', label: 'Señal mín (dBm)', help: 'Señal de una antena por debajo de este valor (más negativo = peor) dispara alerta. Regla WISP: mejor que -65 buena, peor que -75 problemática.' },
  { key: 'lossPct', label: 'Pérdida máx (%)', help: 'Pérdida de paquetes promedio hacia un equipo en 5 minutos por encima de este valor dispara alerta.' },
  { key: 'utilizationPct', label: 'Utilización máx (%)', help: 'Utilización sostenida de un enlace por encima de este valor se considera zona de saturación (requiere capacidad configurada en el enlace).' },
  { key: 'saturationLossPct', label: 'Pérdida p/ saturación (%)', help: 'Pérdida hacia internet que, combinada con utilización alta, dispara la alerta crítica de saturación — la firma del problema de horas pico.' },
];

export function SettingsPanel({ onAiChanged }: Props) {
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeySource, setApiKeySource] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyStatus, setKeyStatus] = useState<KeyStatus>(null);
  const [thresholds, setThresholds] = useState<Record<string, number>>({});
  const [targets, setTargets] = useState('');
  const [saved, setSaved] = useState(false);

  const load = () =>
    api.settings().then((s) => {
      setHasApiKey(s.hasApiKey);
      setApiKeySource(s.apiKeySource);
      setThresholds(s.thresholds);
      setTargets(s.pcProbeTargets.join(', '));
    }).catch(() => {});

  useEffect(() => { void load(); }, []);

  const saveKey = async () => {
    const key = keyInput.trim();
    if (!key) return;
    setKeyStatus({ kind: 'pending', text: 'Validando clave con Anthropic…' });
    try {
      const test = await api.testApiKey(key);
      if (!test.ok) {
        setKeyStatus({ kind: 'fail', text: test.detail });
        return;
      }
      await api.saveSettings({ anthropicApiKey: key });
      setKeyInput('');
      setKeyStatus({ kind: 'ok', text: test.detail });
      await load();
      onAiChanged();
    } catch (err) {
      setKeyStatus({ kind: 'fail', text: String(err) });
    }
  };

  const removeKey = async () => {
    if (!confirm('¿Borrar la API key guardada? El diagnóstico con IA quedará deshabilitado.')) return;
    await api.saveSettings({ clearApiKey: true });
    setKeyStatus(null);
    await load();
    onAiChanged();
  };

  const saveGeneral = async () => {
    await api.saveSettings({
      thresholds,
      pcProbeTargets: targets.split(',').map((x) => x.trim()).filter(Boolean),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <div className="settings-section">
        <h3>
          🔑 API key de Anthropic (IA)
          <InfoTip text="La clave se guarda CIFRADA en la base de datos local de este PC — no hace falta tocar el archivo .env. Se usa solo para llamar a la API de Claude cuando pides un diagnóstico. Consíguela en console.anthropic.com. Si además existe ANTHROPIC_API_KEY en el .env, esa tiene prioridad." />
        </h3>
        {hasApiKey ? (
          <div>
            <div className="key-status ok">
              ✔ Hay una clave configurada {apiKeySource === 'env' ? '(desde el archivo .env)' : '(guardada desde esta interfaz, cifrada)'}
            </div>
            <div className="btn-row">
              <button className="ghost" onClick={() => void api.testApiKey().then((r) =>
                setKeyStatus({ kind: r.ok ? 'ok' : 'fail', text: r.detail }))}>
                Probar clave
              </button>
              {apiKeySource === 'ui' && (
                <button className="danger" onClick={() => void removeKey()}>Borrar clave</button>
              )}
            </div>
            {apiKeySource === 'ui' && (
              <div style={{ marginTop: 10 }}>
                <input
                  type="password"
                  placeholder="Pegar una clave nueva para reemplazarla (sk-ant-…)"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                />
                {keyInput.trim() && (
                  <div className="btn-row">
                    <button className="primary" onClick={() => void saveKey()}>Validar y reemplazar</button>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div>
            <p className="small" style={{ marginTop: 0 }}>
              Sin clave, el monitoreo funciona igual pero el chat de diagnóstico y el análisis
              automático de alertas quedan deshabilitados.
            </p>
            <input
              type="password"
              placeholder="sk-ant-…"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(); }}
            />
            <div className="btn-row">
              <button className="primary" onClick={() => void saveKey()} disabled={!keyInput.trim()}>
                Validar y guardar
              </button>
            </div>
          </div>
        )}
        {keyStatus && <div className={`key-status ${keyStatus.kind}`}>{keyStatus.text}</div>}
      </div>

      <div className="settings-section">
        <h3>
          🌐 Sondas desde este PC
          <InfoTip text="IPs externas a las que este PC hace ping continuo (cada 60 s). Como el PC está dentro de la red, su tráfico atraviesa toda la cadena igual que el de un cliente — si aquí hay pérdida pero el ping de los routers no la ve, el problema está en el camino de reenvío (colas/saturación). Recomendado: 8.8.8.8 y la IP pública del gateway del dedicado." />
        </h3>
        <input
          value={targets}
          placeholder="8.8.8.8, IP gateway público"
          onChange={(e) => setTargets(e.target.value)}
        />
      </div>

      <div className="settings-section">
        <h3>
          🚨 Umbrales de alerta
          <InfoTip text="Valores que disparan alertas automáticas. Cada alerta nueva recibe además un diagnóstico de la IA (si hay clave configurada). Las alertas se resuelven solas cuando la condición desaparece." />
        </h3>
        <div className="form-grid">
          {THRESHOLD_FIELDS.map((f) => (
            <span key={f.key} style={{ display: 'contents' }}>
              <label>
                {f.label}
                <InfoTip text={f.help} />
              </label>
              <input
                type="number"
                value={thresholds[f.key] ?? ''}
                onChange={(e) => setThresholds({ ...thresholds, [f.key]: parseFloat(e.target.value) })}
              />
            </span>
          ))}
        </div>
      </div>

      <div className="btn-row">
        <button className="primary" onClick={() => void saveGeneral()}>Guardar ajustes</button>
        {saved && <span className="key-status ok" style={{ alignSelf: 'center' }}>✔ Guardado</span>}
      </div>
    </div>
  );
}
