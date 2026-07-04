import { useEffect, useRef, useState } from 'react';
import { InfoTip } from '../components/InfoTip';

interface ChatMsg {
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

interface Props {
  aiAvailable: boolean;
  send: (msg: unknown) => void;
  /** Registro del manejador de eventos de chat que llegan por WebSocket. */
  registerHandler: (fn: (event: string, data: { sessionId: string; text?: string; name?: string; error?: string }) => void) => void;
}

const TOOL_LABELS: Record<string, string> = {
  get_topology: 'consultando la topología',
  get_metrics: 'leyendo métricas históricas',
  ping_now: 'haciendo ping en vivo',
  get_device_detail: 'consultando el equipo en vivo',
  get_loss_matrix: 'analizando la matriz de pérdida',
  correlate_saturation: 'correlacionando pérdida y saturación',
  get_recent_alerts: 'revisando alertas recientes',
};

export function ChatPanel({ aiAvailable, send, registerHandler }: Props) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const sessionIdRef = useRef(`s-${Date.now()}`);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    registerHandler((event, data) => {
      if (data.sessionId !== sessionIdRef.current) return;
      if (event === 'chat_delta' && data.text) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant') {
            return [...prev.slice(0, -1), { role: 'assistant', text: last.text + data.text }];
          }
          return [...prev, { role: 'assistant', text: data.text! }];
        });
      } else if (event === 'chat_tool' && data.name) {
        setMessages((prev) => [...prev, { role: 'tool', text: `🔧 ${TOOL_LABELS[data.name!] ?? data.name}…` }]);
      } else if (event === 'chat_done') {
        setBusy(false);
      } else if (event === 'chat_error') {
        setBusy(false);
        setMessages((prev) => [...prev, { role: 'tool', text: `⚠️ Error: ${data.error}` }]);
      }
    });
  }, [registerHandler]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setMessages((prev) => [...prev, { role: 'user', text }]);
    setInput('');
    setBusy(true);
    send({ type: 'chat', sessionId: sessionIdRef.current, text });
  };

  const header = (
    <h3 style={{ marginBottom: 8 }}>
      Diagnóstico con IA
      <InfoTip text="Chat con un agente de IA (Claude) que actúa como ingeniero de diagnóstico de TU red: conoce la topología que dibujaste y el síntoma de pérdida hacia internet, y puede consultar métricas históricas, hacer pings en vivo (incluso desde los MikroTik con IP de origen LAN), leer la matriz de pérdida y correlacionar saturación por horas. Investiga con datos reales antes de responder — verás los pasos 🔧 mientras trabaja. Requiere la API key configurada en ⚙ Ajustes." />
    </h3>
  );

  if (!aiAvailable) {
    return (
      <div>
        {header}
        <div className="empty-hint">
          El diagnóstico con IA está deshabilitado.
          <br /><br />
          Agrega tu API key de Anthropic en la pestaña <b>⚙ Ajustes</b> — se guarda cifrada en este PC,
          sin tocar archivos. (También sirve <code>ANTHROPIC_API_KEY</code> en el <code>.env</code>.)
        </div>
      </div>
    );
  }

  return (
    <div className="chat">
      {header}
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="empty-hint">
            Pregúntale a la IA sobre tu red. Ejemplos:
            <br /><br />
            «¿Por qué los clientes pierden paquetes hacia 8.8.8.8 si la red local está bien?»
            <br /><br />
            «¿El PTP hacia Paramitos se satura en horas pico?»
            <br /><br />
            «Revisa la salud general de la red»
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>{m.text}</div>
        ))}
        {busy && messages[messages.length - 1]?.role !== 'assistant' && (
          <div className="chat-msg tool">🤖 analizando…</div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="chat-input">
        <textarea
          value={input}
          placeholder="Describe el problema o haz una pregunta…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="primary" onClick={submit} disabled={busy}>
          {busy ? '…' : 'Enviar'}
        </button>
      </div>
    </div>
  );
}
