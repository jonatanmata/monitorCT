import { db } from '../db/index.js';
import { broadcast } from '../state.js';
import {
  getTelegramConfig, callTelegram, answerCallback, editTelegramMessage, muteNode, registerPollerChatSource,
} from './telegram.js';

/**
 * Poller de callbacks de Telegram. Es el ÚNICO consumidor de getUpdates (Telegram
 * solo permite uno por bot), así que también bufferea los chats vistos para que la
 * detección de chat id no compita por el offset. Maneja los botones inline:
 *   resolve:<alertId>  → marca la alerta resuelta
 *   mute:<nodeId>      → silencia ese equipo 1 hora
 * Solo corre si están activados los botones de acción en la config.
 */

let running = false;
let offset = 0;
const recentChats = new Map<string, string>(); // id -> nombre

interface Update {
  update_id: number;
  message?: { chat?: { id: number; title?: string; first_name?: string; username?: string } };
  callback_query?: {
    id: string; data?: string;
    message?: { chat?: { id: number }; message_id?: number; text?: string };
  };
}

function chatList(): { id: string; name: string }[] {
  return [...recentChats.entries()].map(([id, name]) => ({ id, name }));
}

async function handleUpdate(u: Update): Promise<void> {
  const chat = u.message?.chat;
  if (chat) {
    const id = String(chat.id);
    const name = chat.title || [chat.first_name, chat.username && `@${chat.username}`].filter(Boolean).join(' ') || id;
    recentChats.set(id, name);
    if (recentChats.size > 30) recentChats.delete(recentChats.keys().next().value as string);
  }

  const cb = u.callback_query;
  if (!cb?.data) return;
  const [action, arg] = cb.data.split(':');
  const n = parseInt(arg, 10);
  try {
    if (action === 'resolve' && n) {
      const res = db.prepare('UPDATE alerts SET resolved_at = unixepoch() WHERE id = ? AND resolved_at IS NULL').run(n);
      if (res.changes > 0) { broadcast('alert_resolved', { id: n }); await answerCallback(cb.id, '✔ Resuelta'); }
      else await answerCallback(cb.id, 'Ya estaba resuelta');
      const m = cb.message;
      if (m?.chat?.id && m.message_id) await editTelegramMessage(String(m.chat.id), m.message_id, `${m.text ?? ''}\n\n✔ Resuelta desde Telegram`);
    } else if (action === 'mute' && n) {
      muteNode(n, 60);
      await answerCallback(cb.id, '🔕 Silenciado 1 h');
      const m = cb.message;
      if (m?.chat?.id && m.message_id) await editTelegramMessage(String(m.chat.id), m.message_id, `${m.text ?? ''}\n\n🔕 Silenciado 1 h desde Telegram`);
    } else {
      await answerCallback(cb.id, '');
    }
  } catch (err) { console.error('Telegram callback:', err); }
}

async function loop(): Promise<void> {
  while (running) {
    const c = getTelegramConfig();
    if (!c.enabled || !c.botToken || !c.actionButtons) { await sleep(2000); continue; }
    try {
      const r = (await callTelegram(c.botToken, 'getUpdates', { offset, timeout: 45, allowed_updates: ['message', 'callback_query'] })) as { ok: boolean; result?: Update[] };
      if (r.ok && Array.isArray(r.result)) {
        for (const u of r.result) { offset = u.update_id + 1; await handleUpdate(u); }
      } else {
        await sleep(3000);
      }
    } catch { await sleep(4000); }
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/** Arranca el poller si la config lo pide; idempotente. */
export function startTelegramPoller(): void {
  registerPollerChatSource(() => chatList());
  if (running) return;
  const c = getTelegramConfig();
  if (!c.enabled || !c.botToken || !c.actionButtons) return;
  running = true;
  void loop();
}

export function stopTelegramPoller(): void { running = false; }

/** Reevalúa la config: arranca o detiene según corresponda. */
export function syncTelegramPoller(): void {
  const c = getTelegramConfig();
  if (c.enabled && c.botToken && c.actionButtons) startTelegramPoller();
  else stopTelegramPoller();
}
