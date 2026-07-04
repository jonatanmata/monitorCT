import { getSetting, setSetting } from '../db/index.js';
import { encryptJson, decryptJson } from '../db/crypto.js';

/**
 * Notificaciones por Telegram. La configuración (bot token + chat id) se guarda
 * cifrada en la base local. El bot se crea con @BotFather y el chat id se
 * obtiene enviándole un mensaje al bot y consultando getUpdates (el botón
 * "Probar" de la interfaz guía ese flujo).
 */

export type Severity = 'info' | 'warning' | 'critical';

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
  // Preferencias de qué notificar
  minSeverity: Severity;     // severidad mínima que se envía
  notifyResolved: boolean;   // avisar cuando una alerta se resuelve
  notifyDiagnosis: boolean;  // enviar el diagnóstico de la IA
}

const DEFAULT: TelegramConfig = {
  enabled: false, botToken: '', chatId: '',
  minSeverity: 'warning', notifyResolved: true, notifyDiagnosis: true,
};

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export function getTelegramConfig(): TelegramConfig {
  return { ...DEFAULT, ...decryptJson<Partial<TelegramConfig>>(getSetting('telegram_config_enc', ''), {}) };
}

/** Devuelve la config sin exponer el token (para la interfaz). */
export function getTelegramConfigSafe(): {
  enabled: boolean; hasToken: boolean; chatId: string;
  minSeverity: Severity; notifyResolved: boolean; notifyDiagnosis: boolean;
} {
  const c = getTelegramConfig();
  return {
    enabled: c.enabled, hasToken: Boolean(c.botToken), chatId: c.chatId,
    minSeverity: c.minSeverity, notifyResolved: c.notifyResolved, notifyDiagnosis: c.notifyDiagnosis,
  };
}

export function saveTelegramConfig(patch: Partial<TelegramConfig>): void {
  const current = getTelegramConfig();
  const merged: TelegramConfig = {
    enabled: patch.enabled ?? current.enabled,
    // token vacío = conservar el guardado
    botToken: patch.botToken ? patch.botToken.trim() : current.botToken,
    chatId: patch.chatId !== undefined ? patch.chatId.trim() : current.chatId,
    minSeverity: patch.minSeverity ?? current.minSeverity,
    notifyResolved: patch.notifyResolved ?? current.notifyResolved,
    notifyDiagnosis: patch.notifyDiagnosis ?? current.notifyDiagnosis,
  };
  setSetting('telegram_config_enc', encryptJson(merged));
}

/** ¿Se debe notificar una alerta de esta severidad, según la preferencia? */
export function telegramAllowsSeverity(severity: Severity): boolean {
  const c = getTelegramConfig();
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[c.minSeverity];
}

export function telegramNotifyResolved(): boolean {
  return getTelegramConfig().notifyResolved;
}

export function telegramNotifyDiagnosis(): boolean {
  return getTelegramConfig().notifyDiagnosis;
}

export function clearTelegramConfig(): void {
  setSetting('telegram_config_enc', '');
}

async function callTelegram(token: string, method: string, body: unknown): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; result?: unknown; description?: string };
}

/** Envía un mensaje (Markdown). No lanza: registra el error y sigue. */
export async function sendTelegram(text: string): Promise<void> {
  const c = getTelegramConfig();
  if (!c.enabled || !c.botToken || !c.chatId) return;
  try {
    const r = await callTelegram(c.botToken, 'sendMessage', {
      chat_id: c.chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
    if (!r.ok) console.error('Telegram:', r.description);
  } catch (err) {
    console.error('Telegram:', err);
  }
}

/**
 * Detecta el/los chat id automáticamente: lee los mensajes recientes que el bot
 * ha recibido (getUpdates). El usuario primero le escribe cualquier cosa al bot.
 */
export async function detectChatIds(token?: string): Promise<{ ok: boolean; chats: { id: string; name: string }[]; detail: string }> {
  const c = getTelegramConfig();
  const botToken = token || c.botToken;
  if (!botToken) return { ok: false, chats: [], detail: 'Falta el token del bot' };
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

/** Prueba la configuración enviando un mensaje real. */
export async function testTelegram(cfg?: { botToken?: string; chatId?: string }): Promise<{ ok: boolean; detail: string }> {
  const c = getTelegramConfig();
  const token = cfg?.botToken?.trim() || c.botToken;
  const chatId = cfg?.chatId?.trim() || c.chatId;
  if (!token) return { ok: false, detail: 'Falta el token del bot' };
  if (!chatId) return { ok: false, detail: 'Falta el chat id' };
  try {
    const r = await callTelegram(token, 'sendMessage', {
      chat_id: chatId,
      text: '✅ *MonitorCt* conectado. Recibirás aquí las alertas de tu red.',
      parse_mode: 'Markdown',
    });
    return r.ok
      ? { ok: true, detail: 'Mensaje de prueba enviado — revisa tu Telegram' }
      : { ok: false, detail: r.description || 'Telegram rechazó el envío' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

const SEVERITY_ICON: Record<string, string> = { critical: '🔴', warning: '🟡', info: 'ℹ️' };

export function formatAlertMessage(a: { severity: string; type: string; message: string; nodeName?: string | null }): string {
  const icon = SEVERITY_ICON[a.severity] ?? '⚠️';
  return `${icon} *Alerta MonitorCt*\n${a.message}`;
}

export function formatDiagnosisMessage(alertMessage: string, diagnosis: string): string {
  return `🤖 *Diagnóstico IA*\n_${alertMessage}_\n\n${diagnosis}`;
}

export function formatResolvedMessage(alertMessage: string): string {
  return `✅ *Resuelta*\n${alertMessage}`;
}
