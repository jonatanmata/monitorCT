import { getSetting, setSetting } from '../db/index.js';
import { encryptJson, decryptJson } from '../db/crypto.js';

/**
 * Notificaciones por Telegram. La configuración (bot token + chat id) se guarda
 * cifrada en la base local. El bot se crea con @BotFather y el chat id se
 * obtiene enviándole un mensaje al bot y consultando getUpdates (el botón
 * "Probar" de la interfaz guía ese flujo).
 */

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
}

const DEFAULT: TelegramConfig = { enabled: false, botToken: '', chatId: '' };

export function getTelegramConfig(): TelegramConfig {
  return decryptJson<TelegramConfig>(getSetting('telegram_config_enc', ''), DEFAULT);
}

/** Devuelve la config sin exponer el token (para la interfaz). */
export function getTelegramConfigSafe(): { enabled: boolean; hasToken: boolean; chatId: string } {
  const c = getTelegramConfig();
  return { enabled: c.enabled, hasToken: Boolean(c.botToken), chatId: c.chatId };
}

export function saveTelegramConfig(patch: Partial<TelegramConfig>): void {
  const current = getTelegramConfig();
  const merged: TelegramConfig = {
    enabled: patch.enabled ?? current.enabled,
    // token vacío = conservar el guardado
    botToken: patch.botToken ? patch.botToken.trim() : current.botToken,
    chatId: patch.chatId !== undefined ? patch.chatId.trim() : current.chatId,
  };
  setSetting('telegram_config_enc', encryptJson(merged));
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
