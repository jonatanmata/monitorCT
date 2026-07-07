import { getSetting, setSetting } from '../db/index.js';
import { encryptJson, decryptJson } from '../db/crypto.js';

/**
 * Notificaciones por Telegram. La configuración (bot token + chat id) se guarda
 * cifrada en la base local. El bot se crea con @BotFather y el chat id se
 * obtiene enviándole un mensaje al bot y consultando getUpdates.
 */

export type Severity = 'info' | 'warning' | 'critical';

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
  // Preferencias de qué notificar
  minSeverity: Severity;      // severidad mínima que se envía
  notifyResolved: boolean;    // avisar cuando una alerta se resuelve
  notifyDiagnosis: boolean;   // enviar el diagnóstico de la IA
  // Mejoras v0.5
  criticalChatId: string;     // enrutar críticas a otro chat/grupo (vacío = usar chatId)
  quietStart: number | null;  // inicio horario silencioso (hora 0-23; null = sin horario)
  quietEnd: number | null;    // fin horario silencioso (hora 0-23)
  actionButtons: boolean;     // botones inline (Resolver / Silenciar) + poller de callbacks
  groupWindowSec: number;     // ventana de agrupación anti-spam (segundos)
}

const DEFAULT: TelegramConfig = {
  enabled: false, botToken: '', chatId: '',
  minSeverity: 'warning', notifyResolved: true, notifyDiagnosis: true,
  criticalChatId: '', quietStart: null, quietEnd: null, actionButtons: false, groupWindowSec: 25,
};

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export function getTelegramConfig(): TelegramConfig {
  return { ...DEFAULT, ...decryptJson<Partial<TelegramConfig>>(getSetting('telegram_config_enc', ''), {}) };
}

/** Config sin exponer el token (para la interfaz). */
export function getTelegramConfigSafe() {
  const c = getTelegramConfig();
  return {
    enabled: c.enabled, hasToken: Boolean(c.botToken), chatId: c.chatId,
    minSeverity: c.minSeverity, notifyResolved: c.notifyResolved, notifyDiagnosis: c.notifyDiagnosis,
    criticalChatId: c.criticalChatId, quietStart: c.quietStart, quietEnd: c.quietEnd,
    actionButtons: c.actionButtons, groupWindowSec: c.groupWindowSec,
  };
}

export function saveTelegramConfig(patch: Partial<TelegramConfig>): void {
  const current = getTelegramConfig();
  const merged: TelegramConfig = {
    enabled: patch.enabled ?? current.enabled,
    botToken: patch.botToken ? patch.botToken.trim() : current.botToken,
    chatId: patch.chatId !== undefined ? patch.chatId.trim() : current.chatId,
    minSeverity: patch.minSeverity ?? current.minSeverity,
    notifyResolved: patch.notifyResolved ?? current.notifyResolved,
    notifyDiagnosis: patch.notifyDiagnosis ?? current.notifyDiagnosis,
    criticalChatId: patch.criticalChatId !== undefined ? patch.criticalChatId.trim() : current.criticalChatId,
    quietStart: patch.quietStart !== undefined ? patch.quietStart : current.quietStart,
    quietEnd: patch.quietEnd !== undefined ? patch.quietEnd : current.quietEnd,
    actionButtons: patch.actionButtons ?? current.actionButtons,
    groupWindowSec: patch.groupWindowSec ?? current.groupWindowSec,
  };
  setSetting('telegram_config_enc', encryptJson(merged));
}

export function clearTelegramConfig(): void {
  setSetting('telegram_config_enc', '');
}

export function telegramAllowsSeverity(severity: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[getTelegramConfig().minSeverity];
}
export function telegramNotifyResolved(): boolean { return getTelegramConfig().notifyResolved; }
export function telegramNotifyDiagnosis(): boolean { return getTelegramConfig().notifyDiagnosis; }
export function rankOf(severity: Severity): number { return SEVERITY_RANK[severity]; }

/** ¿Estamos dentro del horario silencioso ahora mismo? (las críticas lo ignoran). */
export function isQuietNow(now = new Date()): boolean {
  const c = getTelegramConfig();
  if (c.quietStart === null || c.quietEnd === null || c.quietStart === c.quietEnd) return false;
  const h = now.getHours();
  return c.quietStart < c.quietEnd
    ? h >= c.quietStart && h < c.quietEnd            // ej. 1–7
    : h >= c.quietStart || h < c.quietEnd;           // envuelve medianoche, ej. 22–7
}

/** Chat destino según severidad (críticas a criticalChatId si está configurado). */
export function routeChat(severity: Severity): string {
  const c = getTelegramConfig();
  return severity === 'critical' && c.criticalChatId ? c.criticalChatId : c.chatId;
}

// ---- Vigilancia por equipo (siempre notifica) y silenciados ----
function readMap(key: string): Record<string, number> {
  try { return JSON.parse(getSetting(key, '{}')) as Record<string, number>; } catch { return {}; }
}
export function getWatchedNodes(): number[] {
  return Object.entries(readMap('telegram_watch')).filter(([, v]) => v).map(([k]) => parseInt(k, 10));
}
export function isWatched(nodeId: number | null): boolean {
  if (nodeId === null) return false;
  return Boolean(readMap('telegram_watch')[String(nodeId)]);
}
export function setWatched(nodeId: number, on: boolean): void {
  const m = readMap('telegram_watch');
  if (on) m[String(nodeId)] = 1; else delete m[String(nodeId)];
  setSetting('telegram_watch', JSON.stringify(m));
}
export function muteNode(nodeId: number, minutes: number): void {
  const m = readMap('telegram_mutes');
  m[String(nodeId)] = Math.floor(Date.now() / 1000) + minutes * 60;
  setSetting('telegram_mutes', JSON.stringify(m));
}
export function isMuted(nodeId: number | null): boolean {
  if (nodeId === null) return false;
  const until = readMap('telegram_mutes')[String(nodeId)];
  return Boolean(until && until > Math.floor(Date.now() / 1000));
}

// ---- API de bajo nivel ----
async function callTelegram(token: string, method: string, body: unknown): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; result?: unknown; description?: string };
}

export interface InlineButton { text: string; callback_data: string }

/** Envía un mensaje (Markdown). Devuelve el message_id o null. No lanza. */
export async function sendTelegram(text: string, opts?: { chatId?: string; buttons?: InlineButton[][] }): Promise<number | null> {
  const c = getTelegramConfig();
  const chatId = opts?.chatId || c.chatId;
  if (!c.enabled || !c.botToken || !chatId) return null;
  try {
    const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true };
    if (opts?.buttons?.length) body.reply_markup = { inline_keyboard: opts.buttons };
    const r = await callTelegram(c.botToken, 'sendMessage', body);
    if (!r.ok) { console.error('Telegram:', r.description); return null; }
    return (r.result as { message_id?: number })?.message_id ?? null;
  } catch (err) { console.error('Telegram:', err); return null; }
}

export async function editTelegramMessage(chatId: string, messageId: number, text: string): Promise<void> {
  const c = getTelegramConfig();
  if (!c.botToken) return;
  try {
    await callTelegram(c.botToken, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (err) { console.error('Telegram edit:', err); }
}

export async function answerCallback(callbackId: string, text: string): Promise<void> {
  const c = getTelegramConfig();
  if (!c.botToken) return;
  try { await callTelegram(c.botToken, 'answerCallbackQuery', { callback_query_id: callbackId, text }); }
  catch (err) { console.error('Telegram answer:', err); }
}

export { callTelegram };

// ---- Detección de chat id (usa el buffer del poller si está activo) ----
export async function detectChatIds(token?: string): Promise<{ ok: boolean; chats: { id: string; name: string }[]; detail: string }> {
  const c = getTelegramConfig();
  const botToken = token || c.botToken;
  if (!botToken) return { ok: false, chats: [], detail: 'Falta el token del bot' };
  // Si el poller de callbacks está corriendo, es el dueño de getUpdates; leemos su buffer.
  const buffered = getPollerChats?.();
  if (buffered && buffered.length) return { ok: true, chats: buffered, detail: `Se detectaron ${buffered.length} chat(s)` };
  try {
    const r = (await callTelegram(botToken, 'getUpdates', {})) as {
      ok: boolean; result?: { message?: { chat?: { id: number; title?: string; first_name?: string; username?: string } } }[]; description?: string;
    };
    if (!r.ok) return { ok: false, chats: [], detail: r.description || 'Telegram rechazó getUpdates (¿token inválido?)' };
    const seen = new Map<string, string>();
    for (const u of r.result ?? []) {
      const chat = u.message?.chat;
      if (!chat) continue;
      const id = String(chat.id);
      const name = chat.title || [chat.first_name, chat.username && `@${chat.username}`].filter(Boolean).join(' ') || id;
      if (!seen.has(id)) seen.set(id, name);
    }
    const chats = [...seen.entries()].map(([id, name]) => ({ id, name }));
    return chats.length
      ? { ok: true, chats, detail: `Se detectaron ${chats.length} chat(s)` }
      : { ok: false, chats: [], detail: 'No hay mensajes recientes. Envíale primero un mensaje a tu bot en Telegram y vuelve a intentar.' };
  } catch (err) {
    return { ok: false, chats: [], detail: err instanceof Error ? err.message : String(err) };
  }
}

// Enganche opcional con el poller para no competir por getUpdates.
let getPollerChats: (() => { id: string; name: string }[]) | null = null;
export function registerPollerChatSource(fn: (() => { id: string; name: string }[]) | null): void { getPollerChats = fn; }

export async function testTelegram(cfg?: { botToken?: string; chatId?: string }): Promise<{ ok: boolean; detail: string }> {
  const c = getTelegramConfig();
  const token = cfg?.botToken?.trim() || c.botToken;
  const chatId = cfg?.chatId?.trim() || c.chatId;
  if (!token) return { ok: false, detail: 'Falta el token del bot' };
  if (!chatId) return { ok: false, detail: 'Falta el chat id' };
  try {
    const r = await callTelegram(token, 'sendMessage', { chat_id: chatId, text: '✅ *MonitorCt* conectado. Recibirás aquí las alertas de tu red.', parse_mode: 'Markdown' });
    return r.ok ? { ok: true, detail: 'Mensaje de prueba enviado — revisa tu Telegram' } : { ok: false, detail: r.description || 'Telegram rechazó el envío' };
  } catch (err) { return { ok: false, detail: err instanceof Error ? err.message : String(err) }; }
}

// ---- Formato de mensajes ----
const SEVERITY_ICON: Record<string, string> = { critical: '🔴', warning: '🟡', info: 'ℹ️' };
const md = (s: string) => s.replace(/([_*[\]()~`>#+=|{}.!-])/g, '\\$1'); // escape básico MarkdownV1-safe subset
export function severityIcon(sev: string): string { return SEVERITY_ICON[sev] ?? '⚠️'; }

export function formatAlertMessage(a: { severity: string; type: string; message: string; nodeName?: string | null }): string {
  return `${severityIcon(a.severity)} *Alerta MonitorCt*\n${a.message}`;
}
export function formatDiagnosisMessage(alertMessage: string, diagnosis: string): string {
  return `🤖 *Diagnóstico IA*\n_${alertMessage}_\n\n${diagnosis}`;
}
export function formatResolvedMessage(alertMessage: string, minutesOpen?: number | null): string {
  const dur = minutesOpen != null && minutesOpen >= 1 ? ` · tras ${minutesOpen} min` : '';
  return `✅ *Resuelta*${dur}\n${alertMessage}`;
}
export { md };
