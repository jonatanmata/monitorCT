import Anthropic from '@anthropic-ai/sdk';
import { db, getSetting, setSetting, type NodeRow, type EdgeRow } from '../db/index.js';
import { encryptJson, decryptJson } from '../db/crypto.js';
import { toolDefinitions, executeTool } from './tools.js';
import { sendTelegram, formatDiagnosisMessage, telegramNotifyDiagnosis } from '../alerts/telegram.js';

const MAX_ITERATIONS = 12;

/** Modelos válidos para elegir en Ajustes. */
export const AI_MODELS = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;
const DEFAULT_DIAGNOSIS = 'claude-opus-4-8';
const DEFAULT_ECONOMIC = 'claude-sonnet-5';

/** Modelo potente para el diagnóstico interactivo (chat). */
export function getDiagnosisModel(): string {
  const m = getSetting('ai_model_diagnosis', DEFAULT_DIAGNOSIS);
  return (AI_MODELS as readonly string[]).includes(m) ? m : DEFAULT_DIAGNOSIS;
}
/** Modelo económico para tareas automáticas frecuentes (diagnóstico de alertas). */
export function getEconomicModel(): string {
  const m = getSetting('ai_model_economic', DEFAULT_ECONOMIC);
  return (AI_MODELS as readonly string[]).includes(m) ? m : DEFAULT_ECONOMIC;
}
export function getAiModels(): { diagnosis: string; economic: string } {
  return { diagnosis: getDiagnosisModel(), economic: getEconomicModel() };
}
export function setAiModels(diagnosis?: string, economic?: string): void {
  if (diagnosis && (AI_MODELS as readonly string[]).includes(diagnosis)) setSetting('ai_model_diagnosis', diagnosis);
  if (economic && (AI_MODELS as readonly string[]).includes(economic)) setSetting('ai_model_economic', economic);
}

/**
 * La API key puede venir de dos lugares (en este orden):
 *  1. Variable de entorno ANTHROPIC_API_KEY (.env) — opcional
 *  2. Guardada desde la interfaz (pestaña Ajustes), cifrada en SQLite
 */
export function resolveApiKey(): string | null {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const stored = decryptJson<{ key?: string }>(getSetting('anthropic_api_key_enc', ''), {});
  return stored.key || null;
}

export function saveApiKey(key: string): void {
  setSetting('anthropic_api_key_enc', encryptJson({ key }));
  client = null; // el próximo uso crea el cliente con la clave nueva
}

export function clearApiKey(): void {
  setSetting('anthropic_api_key_enc', '');
  client = null;
}

/** Valida una clave con count_tokens (endpoint gratuito, no gasta tokens). */
export async function testApiKey(key?: string): Promise<{ ok: boolean; detail: string }> {
  const apiKey = key || resolveApiKey();
  if (!apiKey) return { ok: false, detail: 'No hay API key configurada' };
  try {
    const test = new Anthropic({ apiKey });
    await test.messages.countTokens({ model: getDiagnosisModel(), messages: [{ role: 'user', content: 'hola' }] });
    return { ok: true, detail: 'Clave válida — el diagnóstico con IA está activo' };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, detail: 'Clave inválida o revocada' };
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error('No hay API key de Anthropic configurada. Agrégala en la pestaña Ajustes (⚙) o en el archivo .env.');
  }
  if (!client) client = new Anthropic({ apiKey });
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

El nodo de tipo "monitor" (💻 PC de monitoreo) es la raíz del grafo: es el propio PC desde donde corre este sistema y desde donde salen las sondas del origen "pc" hacia internet. La red se construye conectándolo al primer equipo y de ahí hacia afuera.

## Síntoma conocido de esta red (contexto crítico)
- La red local funciona bien en pings entre equipos.
- Los clientes y el PC de monitoreo pierden paquetes hacia 8.8.8.8 y hacia el gateway público del proveedor, PERO los MikroTik nunca pierden hacia esos mismos destinos con su ping normal.
- Explicación técnica: el ping generado por el propio router NO atraviesa las simple queues, el FastTrack ni el mismo camino de reenvío que el tráfico de los clientes. Cuando un enlace se satura, el tráfico reenviado sufre descartes de cola mientras el ping del router sale limpio. Por eso:
  - Nunca concluyas "el enlace está bien" solo porque el ping del router no pierde.
  - Usa get_loss_matrix para comparar orígenes, y ping_now con srcAddress (IP LAN) desde los MikroTik para simular tráfico de cliente.
  - Usa correlate_saturation y las métricas utilization_pct / queue_drops / tx_drops para confirmar saturación en horas pico.

## Diagnóstico físico de cable (descartar antes de culpar RF o saturación)
Muchos problemas "raros" son de capa física (cable UTP, conector RJ45, PoE). Antes de concluir que es RF o saturación, DESCARTA el cable:
- Usa get_link_health para ver, por puerto: velocidad negociada, dúplex y errores CRC/FCS. Señales de cable dañado: un puerto Gigabit negociado a 100 Mbps (Gigabit necesita los 4 pares; si uno se rompe, cae a 100), dúplex en HALF, o errores CRC/FCS crecientes (cable/conector/EMI).
- Si sospechas del cable, usa run_cable_test (solo MikroTik): prueba TDR que dice par por par si está ok/abierto/en corto y a qué distancia en metros está la falla. Es la confirmación definitiva. (Interrumpe ese puerto ~1 s.)
- Un switch es PASIVO (no reporta nada): el cable hacia/desde un switch se diagnostica desde el puerto del equipo administrable vecino (el MikroTik al que llega).
- Regla práctica: pérdida o lentitud constante en UN solo cliente/segmento, sin patrón de horas pico y sin degradación de señal → sospecha cable/conector primero.

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

## Estilo de respuesta (IMPORTANTE — ahorra tokens)
- Razona todo lo que necesites en tu pensamiento interno (thinking), NO en la respuesta al usuario.
- Tu respuesta debe ser CONCRETA y BREVE: el punto de falla probable (nodo/enlace por su nombre), la evidencia clave (1-3 datos), y los pasos accionables. Nada más.
- Prohibido el relleno: no repitas la pregunta, no expliques lo que "vas a hacer", no listes todo lo que descartaste salvo que sea relevante, no añadas disclaimers ni resúmenes de cortesía.
- Si te falta un dato, consúltalo con una herramienta antes de responder; no divagues.
- Formato preferido: 2-5 frases o viñetas cortas. Si todo está bien, dilo en una frase.

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
  opts: { model?: string } = {},
): Promise<{ finalText: string; messages: Anthropic.MessageParam[] }> {
  const anthropic = getClient();
  const model = opts.model ?? getDiagnosisModel();
  const system = buildSystemPrompt();
  const history: Anthropic.MessageParam[] = [...messages];
  let finalText = '';

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const stream = anthropic.messages.stream({
      model,
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
    // Diagnóstico automático de alertas: usa el modelo ECONÓMICO (corre seguido)
    const { finalText } = await runAgent(
      [
        {
          role: 'user',
          content: `Se acaba de disparar esta alerta automática: [${alert.type}] ${alert.message}. Investiga con las herramientas y da un diagnóstico breve (máx ~120 palabras): causa más probable, evidencia y qué hacer. Ve al grano, sin relleno.`,
        },
      ],
      {},
      { model: getEconomicModel() },
    );
    db.prepare('UPDATE alerts SET ai_diagnosis = ? WHERE id = ?').run(finalText, alertId);
    if (finalText && telegramNotifyDiagnosis()) void sendTelegram(formatDiagnosisMessage(alert.message, finalText));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare('UPDATE alerts SET ai_diagnosis = ? WHERE id = ?').run(`(No fue posible el diagnóstico IA: ${msg})`, alertId);
  }
}

export function aiAvailable(): boolean {
  return Boolean(resolveApiKey());
}
