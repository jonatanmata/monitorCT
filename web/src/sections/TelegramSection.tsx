import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../ui/meta';

type Sev = 'info' | 'warning' | 'critical';
type TgCfg = { enabled: boolean; hasToken: boolean; chatId: string; minSeverity: Sev; notifyResolved: boolean; notifyDiagnosis: boolean };

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button className="toggle" style={{ background: on ? 'var(--accent)' : 'var(--border2)' }} onClick={onClick}>
      <span className="knob" style={{ left: on ? 20 : 2 }} />
    </button>
  );
}

export function TelegramSection() {
  const [cfg, setCfg] = useState<TgCfg>({ enabled: false, hasToken: false, chatId: '', minSeverity: 'warning', notifyResolved: true, notifyDiagnosis: true });
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'fail' | 'pending'; text: string } | null>(null);
  const [sentLabel, setSentLabel] = useState('Enviar prueba');

  const load = () => api.settings().then((s) => { setCfg(s.telegram); setChatId(s.telegram.chatId); }).catch(() => {});
  useEffect(() => { load(); }, []);

  const configured = cfg.hasToken && !!cfg.chatId;

  const saveAndTest = async () => {
    setStatus({ kind: 'pending', text: 'Guardando y enviando prueba…' });
    try {
      await api.saveTelegram({ enabled: true, botToken: token.trim() || undefined, chatId: chatId.trim() || undefined });
      const t = await api.testTelegram({});
      setStatus({ kind: t.ok ? 'ok' : 'fail', text: t.detail });
      setToken('');
      await load();
    } catch (err) { setStatus({ kind: 'fail', text: String(err) }); }
  };

  const detect = async () => {
    setDetecting(true);
    setStatus({ kind: 'pending', text: 'Buscando mensajes recientes al bot…' });
    try {
      const r = await api.detectTelegramChat(token.trim() || undefined);
      if (r.ok && r.chats.length) {
        setChatId(r.chats[0].id);
        setStatus({ kind: 'ok', text: `Detectado: ${r.chats.map((c) => `${c.name} (${c.id})`).join(', ')}` });
      } else setStatus({ kind: 'fail', text: r.detail });
    } catch (err) { setStatus({ kind: 'fail', text: String(err) }); } finally { setDetecting(false); }
  };

  const savePref = async (patch: Partial<TgCfg>) => { setCfg((p) => ({ ...p, ...patch })); await api.saveTelegram(patch); };

  const test = async () => {
    setSentLabel('Enviando…');
    const r = await api.testTelegram({});
    setStatus({ kind: r.ok ? 'ok' : 'fail', text: r.detail });
    setSentLabel(r.ok ? '✓ Enviado' : 'Enviar prueba');
    setTimeout(() => setSentLabel('Enviar prueba'), 2500);
  };

  return (
    <div className="section-scroll">
      <div style={{ maxWidth: 640, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* bot */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <span style={{ width: 34, height: 34, borderRadius: 9, background: '#2aabee', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon path="M22 4L2 11l6 2 2 6 3-4 5 4z" size={19} fill="#fff" stroke="none" />
            </span>
            <div>
              <h3>Bot de Telegram</h3>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>Conecta un bot para recibir alertas y diagnósticos</div>
            </div>
            <div style={{ flex: 1 }} />
            <span className="chip" style={{ background: configured ? 'var(--upSoft)' : 'var(--panel3)', color: configured ? 'var(--up)' : 'var(--muted)', padding: '3px 10px' }}>{configured ? 'Conectado' : 'Sin configurar'}</span>
          </div>

          <label className="field" style={{ marginBottom: 13 }}>
            <span className="field-label">Token del bot {cfg.hasToken && '(guardado — escribe para reemplazar)'}</span>
            <input className="inp" value={token} onChange={(e) => setToken(e.target.value)} placeholder={cfg.hasToken ? '••••••••••' : '123456789:ABCdef...'} />
          </label>
          <label className="field">
            <span className="field-label">Chat ID</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="inp" value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="sin detectar" />
              <button className="btn" style={{ flexShrink: 0 }} onClick={detect} disabled={detecting}>{detecting ? 'Detectando…' : 'Detectar'}</button>
            </div>
            <span style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>Envía un mensaje al bot (o al grupo con el bot dentro) y pulsa detectar para capturar el chat id.</span>
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn primary" onClick={saveAndTest}>Guardar y probar</button>
            {cfg.hasToken && <button className="btn danger" onClick={async () => { if (confirm('¿Borrar la configuración de Telegram?')) { await api.saveTelegram({ clear: true }); setToken(''); setChatId(''); setStatus(null); await load(); } }}>Borrar</button>}
          </div>
          {status && <div className={`status-line ${status.kind}`}>{status.text}</div>}
        </div>

        {/* preferences */}
        <div className="card">
          <h3 style={{ marginBottom: 15 }}>Preferencias de envío</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>Severidad mínima</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Solo enviar alertas de este nivel o superior</div>
              </div>
              <select className="inp sans" style={{ width: 'auto' }} value={cfg.minSeverity} onChange={(e) => savePref({ minSeverity: e.target.value as Sev })}>
                <option value="info">Info</option>
                <option value="warning">Advertencia</option>
                <option value="critical">Crítica</option>
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>Avisar al resolver</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Notificar cuando una alerta se cierra</div>
              </div>
              <Toggle on={cfg.notifyResolved} onClick={() => savePref({ notifyResolved: !cfg.notifyResolved })} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>Incluir diagnóstico IA</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Adjuntar el análisis de la IA al mensaje</div>
              </div>
              <Toggle on={cfg.notifyDiagnosis} onClick={() => savePref({ notifyDiagnosis: !cfg.notifyDiagnosis })} />
            </div>
          </div>
        </div>

        {/* preview */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13 }}>
            <h3>Vista previa</h3>
            <button className="btn primary" onClick={test} disabled={!configured}>{sentLabel}</button>
          </div>
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 11, padding: '13px 15px', fontSize: 13, lineHeight: 1.6, color: 'var(--text2)' }}>
            <div style={{ fontWeight: 600, color: 'var(--down)', marginBottom: 3 }}>🔴 Monitor CT · Alerta crítica</div>
            Cliente Soto (10.0.10.60) sin respuesta — 12/12 pings perdidos.
            <div style={{ marginTop: 7, fontSize: 12, color: 'var(--muted)' }}><b style={{ color: 'var(--accent)' }}>IA:</b> Backbone sano; corte local al abonado. Verificar PoE / reinicio del CPE.</div>
          </div>
          {!configured && <p className="card-sub" style={{ marginBottom: 0, marginTop: 12 }}>Configura el bot y el chat id arriba para habilitar el envío de prueba.</p>}
        </div>
      </div>
    </div>
  );
}
