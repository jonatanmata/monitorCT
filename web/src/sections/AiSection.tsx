import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Icon } from '../ui/meta';

interface ChatMsg { role: 'user' | 'assistant'; text: string; tools?: string[]; streaming?: boolean }

interface Props {
  aiAvailable: boolean;
  send: (msg: unknown) => void;
  registerHandler: (fn: (event: string, data: { sessionId: string; text?: string; name?: string; error?: string }) => void) => void;
}

const TOOL_LABELS: Record<string, string> = {
  get_topology: 'topología',
  get_metrics: 'métricas',
  ping_now: 'ping en vivo',
  get_device_detail: 'detalle del equipo',
  get_loss_matrix: 'matriz de pérdida',
  correlate_saturation: 'saturación',
  get_recent_alerts: 'alertas',
  run_cable_test: 'prueba de cable',
  get_link_health: 'salud de enlace',
};

const MODEL_LABELS: Record<string, string> = {
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
};

const SUGGESTIONS = [
  '¿Por qué los clientes pierden paquetes hacia 8.8.8.8 si la red local está bien?',
  '¿Dónde tengo saturación y pérdida hacia internet en horas pico?',
  'Revisa la salud física del cable del PTP Mimosa',
];

export function AiSection({ aiAvailable, send, registerHandler }: Props) {
  const [messages, setMessages] = useState<ChatMsg[]>([
    { role: 'assistant', text: 'Hola 👋 Soy tu asistente de diagnóstico. Puedo investigar la topología, métricas en vivo, hacer ping (incluso desde los MikroTik con IP de origen LAN), revisar la matriz de pérdida, correlacionar saturación y analizar la salud física de los enlaces. ¿Qué revisamos?' },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState('claude-opus-4-8');
  const sessionIdRef = useRef(`s-${Date.now()}`);
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { api.settings().then((s) => setModel(s.aiModels.diagnosis)).catch(() => {}); }, []);

  useEffect(() => {
    registerHandler((event, data) => {
      if (data.sessionId !== sessionIdRef.current) return;
      if (event === 'chat_delta' && data.text) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant' && last.streaming) {
            return [...prev.slice(0, -1), { ...last, text: last.text + data.text }];
          }
          return [...prev, { role: 'assistant', text: data.text!, streaming: true }];
        });
      } else if (event === 'chat_tool' && data.name) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          const label = TOOL_LABELS[data.name!] ?? data.name!;
          if (last?.role === 'assistant' && last.streaming) {
            return [...prev.slice(0, -1), { ...last, tools: [...(last.tools ?? []), label] }];
          }
          return [...prev, { role: 'assistant', text: '', tools: [label], streaming: true }];
        });
      } else if (event === 'chat_done') {
        setBusy(false);
        setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
      } else if (event === 'chat_error') {
        setBusy(false);
        setMessages((prev) => [...prev.map((m) => ({ ...m, streaming: false })), { role: 'assistant', text: `⚠️ Error: ${data.error}` }]);
      }
    });
  }, [registerHandler]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const submit = (preset?: string) => {
    const text = (preset ?? input).trim();
    if (!text || busy) return;
    setMessages((prev) => [...prev, { role: 'user', text }]);
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';
    setBusy(true);
    send({ type: 'chat', sessionId: sessionIdRef.current, text });
  };

  if (!aiAvailable) {
    return (
      <div className="section-scroll">
        <div style={{ maxWidth: 620, margin: '40px auto' }} className="card">
          <h3>Diagnóstico con IA deshabilitado</h3>
          <p className="card-sub">Agrega tu API key de Anthropic en <b>Ajustes → Inteligencia artificial</b>. Se guarda cifrada en este PC (también sirve <code>ANTHROPIC_API_KEY</code> en el <code>.env</code>). El monitoreo funciona igual sin ella; solo el chat y el diagnóstico automático de alertas quedan apagados.</p>
        </div>
      </div>
    );
  }

  const onlyGreeting = messages.length <= 1;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div className="chat-scroll">
        <div className="chat-col">
          {messages.map((m, i) => {
            const isAssistant = m.role === 'assistant';
            return (
              <div key={i} style={{ display: 'flex', gap: 11, justifyContent: isAssistant ? 'flex-start' : 'flex-end', alignItems: 'flex-start' }}>
                {isAssistant && (
                  <span className="chat-avatar">
                    <Icon path="M12 2l1.9 5.6L19.5 9l-4.3 3.4L16.5 18 12 14.7 7.5 18l1.3-5.6L4.5 9l5.6-1.4z" size={16} fill="#fff" stroke="none" />
                  </span>
                )}
                <div style={isAssistant
                  ? { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: '14px 14px 14px 4px', padding: '13px 16px', maxWidth: '88%' }
                  : { background: 'var(--accent)', color: '#fff', borderRadius: '14px 14px 4px 14px', padding: '11px 15px', maxWidth: '78%' }}>
                  {m.tools && m.tools.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: m.text ? 9 : 0 }}>
                      {m.tools.map((t, j) => (
                        <span key={j} className="tool-chip">
                          <Icon path="M4 12l5 5L20 6" size={11} stroke="var(--up)" strokeWidth={3} />{t}
                        </span>
                      ))}
                    </div>
                  )}
                  {(m.text || !m.tools) && (
                    <div style={{ fontSize: 13.5, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: isAssistant ? 'var(--text2)' : '#fff' }}>
                      {m.text}{m.streaming && <span className="caret" />}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {onlyGreeting && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9, marginTop: 4 }}>
              {SUGGESTIONS.map((q) => (
                <button key={q} className="suggestion" onClick={() => submit(q)}>{q}</button>
              ))}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bg2)', padding: '14px 22px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, background: 'var(--panel)', border: '1px solid var(--border2)', borderRadius: 13, padding: '8px 8px 8px 15px' }}>
            <textarea
              ref={taRef}
              value={input}
              placeholder="Pregunta a la IA sobre tu red…"
              rows={1}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px';
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', resize: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 14, lineHeight: 1.5, maxHeight: 120, padding: '6px 0' }}
            />
            <button
              onClick={() => submit()}
              disabled={!input.trim() || busy}
              style={{ width: 38, height: 38, borderRadius: 9, border: 'none', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: input.trim() && !busy ? 'pointer' : 'default', background: input.trim() && !busy ? 'var(--accent)' : 'var(--panel3)', color: input.trim() && !busy ? '#fff' : 'var(--muted)' }}
            >
              <Icon path="M22 2L11 13M22 2l-7 20-4-9-9-4z" size={17} strokeWidth={2} />
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 9, padding: '0 4px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: 'var(--muted)' }}>
              <Icon path="M12 8v4l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" size={13} strokeWidth={2} />
              Modelo chat: <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{MODEL_LABELS[model] ?? model}</span>
            </div>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>Investiga con herramientas reales · streaming</span>
          </div>
        </div>
      </div>
    </div>
  );
}
