import { useEffect, useRef } from 'react';

export type WsHandler = (event: string, data: unknown) => void;

/** Conexión WebSocket con reconexión automática. */
export function useWebSocket(onEvent: WsHandler): { send: (msg: unknown) => void } {
  const wsRef = useRef<WebSocket | null>(null);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    function connect(): void {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onmessage = (e) => {
        try {
          const { event, data } = JSON.parse(e.data);
          handlerRef.current(event, data);
        } catch {
          /* mensaje no JSON */
        }
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 2000);
      };
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  return {
    send: (msg: unknown) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
      }
    },
  };
}
