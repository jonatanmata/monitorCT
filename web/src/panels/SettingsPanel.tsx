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
  { key: 'crcErrorsPer5min', label: 'Errores CRC / 5 min', help: 'Cantidad de errores CRC/FCS por puerto en 5 minutos que dispara alerta de cable. Errores CRC crecientes indican cable dañado, conector RJ45 mal ponchado o interferencia (EMI). También se alerta si un puerto Gigabit baja a 100 Mbps o queda en half-duplex.' },
];

export function SettingsPanel({ onAiChanged }: Props) {
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeySource, setApiKeySource] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyStatus, setKeyStatus] = useState<KeyStatus>(null);
  const [thresholds, setThresholds] = useState<Record<string, number>>({});
  const [targets, setTargets] = useState('');
  const [saved, setSaved] = useState(false);

  // Telegram
  type TgCfg = { enabled: boolean; hasToken: boolean; chatId: string; minSeverity: 'info' | 'warning' | 'critical'; notifyResolved: boolean; notifyDiagnosis: boolean };
  const [tg, setTg] = useState<TgCfg>({ enabled: false, hasToken: false, chatId: '', minSeverity: 'warning', notifyResolved: true, notifyDiagnosis: true });
  const [tgToken, setTgToken] = useState('');
  const [tgChatId, setTgChatId] = useState('');
  const [tgStatus, setTgStatus] = useState<KeyStatus>(null);

  // Actualizaciones
  const [upd, setUpd] = useState<Awaited<ReturnType<typeof api.updateStatus>> | null>(null);
  const [updChecking, setUpdChecking] = useState(false);
  const [updApplying, setUpdApplying] = useState(false);
  const [updLog, setUpdLog] = useState<string | null>(null);

  const load = () =>
    api.settings().then((s) => {
      setHasApiKey(s.hasApiKey);
      setApiKeySource(s.apiKeySource);
      setThresholds(s.thresholds);
      setTargets(s.pcProbeTargets.join(', '));
      setTg(s.telegram);
      setTgChatId(s.telegram.chatId);
    }).catch(() => {});

  useEffect(() => { void load(); void checkUpdate(); }, []);

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

  const saveTelegram = async () => {
    setTgStatus({ kind: 'pending', text: 'Guardando y probando el envío…' });
    try {
      // Guardar primero (token/chatId nuevos) y luego enviar prueba real
      await api.saveTelegram({
        enabled: true,
        botToken: tgToken.trim() || undefined,
        chatId: tgChatId.trim() || undefined,
      });
      const test = await api.testTelegram({});
      setTgStatus({ kind: test.ok ? 'ok' : 'fail', text: test.detail });
      setTgToken('');
      await load();
    } catch (err) {
      setTgStatus({ kind: 'fail', text: String(err) });
    }
  };

  const toggleTelegram = async (enabled: boolean) => {
    await api.saveTelegram({ enabled });
    await load();
  };

  const saveTgPref = async (patch: Partial<TgCfg>) => {
    setTg((prev) => ({ ...prev, ...patch }));
    await api.saveTelegram(patch);
  };

  const detectChat = async () => {
    setTgStatus({ kind: 'pending', text: 'Buscando mensajes recientes al bot…' });
    try {
      const r = await api.detectTelegramChat(tgToken.trim() || undefined);
      if (r.ok && r.chats.length) {
        setTgChatId(r.chats[0].id);
        setTgStatus({ kind: 'ok', text: `Detectado: ${r.chats.map((c) => `${c.name} (${c.id})`).join(', ')}` });
      } else {
        setTgStatus({ kind: 'fail', text: r.detail });
      }
    } catch (err) {
      setTgStatus({ kind: 'fail', text: String(err) });
    }
  };

  const checkUpdate = async () => {
    setUpdChecking(true);
    setUpdLog(null);
    try { setUpd(await api.updateStatus()); } catch (err) { setUpdLog(String(err)); } finally { setUpdChecking(false); }
  };

  const applyUpdate = async () => {
    if (!confirm('Se descargará y compilará la versión nueva (puede tardar un par de minutos). Luego reinicia la app para aplicarla. ¿Continuar?')) return;
    setUpdApplying(true);
    setUpdLog('Descargando y compilando…');
    try {
      const r = await api.applyUpdate();
      setUpdLog(r.log);
      if (r.ok) await checkUpdate();
    } catch (err) {
      setUpdLog(String(err));
    } finally {
      setUpdApplying(false);
    }
  };

  const removeTelegram = async () => {
    if (!confirm('¿Borrar la configuración de Telegram? Dejarás de recibir alertas allí.')) return;
    await api.saveTelegram({ clear: true });
    setTgToken('');
    setTgChatId('');
    setTgStatus(null);
    await load();
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
          ✈️ Alertas por Telegram
          <InfoTip text="Recibe las alertas (y sus diagnósticos de IA) en tu Telegram, usando TU propio bot. El token se guarda cifrado en este PC y los mensajes van directo de tu bot a tu chat, sin terceros." />
        </h3>
        <details className="tg-guide">
          <summary>¿Cómo lo configuro? (crear el bot en 2 minutos)</summary>
          <ol>
            <li>En Telegram busca <b>@BotFather</b> y envíale <code>/newbot</code>. Elige un nombre y un usuario que termine en <code>bot</code>. Te dará un <b>token</b> (ej. <code>7834…:AAH8x…</code>).</li>
            <li>Pega el token abajo y ábrele un chat a tu nuevo bot: envíale cualquier mensaje (ej. «hola»).</li>
            <li>Pulsa <b>«Detectar chat id»</b> — se completa solo. Luego <b>«Guardar y probar»</b> y te llegará un mensaje de prueba.</li>
            <li>¿Para un grupo del equipo? Crea el grupo, agrega el bot, escribe un mensaje ahí y usa «Detectar chat id» (los de grupo son negativos).</li>
          </ol>
        </details>
        {tg.hasToken ? (
          <div>
            <div className="key-status ok">✔ Bot configurado{tg.chatId ? ` · chat ${tg.chatId}` : ''}</div>
            <label className="switch-row" style={{ marginTop: 10 }}>
              <input type="checkbox" checked={tg.enabled} onChange={(e) => void toggleTelegram(e.target.checked)} />
              <span>{tg.enabled ? 'Notificaciones activadas' : 'Notificaciones pausadas'}</span>
            </label>

            {/* Preferencias: qué notificar */}
            <div className="tg-prefs">
              <div className="form-grid">
                <label>
                  Notificar desde
                  <InfoTip text="Severidad mínima que se envía a Telegram. «Advertencia» (recomendado) omite los avisos informativos; «Crítica» solo manda lo grave (caídas, saturación); «Todo» envía también las informativas." />
                </label>
                <select value={tg.minSeverity} onChange={(e) => void saveTgPref({ minSeverity: e.target.value as TgCfg['minSeverity'] })}>
                  <option value="info">Todo (info, advertencia y crítica)</option>
                  <option value="warning">Advertencia o superior</option>
                  <option value="critical">Solo críticas</option>
                </select>
              </div>
              <label className="switch-row" style={{ marginTop: 8 }}>
                <input type="checkbox" checked={tg.notifyResolved} onChange={(e) => void saveTgPref({ notifyResolved: e.target.checked })} />
                <span>Avisar también cuando una alerta se resuelve (✅)</span>
              </label>
              <label className="switch-row" style={{ marginTop: 6 }}>
                <input type="checkbox" checked={tg.notifyDiagnosis} onChange={(e) => void saveTgPref({ notifyDiagnosis: e.target.checked })} />
                <span>Incluir el diagnóstico de la IA (🤖)</span>
              </label>
            </div>

            <div className="btn-row">
              <button className="ghost" onClick={() => void api.testTelegram({}).then((r) => setTgStatus({ kind: r.ok ? 'ok' : 'fail', text: r.detail }))}>
                Enviar prueba
              </button>
              <button className="danger" onClick={() => void removeTelegram()}>Borrar</button>
            </div>
            <div style={{ marginTop: 10 }}>
              <input
                type="password"
                placeholder="Reemplazar token del bot (opcional)"
                value={tgToken}
                onChange={(e) => setTgToken(e.target.value)}
              />
              <input
                style={{ marginTop: 6 }}
                placeholder="Chat id"
                value={tgChatId}
                onChange={(e) => setTgChatId(e.target.value)}
              />
              <div className="btn-row">
                <button className="primary" onClick={() => void saveTelegram()}>Guardar y probar</button>
                <button className="ghost" onClick={() => void detectChat()}>Detectar chat id</button>
              </div>
            </div>
          </div>
        ) : (
          <div>
            <input
              type="password"
              placeholder="Token del bot (de @BotFather)"
              value={tgToken}
              onChange={(e) => setTgToken(e.target.value)}
            />
            <input
              style={{ marginTop: 6 }}
              placeholder="Chat id"
              value={tgChatId}
              onChange={(e) => setTgChatId(e.target.value)}
            />
            <div className="btn-row">
              <button className="primary" onClick={() => void saveTelegram()} disabled={!tgToken.trim() || !tgChatId.trim()}>
                Guardar y probar
              </button>
              <button className="ghost" onClick={() => void detectChat()} disabled={!tgToken.trim()}>
                Detectar chat id
              </button>
            </div>
            <p className="small" style={{ marginTop: 8 }}>
              ¿No sabes tu chat id? Pega el token, envíale cualquier mensaje a tu bot en Telegram y pulsa
              <b> «Detectar chat id»</b> — lo completa solo.
            </p>
          </div>
        )}
        {tgStatus && <div className={`key-status ${tgStatus.kind}`}>{tgStatus.text}</div>}
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

      <div className="settings-section" style={{ marginTop: 14 }}>
        <h3>
          🔄 Actualizaciones
          <InfoTip text="El sistema se actualiza solo desde GitHub: cada vez que reinicias la app, comprueba si hay una versión nueva y, si la hay, la descarga y compila antes de arrancar (si algo falla, arranca igual con la versión que ya tenías). También puedes descargarla ahora con «Actualizar ahora» y luego reiniciar. Requiere haber instalado el proyecto con «git clone»." />
        </h3>
        {upd && (
          <div className="small" style={{ marginBottom: 8 }}>
            Versión <b>{upd.version}</b>
            {upd.currentCommit && ` · ${upd.currentCommit}`}
            {upd.currentDate && ` · ${upd.currentDate}`}
          </div>
        )}
        {upd?.note && <div className="key-status pending">{upd.note}</div>}
        {upd?.updateAvailable && (
          <div className="key-status ok" style={{ marginBottom: 8 }}>
            🎉 Hay una actualización disponible ({upd.behindBy} cambio{upd.behindBy > 1 ? 's' : ''})
            {upd.latestMessage && <>: <i>{upd.latestMessage}</i></>}
          </div>
        )}
        {upd && upd.hasGit && !upd.updateAvailable && !upd.note && (
          <div className="key-status pending">Estás en la última versión.</div>
        )}
        {upd?.hasGit && (
          <label className="switch-row" style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={upd.autoUpdate}
              onChange={(e) => void api.setAutoUpdate(e.target.checked).then(() => setUpd((u) => u && { ...u, autoUpdate: e.target.checked }))}
            />
            <span>Actualizar automáticamente al reiniciar</span>
          </label>
        )}
        <div className="btn-row">
          <button className="ghost" onClick={() => void checkUpdate()} disabled={updChecking || updApplying}>
            {updChecking ? 'Buscando…' : 'Buscar actualizaciones'}
          </button>
          {upd?.updateAvailable && (
            <button className="primary" onClick={() => void applyUpdate()} disabled={updApplying}>
              {updApplying ? 'Actualizando…' : 'Actualizar ahora'}
            </button>
          )}
        </div>
        {updLog && <pre className="update-log">{updLog}</pre>}
        {upd?.updateAvailable && !updApplying && (
          <p className="small">Tras «Actualizar ahora» (o simplemente al reiniciar la app) tendrás la versión nueva.</p>
        )}
      </div>
    </div>
  );
}
