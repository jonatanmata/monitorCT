import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../ui/meta';
import { type AlarmCfg, testAlarmSound } from '../ui/EmergencyAlarm';

interface Props {
  onAiChanged: () => void;
  focusStart: number | null;
  onFocusChanged: () => void;
  alarm: AlarmCfg;
  onAlarm: (cfg: AlarmCfg) => void;
}

const MODEL_LABELS: Record<string, string> = {
  'claude-opus-4-8': 'Opus 4.8 (máxima capacidad)',
  'claude-sonnet-5': 'Sonnet 5 (equilibrado)',
  'claude-haiku-4-5': 'Haiku 4.5 (económico)',
};

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button className="toggle" style={{ background: on ? 'var(--accent)' : 'var(--border2)' }} onClick={onClick}>
      <span className="knob" style={{ left: on ? 20 : 2 }} />
    </button>
  );
}

export function SettingsSection({ onAiChanged, focusStart, onFocusChanged, alarm, onAlarm }: Props) {
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeySource, setApiKeySource] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyStatus, setKeyStatus] = useState<{ kind: 'ok' | 'fail' | 'pending'; text: string } | null>(null);
  const [models, setModels] = useState({ diagnosis: '', economic: '' });
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const [targetInput, setTargetInput] = useState('');
  const [wipe, setWipe] = useState(false);

  const [upd, setUpd] = useState<Awaited<ReturnType<typeof api.updateStatus>> | null>(null);
  const [updBusy, setUpdBusy] = useState(false);
  const [updLog, setUpdLog] = useState<string | null>(null);

  const load = () => api.settings().then((s) => {
    setHasApiKey(s.hasApiKey); setApiKeySource(s.apiKeySource);
    setModels(s.aiModels); setModelOptions(s.aiModelOptions); setTargets(s.pcProbeTargets);
  }).catch(() => {});

  const checkUpdate = () => { setUpdBusy(true); api.updateStatus().then(setUpd).catch((e) => setUpdLog(String(e))).finally(() => setUpdBusy(false)); };

  useEffect(() => { load(); checkUpdate(); }, []);

  const saveModel = async (patch: { aiModelDiagnosis?: string; aiModelEconomic?: string }) => {
    setModels((m) => ({ diagnosis: patch.aiModelDiagnosis ?? m.diagnosis, economic: patch.aiModelEconomic ?? m.economic }));
    await api.saveSettings(patch);
  };

  const saveKey = async () => {
    const key = keyInput.trim();
    if (!key) return;
    setKeyStatus({ kind: 'pending', text: 'Validando clave con Anthropic…' });
    try {
      const t = await api.testApiKey(key);
      if (!t.ok) { setKeyStatus({ kind: 'fail', text: t.detail }); return; }
      await api.saveSettings({ anthropicApiKey: key });
      setKeyInput(''); setKeyStatus({ kind: 'ok', text: t.detail });
      await load(); onAiChanged();
    } catch (err) { setKeyStatus({ kind: 'fail', text: String(err) }); }
  };

  const saveTargets = (next: string[]) => { setTargets(next); void api.saveSettings({ pcProbeTargets: next }); };
  const addTarget = () => { const v = targetInput.trim(); if (!v) return; saveTargets([...targets, v]); setTargetInput(''); };

  const toggleFocus = async () => {
    if (focusStart) { await api.clearFocus(); onFocusChanged(); }
    else {
      if (!confirm('Iniciar nueva investigación desde ahora: el análisis considerará solo datos nuevos. Los viejos no se borran.')) return;
      await api.setFocus();
      if (wipe && confirm('Además vas a BORRAR definitivamente métricas, sondas y alertas anteriores. Irreversible. ¿Continuar?')) {
        await api.purgeFocus();
      }
      onFocusChanged();
    }
  };

  const applyUpdate = async () => {
    if (!confirm('Se descargará y compilará la versión nueva (puede tardar). Luego reinicia la app. ¿Continuar?')) return;
    setUpdBusy(true); setUpdLog('Descargando y compilando…');
    try { const r = await api.applyUpdate(); setUpdLog(r.log); if (r.ok) checkUpdate(); }
    catch (err) { setUpdLog(String(err)); } finally { setUpdBusy(false); }
  };

  const maskedKey = hasApiKey ? 'sk-ant-••••••••••••••••••••••••••••' : '';

  return (
    <div className="section-scroll">
      <div style={{ maxWidth: 680, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* IA */}
        <div className="card">
          <h3>Inteligencia artificial</h3>
          <p className="card-sub">Modelos híbridos: uno económico para diagnósticos automáticos, uno potente para el chat. La clave se guarda cifrada en este PC.</p>
          <label className="field" style={{ marginBottom: 14 }}>
            <span className="field-label">API key</span>
            {hasApiKey ? (
              <>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="inp" value={maskedKey} readOnly style={{ color: 'var(--text2)' }} />
                  <span className="chip" style={{ background: 'var(--upSoft)', color: 'var(--up)', padding: '0 10px' }}>
                    <Icon path="M4 10V7a4 4 0 0 1 8 0v3M4 10h16v10H4z" size={12} strokeWidth={2} />cifrada{apiKeySource === 'env' ? ' (.env)' : ''}
                  </span>
                </div>
                {apiKeySource === 'ui' && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <input className="inp" type="password" placeholder="Reemplazar clave (sk-ant-…)" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
                    <button className="btn" onClick={saveKey} disabled={!keyInput.trim()}>Reemplazar</button>
                    <button className="btn danger" onClick={async () => { if (confirm('¿Borrar la API key guardada?')) { await api.saveSettings({ clearApiKey: true }); await load(); onAiChanged(); } }}>Borrar</button>
                  </div>
                )}
              </>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="inp" type="password" placeholder="sk-ant-…" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveKey(); }} />
                <button className="btn primary" onClick={saveKey} disabled={!keyInput.trim()}>Validar y guardar</button>
              </div>
            )}
          </label>
          {keyStatus && <div className={`status-line ${keyStatus.kind}`} style={{ marginBottom: 12 }}>{keyStatus.text}</div>}
          {modelOptions.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <label className="field">
                <span className="field-label">Modelo del chat</span>
                <select className="inp sans" value={models.diagnosis} onChange={(e) => saveModel({ aiModelDiagnosis: e.target.value })}>
                  {modelOptions.map((m) => <option key={m} value={m}>{MODEL_LABELS[m] ?? m}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Modelo de alertas</span>
                <select className="inp sans" value={models.economic} onChange={(e) => saveModel({ aiModelEconomic: e.target.value })}>
                  {modelOptions.map((m) => <option key={m} value={m}>{MODEL_LABELS[m] ?? m}</option>)}
                </select>
              </label>
            </div>
          )}
        </div>

        {/* probe targets */}
        <div className="card">
          <h3>Targets de sonda del PC</h3>
          <p className="card-sub">Destinos que el PC de monitoreo sondea para medir pérdida hacia internet (su tráfico atraviesa toda la cadena como el de un cliente).</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 11 }}>
            {targets.map((t, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px' }}>
                <Icon path="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" size={14} stroke="var(--accent)" strokeWidth={2} />
                <span className="mono" style={{ flex: 1, fontSize: 12.5 }}>{t}</span>
                <button style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 15 }} onClick={() => saveTargets(targets.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            {targets.length === 0 && <div className="empty-hint" style={{ padding: 0 }}>Sin targets. Recomendado: 8.8.8.8 y la IP pública del gateway del dedicado.</div>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="inp" value={targetInput} placeholder="1.1.1.1 o dns.google" onChange={(e) => setTargetInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addTarget(); }} />
            <button className="btn" onClick={addTarget}>Añadir</button>
          </div>
        </div>

        {/* focus */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 4 }}>
            <h3>Modo enfoque · Nueva investigación</h3>
            <span className="chip" style={{ background: focusStart ? 'var(--accentSoft)' : 'var(--panel3)', color: focusStart ? 'var(--accent)' : 'var(--muted)' }}>{focusStart ? 'Activo' : 'Inactivo'}</span>
          </div>
          <p className="card-sub">Centra la matriz, saturación, alertas e IA en datos nuevos desde ahora, ignorando los antiguos. El historial por nodo se conserva completo.</p>
          {focusStart && <div className="status-line ok" style={{ marginTop: 0, marginBottom: 12 }}>🎯 Enfoque activo desde {new Date(focusStart * 1000).toLocaleString('es-CO')}</div>}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn primary" onClick={toggleFocus}>{focusStart ? 'Desactivar enfoque' : 'Iniciar investigación (desde ahora)'}</button>
            {!focusStart && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, color: 'var(--text2)', cursor: 'pointer' }}>
                <Toggle on={wipe} onClick={() => setWipe(!wipe)} />
                Borrar datos anteriores al activar (irreversible)
              </label>
            )}
            {focusStart && <button className="btn danger" onClick={async () => { if (confirm('BORRAR definitivamente todas las métricas, sondas y alertas anteriores al enfoque. Irreversible. ¿Continuar?')) { await api.purgeFocus(); onFocusChanged(); } }}>Limpiar datos anteriores</button>}
          </div>
        </div>

        {/* alarma de emergencia */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 4 }}>
            <h3>Alarma de emergencia (sonora)</h3>
            <span className="chip" style={{ background: alarm.enabled ? 'var(--upSoft)' : 'var(--panel3)', color: alarm.enabled ? 'var(--up)' : 'var(--muted)' }}>{alarm.enabled ? 'Activa' : 'Inactiva'}</span>
          </div>
          <p className="card-sub">Aviso emergente con sonido cuando cae un equipo de infraestructura (PTP sectorial, router, MikroTik o AP) o un equipo vigilado. Suena cada X segundos hasta que pulses «Aceptar». Se configura por navegador.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>Activar alarma sonora</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Modal rojo + bip repetido en esta pantalla</div>
              </div>
              <Toggle on={alarm.enabled} onClick={() => onAlarm({ ...alarm, enabled: !alarm.enabled })} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>Repetir el sonido cada</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Hasta que se acepte el aviso</div>
              </div>
              <select className="inp sans" style={{ width: 'auto' }} value={alarm.intervalSec} onChange={(e) => onAlarm({ ...alarm, intervalSec: parseInt(e.target.value, 10) })}>
                <option value={5}>5 s</option>
                <option value={10}>10 s</option>
                <option value={20}>20 s</option>
                <option value={30}>30 s</option>
                <option value={60}>60 s</option>
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>Incluir cualquier equipo</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Por defecto solo infraestructura y vigilados; actívalo para que también suene con clientes/LiteBeam</div>
              </div>
              <Toggle on={alarm.allDevices} onClick={() => onAlarm({ ...alarm, allDevices: !alarm.allDevices })} />
            </div>
            <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => testAlarmSound()}>Probar sonido</button>
          </div>
        </div>

        {/* updates */}
        <div className="card">
          <h3>Actualizaciones</h3>
          <p className="card-sub">Descarga automática desde GitHub. Requiere haber instalado con «git clone».</p>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: 'var(--panel2)', border: '1px solid var(--border)', borderRadius: 10, padding: '13px 15px' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Versión actual · {upd?.version ?? '—'}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                {upd?.note ? upd.note
                  : upd?.updateAvailable ? `¡Disponible! ${upd.behindBy} cambio${upd.behindBy > 1 ? 's' : ''}${upd.latestMessage ? ` — ${upd.latestMessage}` : ''}`
                  : upd?.hasGit ? 'Estás en la última versión.' : 'Comprueba si hay una versión nueva en el repositorio.'}
              </div>
            </div>
            {upd?.updateAvailable
              ? <button className="btn primary" style={{ flexShrink: 0 }} onClick={applyUpdate} disabled={updBusy}>{updBusy ? 'Aplicando…' : 'Actualizar ahora'}</button>
              : <button className="btn" style={{ flexShrink: 0 }} onClick={checkUpdate} disabled={updBusy}>{updBusy ? 'Buscando…' : 'Buscar'}</button>}
          </div>
          {upd?.hasGit && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 12, fontSize: 12.5, color: 'var(--text2)' }}>
              <Toggle on={upd.autoUpdate} onClick={() => api.setAutoUpdate(!upd.autoUpdate).then(() => setUpd((u) => u && { ...u, autoUpdate: !u.autoUpdate }))} />
              Actualizar automáticamente al reiniciar
            </label>
          )}
          {updLog && <pre className="update-log">{updLog}</pre>}
        </div>
      </div>
    </div>
  );
}
