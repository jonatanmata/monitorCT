import Anthropic from '@anthropic-ai/sdk';
import { db, type NodeRow, type EdgeRow } from '../db/index.js';
import { toolDefinitions, executeTool } from './tools.js';

const MODEL = 'claude-opus-4-8';
const MAX_ITERATIONS = 12;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Falta ANTHROPIC_API_KEY en el archivo .env — el diagnóstico con IA requiere una API key de Anthropic.');
  }
  if (!client) client = new Anthropic();
  return client;
}

/** System prompt generado desde la topología actual + conocimiento del síntoma. */
export function buildSystemPrompt(): string {
  const nodes = db.prepare('SELECT id, type, name, ip FROM nodes').all() as Pick<NodeRow, 'id' | 'type' | 'name' | 'ip'>[];
  const edges = db.prepare('SELECT id, source_id, target_id, label, capacity_mbps FROM edges').all() as EdgeRow[];
  const nodeName = new Map(nodes.map((n) => [n.id, n.name]));
  const topo = nodes.map((n) => `- [${n.id}] ${n.name} (${n.type}${n.ip ? `, ${n.ip}` : ''})`).join('\n');
  const links = edges
    .map((e) => `- [arista ${e.id}] ${nodeName.get(e.source_id)} → ${nodeName.get(e.target_id)}${e.capacity_mbps ? ` (capacidad ${e.capacity_mbps} Mbps)` : ''}`)
    .join('\n');

  return `Eres el ingeniero de diagnóstico de una red WISP (proveedor inalámbrico rural) en Colombia. Tu trabajo es encontrar el punto exacto de la red que causa problemas, usando las herramientas disponibles, y explicar la causa y los pasos a seguir en español claro para el operador de la red.

## Topología actual (grafo de dependencias — la señal fluye del origen al destino)
Nodos:
${topo || '(sin nodos configurados aún)'}

Enlaces:
${links || '(sin enlaces configurados aún)'}

Si un nodo falla, todo lo que cuelga aguas abajo de él falla también. Razona siempre sobre este grafo: busca el nodo/enlace más cercano al origen cuyos descendientes comparten el síntoma.

## Síntoma conocido de esta red (contexto crítico)
- La red local funciona bien en pings entre equipos.
- Los clientes y el PC de monitoreo pierden paquetes hacia 8.8.8.8 y hacia el gateway público del proveedor, PERO los MikroTik nunca pierden hacia esos mismos destinos con su ping normal.
- Explicación técnica: el ping generado por el propio router NO atraviesa las simple queues, el FastTrack ni el mismo camino de reenvío que el tráfico de los clientes. Cuando un enlace se satura, el tráfico reenviado sufre descartes de cola mientras el ping del router sale limpio. Por eso:
  - Nunca concluyas "el enlace está bien" solo porque el ping del router no pierde.
  - Usa get_loss_matrix para comparar orígenes, y ping_now con srcAddress (IP LAN) desde los MikroTik para simular tráfico de cliente.
  - Usa correlate_saturation y las métricas utilization_pct / queue_drops / tx_drops para confirmar saturación en horas pico.

## Umbrales sanos típicos de WISP
- Señal de cliente/AP airMAX: mejor que -65 dBm es buena; -65 a -75 regular; peor que -75 dBm problemática.
- CCQ: >90% bueno; <70% indica problemas de RF o interferencia.
- SNR de PTP Mimosa: >25 dB bueno; <20 dB degradado.
- airMAX capacity/quality: <60% indica interferencia o mala modulación.
- CPU MikroTik: sostenida >80% causa pérdida en el forwarding.
- Utilización de enlace >85% sostenida = zona de saturación con descartes de cola.
- Pérdida de paquetes: >2% ya afecta VoIP/streaming; >10% es grave.

## Método de trabajo
1. Empieza con get_topology y get_recent_alerts para el panorama.
2. Formula hipótesis y verifícalas con datos (métricas históricas, matriz de pérdida, correlación horaria, consultas en vivo). No especules sin consultar herramientas.
3. Distingue causas: saturación (utilización alta + drops + patrón horario), RF/interferencia (señal/CCQ/SNR degradados, capacidad PHY baja), hardware/cable (errores rx, pérdida constante sin patrón horario, un solo segmento), CPU (cpu_pct alto correlacionado con tráfico).
4. Responde con: el punto de falla más probable (nodo o enlace concreto), la evidencia que lo respalda, causas alternativas descartadas y pasos accionables (qué revisar/cambiar en campo o en configuración).

Responde siempre en español. Sé concreto: nombra los nodos y enlaces por su nombre.`;
}

export interface AgentEvents {
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onToolUse?: (name: string, input: unknown) => void;
  onToolResult?: (name: string, resultPreview: string) => void;
}

/**
 * Bucle manual de tool use con streaming. Devuelve el texto final y el
 * historial completo (para persistir la conversación).
 */
export async function runAgent(
  messages: Anthropic.MessageParam[],
  events: AgentEvents = {},
): Promise<{ finalText: string; messages: Anthropic.MessageParam[] }> {
  const anthropic = getClient();
  const system = buildSystemPrompt();
  const history: Anthropic.MessageParam[] = [...messages];
  let finalText = '';

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive', display: 'summarized' },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: toolDefinitions,
      messages: history,
    });

    stream.on('streamEvent', (event) => {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') events.onTextDelta?.(event.delta.text);
        else if (event.delta.type === 'thinking_delta') events.onThinkingDelta?.(event.delta.thinking);
      }
    });

    const response = await stream.finalMessage();
    history.push({ role: 'assistant', content: response.content });

    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    if (textBlocks.length) finalText = textBlocks.map((b) => b.text).join('\n');

    if (response.stop_reason !== 'tool_use') break;

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      events.onToolUse?.(tu.name, tu.input);
      const result = await executeTool(tu.name, tu.input);
      events.onToolResult?.(tu.name, result.slice(0, 200));
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
    }
    history.push({ role: 'user', content: results });
  }

  return { finalText, messages: history };
}

/** Diagnóstico automático de una alerta recién creada (sin streaming al usuario). */
export async function diagnoseAlert(alertId: number): Promise<void> {
  const alert = db
    .prepare(`SELECT a.*, n.name AS node_name FROM alerts a LEFT JOIN nodes n ON n.id = a.node_id WHERE a.id = ?`)
    .get(alertId) as { id: number; type: string; message: string; node_name: string | null } | undefined;
  if (!alert) return;

  try {
    const { finalText } = await runAgent([
      {
        role: 'user',
        content: `Se acaba de disparar esta alerta automática: [${alert.type}] ${alert.message}. Investiga con las herramientas y da un diagnóstico breve (máx ~200 palabras): causa más probable, evidencia y qué hacer.`,
      },
    ]);
    db.prepare('UPDATE alerts SET ai_diagnosis = ? WHERE id = ?').run(finalText, alertId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare('UPDATE alerts SET ai_diagnosis = ? WHERE id = ?').run(`(No fue posible el diagnóstico IA: ${msg})`, alertId);
  }
}

export function aiAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
