// Single WS upgrade dispatcher (§13.3 / Codex review): ONE `server.on('upgrade')` listener that routes by
// pathname, so multiple WS surfaces (/ws/term, later /ws/chat) share it instead of racing on separate
// listeners. Each route does its own pre-upgrade auth, then calls `upgrade()` to finish the handshake —
// preserving raw pre-upgrade 401s and post-upgrade WS close codes.
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

export type UpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
  upgrade: (onOpen: (ws: WebSocket) => void) => void,
) => void;

export interface WsDispatcher {
  register(path: string, handler: UpgradeHandler): void;
}

/** Attach the single upgrade listener to `server` and return a router for WS paths. */
export function createWsDispatcher(server: Server): WsDispatcher {
  const routes = new Map<string, UpgradeHandler>();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const handler = routes.get(url.pathname);
    if (!handler) {
      socket.destroy(); // unknown upgrade path — no route claims it
      return;
    }
    handler(req, socket, head, url, (onOpen) => wss.handleUpgrade(req, socket, head, onOpen));
  });
  return {
    register(path, handler) {
      routes.set(path, handler);
    },
  };
}
