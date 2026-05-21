// src/client/src/ws.ts
type Listener = (event: string, data: unknown) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function connectWebSocket(): () => void {
  const open = () => {
    const url = `ws://${window.location.host}/ws`;
    socket = new WebSocket(url);
    socket.onmessage = (ev) => {
      try {
        const { event, data } = JSON.parse(ev.data as string) as { event: string; data: unknown };
        for (const l of listeners) l(event, data);
      } catch {
        // ignore malformed messages
      }
    };
    socket.onclose = () => {
      socket = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  };
}

export function onMemoryEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
