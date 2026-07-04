import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type Anthropic from '@anthropic-ai/sdk';
import { db } from '../db/index.js';
import { setBroadcast, allLiveNodes } from '../state.js';
import { runAgent } from '../ai/agent.js';

const clients = new Set<WebSocket>();

function send(socket: WebSocket, event: string, data: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify({ event, data }));
  }
}

function loadChatHistory(sessionId: string): Anthropic.MessageParam[] {
  const rows = db
    .prepare('SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY ts, id')
    .all(sessionId) as { role: 'user' | 'assistant'; content: string }[];
  return rows.map((r) => ({ role: r.role, content: JSON.parse(r.content) }));
}

function saveChatMessage(sessionId: string, role: string, content: unknown): void {
  db.prepare('INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)').run(
    sessionId, role, JSON.stringify(content),
  );
}

export function registerWsRoutes(app: FastifyInstance): void {
  setBroadcast((event, data) => {
    for (const socket of clients) send(socket, event, data);
  });

  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    clients.add(socket);
    send(socket, 'status', allLiveNodes());

    socket.on('close', () => clients.delete(socket));

    socket.on('message', async (raw: Buffer) => {
      let msg: { type?: string; sessionId?: string; text?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'chat' && msg.sessionId && msg.text) {
        const sessionId = msg.sessionId;
        try {
          // Historial previo + turno nuevo. runAgent maneja el bucle de herramientas.
          const history = loadChatHistory(sessionId);
          const userTurn = { role: 'user' as const, content: msg.text };
          saveChatMessage(sessionId, 'user', msg.text);

          const { messages } = await runAgent([...history, userTurn], {
            onTextDelta: (text) => send(socket, 'chat_delta', { sessionId, text }),
            onThinkingDelta: (text) => send(socket, 'chat_thinking', { sessionId, text }),
            onToolUse: (name, input) => send(socket, 'chat_tool', { sessionId, name, input }),
          });

          // Persistir los turnos nuevos posteriores al turno del usuario
          const newTurns = messages.slice(history.length + 1);
          for (const turn of newTurns) saveChatMessage(sessionId, turn.role, turn.content);

          send(socket, 'chat_done', { sessionId });
        } catch (err) {
          send(socket, 'chat_error', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
  });
}
