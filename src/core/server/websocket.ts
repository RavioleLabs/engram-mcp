import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'http';
import { createLogger } from '../logger.js';
import type { MemoryStore } from '../../memory/core/store.js';

const log = createLogger('webapp:ws');

export function mountWebSocket(server: HttpServer, store: MemoryStore): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  const broadcast = (event: string, data: unknown) => {
    const payload = JSON.stringify({ event, data });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload);
        } catch (e) {
          log.warn(`ws send failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  };

  store.events.on('memory.added', (item) => broadcast('memory.added', { id: item.id, type: item.type }));
  store.events.on('memory.deleted', (data) => broadcast('memory.deleted', data));
  store.events.on('memory.updated', (data) => broadcast('memory.updated', data));

  wss.on('connection', () => log.debug('ws client connected'));
  log.info('WebSocket mounted on /ws');
}
