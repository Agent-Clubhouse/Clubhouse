/**
 * Standalone Annex V2 protocol client for integration tests.
 *
 * A lightweight Node.js HTTP/WS client that can pair with an Annex server,
 * connect via WebSocket, and send/receive protocol messages. Used in vitest
 * integration tests under test/annex-v2/ where Playwright overhead is not needed.
 */
import WebSocket from 'ws';
import * as http from 'http';

export interface AnnexProtocolClientOptions {
  host: string;
  port: number;
}

export interface PairResponse {
  token?: string;
  error?: string;
  publicKey?: string;
  alias?: string;
  icon?: string;
  color?: string;
  fingerprint?: string;
}

export class AnnexProtocolClient {
  private host: string;
  private port: number;
  private token: string | null = null;
  private ws: WebSocket | null = null;
  private messageQueue: Array<Record<string, unknown>> = [];
  private messageListeners: Array<(msg: Record<string, unknown>) => void> = [];

  constructor(options: AnnexProtocolClientOptions) {
    this.host = options.host;
    this.port = options.port;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get authToken(): string | null {
    return this.token;
  }

  // ---------------------------------------------------------------------------
  // HTTP methods
  // ---------------------------------------------------------------------------

  private httpRequest(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const jsonBody = body ? JSON.stringify(body) : undefined;
      const req = http.request({
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(jsonBody ? { 'Content-Length': Buffer.byteLength(jsonBody) } : {}),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode || 0, body: data });
          }
        });
      });

      req.on('error', reject);
      if (jsonBody) req.write(jsonBody);
      req.end();
    });
  }

  /**
   * Pair with the Annex server using a PIN.
   */
  async pair(pin: string, publicKey?: string): Promise<PairResponse> {
    const body: Record<string, unknown> = { pin };
    if (publicKey) body.publicKey = publicKey;

    const res = await this.httpRequest('POST', '/pair', body);
    const data = res.body as PairResponse;

    if (res.status === 200 && data.token) {
      this.token = data.token;
    }

    return data;
  }

  /**
   * Fetch a JSON endpoint with bearer auth.
   */
  async get(path: string): Promise<{ status: number; body: unknown }> {
    return this.httpRequest('GET', path);
  }

  /**
   * POST to a JSON endpoint with bearer auth.
   */
  async post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    return this.httpRequest('POST', path, body);
  }

  // ---------------------------------------------------------------------------
  // WebSocket methods
  // ---------------------------------------------------------------------------

  /**
   * Connect to the WebSocket endpoint. Must pair first.
   */
  connect(): Promise<void> {
    if (!this.token) throw new Error('Must pair before connecting');

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(
        `ws://${this.host}:${this.port}/ws?token=${encodeURIComponent(this.token!)}`,
      );

      this.ws.on('open', () => resolve());
      this.ws.on('error', (err) => reject(err));

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          // Queue first so waitForMessage listeners can splice it out
          this.messageQueue.push(msg);
          // Then notify listeners
          for (const listener of [...this.messageListeners]) {
            listener(msg);
          }
        } catch {
          // Ignore parse errors
        }
      });
    });
  }

  /**
   * Send a JSON message over the WebSocket.
   */
  send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Wait for a message of a specific type.
   */
  waitForMessage(type: string, timeout = 10_000): Promise<Record<string, unknown>> {
    // Check queue first
    const idx = this.messageQueue.findIndex((m) => m.type === type);
    if (idx !== -1) {
      return Promise.resolve(this.messageQueue.splice(idx, 1)[0]);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for "${type}" (${timeout}ms)`));
      }, timeout);

      const listener = (msg: Record<string, unknown>) => {
        if (msg.type === type) {
          cleanup();
          // Remove from queue too — the on('message') handler also pushes there
          const qi = this.messageQueue.indexOf(msg);
          if (qi !== -1) this.messageQueue.splice(qi, 1);
          resolve(msg);
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        const i = this.messageListeners.indexOf(listener);
        if (i !== -1) this.messageListeners.splice(i, 1);
      };

      this.messageListeners.push(listener);
    });
  }

  /**
   * Collect all messages received so far of a given type.
   */
  drainMessages(type?: string): Array<Record<string, unknown>> {
    if (!type) {
      const all = [...this.messageQueue];
      this.messageQueue = [];
      return all;
    }

    const matching: Array<Record<string, unknown>> = [];
    this.messageQueue = this.messageQueue.filter((m) => {
      if (m.type === type) {
        matching.push(m);
        return false;
      }
      return true;
    });
    return matching;
  }

  /**
   * Disconnect and clean up.
   */
  disconnect(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.messageQueue = [];
    this.messageListeners = [];
    this.token = null;
  }
}
