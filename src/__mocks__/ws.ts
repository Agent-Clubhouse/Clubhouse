// Stub for ws module so annex-server can be imported in tests without
// CJS/ESM interop issues. Only the surface used by annex-server is mocked.

import { EventEmitter } from 'events';

export class WebSocketServer extends EventEmitter {
  clients: Set<WebSocket>;

  constructor(_opts?: Record<string, unknown>) {
    super();
    this.clients = new Set();
  }

  handleUpgrade(
    _req: unknown,
    _socket: unknown,
    _head: unknown,
    cb: (ws: WebSocket) => void,
  ): void {
    const ws = new WebSocket();
    this.clients.add(ws);
    cb(ws);
  }

  close(): void {
    for (const client of this.clients) {
      try { client.close(); } catch { /* ignore */ }
    }
    this.clients.clear();
  }
}

export class WebSocket extends EventEmitter {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState: number = WebSocket.OPEN;

  send(_data: unknown): void { /* no-op */ }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

export default WebSocket;
