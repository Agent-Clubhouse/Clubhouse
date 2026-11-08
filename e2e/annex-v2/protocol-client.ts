/**
 * Standalone Annex V2 protocol client for integration tests.
 *
 * A lightweight Node.js client that pairs with an Annex server the way a phone
 * does, then talks to it over mTLS: `POST /pair` on the main TLS port with a
 * client certificate whose CN is its identity fingerprint, then REST and the
 * WebSocket on that port presenting the same certificate. The server's
 * certificate is pinned from the pairing answer. Used in vitest integration
 * tests under test/annex-v2/ where Playwright overhead is not needed.
 */
import WebSocket from 'ws';
import * as http from 'http';
import * as https from 'https';
import type * as tls from 'tls';
import { certificateSha256, generateTestIdentity, type TestIdentity } from './tls-test-utils';

export interface AnnexProtocolClientOptions {
  host: string;
  /** Main TLS port: pairing, REST and the WebSocket. */
  port: number;
  /** Plain HTTP port. It only answers `GET /api/v1/identity`; `POST /pair` there is 410. */
  pairingPort?: number;
  /** The client's identity and certificate. A new one is generated when left out. */
  identity?: TestIdentity;
}

export interface PairOptions {
  alias?: string;
  icon?: string;
  color?: string;
  pairingMode?: 'session' | 'persistent';
  /** Sent in place of the identity's own public key. */
  publicKey?: string;
  /** Proof the identity key holds this certificate, for replacing a pinned one. */
  certBinding?: string;
}

export interface PairResponse {
  status: number;
  /** Vestigial: nothing authenticates by it. */
  token?: string;
  error?: string;
  message?: string;
  publicKey?: string;
  alias?: string;
  icon?: string;
  color?: string;
  fingerprint?: string;
  tlsCertificateFingerprint?: string;
  mobileProtocolVersion?: number;
  pairingMode?: string;
}

export interface HttpReply {
  status: number;
  body: unknown;
}

/** A WebSocket upgrade the server answered with an HTTP status instead. */
export class UpgradeRefusedError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`WebSocket upgrade refused (${status}): ${JSON.stringify(body)}`);
  }
}

function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.replace(/[:\s]/g, '').toLowerCase();
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

export class AnnexProtocolClient {
  private host: string;
  private port: number;
  private pairingPort: number;
  private clientIdentity: TestIdentity;
  private paired = false;
  private token: string | null = null;
  private serverCertSha256: string | null = null;
  private ws: WebSocket | null = null;
  private messageQueue: Array<Record<string, unknown>> = [];
  private messageListeners: Array<(msg: Record<string, unknown>) => void> = [];

  constructor(options: AnnexProtocolClientOptions) {
    this.host = options.host;
    this.port = options.port;
    this.pairingPort = options.pairingPort ?? options.port;
    this.clientIdentity = options.identity ?? generateTestIdentity();
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get isPaired(): boolean {
    return this.paired;
  }

  /** The vestigial token from the last pairing. Requests authenticate by certificate. */
  get authToken(): string | null {
    return this.token;
  }

  get identity(): TestIdentity {
    return this.clientIdentity;
  }

  /** SHA-256 of the server certificate pinned at pairing, lowercase hex. */
  get serverCertificateFingerprint(): string | null {
    return this.serverCertSha256;
  }

  /** Present a different certificate from here on (same identity or another). */
  useIdentity(identity: TestIdentity): void {
    this.clientIdentity = identity;
  }

  // ---------------------------------------------------------------------------
  // HTTP methods
  // ---------------------------------------------------------------------------

  /** The server certificate on this socket, checked against the pin once there is one. */
  private checkServerCertificate(socket: tls.TLSSocket): string {
    const raw = socket.getPeerCertificate()?.raw;
    if (!raw?.length) throw new Error('Server showed no certificate');
    const sha256 = certificateSha256(raw);
    if (this.serverCertSha256 && sha256 !== this.serverCertSha256) {
      throw new Error('Server certificate is not the one pinned at pairing');
    }
    return sha256;
  }

  private tlsRequest(method: string, path: string, body?: unknown): Promise<HttpReply & { serverCertSha256: string }> {
    return new Promise((resolve, reject) => {
      const jsonBody = body === undefined ? undefined : JSON.stringify(body);
      const req = https.request({
        hostname: this.host,
        port: this.port,
        path,
        method,
        cert: this.clientIdentity.certPem,
        key: this.clientIdentity.keyPem,
        // Self-signed: the certificate is compared with the pin below instead.
        rejectUnauthorized: false,
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          ...(jsonBody ? { 'Content-Length': Buffer.byteLength(jsonBody) } : {}),
        },
      }, (res) => {
        let serverCertSha256: string;
        try {
          serverCertSha256 = this.checkServerCertificate(res.socket as tls.TLSSocket);
        } catch (err) {
          res.destroy();
          reject(err);
          return;
        }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: parseJson(data), serverCertSha256 }));
      });

      req.on('error', reject);
      if (jsonBody) req.write(jsonBody);
      req.end();
    });
  }

  /**
   * Pair with the Annex server using a PIN, over TLS on the main port with
   * this client's certificate. On success the server certificate is pinned.
   */
  async pair(pin: string, options: PairOptions = {}): Promise<PairResponse> {
    const body: Record<string, unknown> = {
      pin,
      publicKey: options.publicKey ?? this.clientIdentity.ed25519PublicKeyBase64,
      alias: options.alias ?? 'Protocol client',
      icon: options.icon ?? 'phone',
      color: options.color ?? 'indigo',
    };
    if (options.pairingMode) body.pairingMode = options.pairingMode;
    if (options.certBinding) body.certBinding = options.certBinding;

    const res = await this.tlsRequest('POST', '/pair', body);
    const data = (typeof res.body === 'object' && res.body !== null ? res.body : {}) as Omit<PairResponse, 'status'>;

    if (res.status === 200) {
      if (data.tlsCertificateFingerprint && normalizeFingerprint(data.tlsCertificateFingerprint) !== res.serverCertSha256) {
        throw new Error('Pairing answer names a different server certificate than the one shown');
      }
      this.serverCertSha256 = res.serverCertSha256;
      this.paired = true;
      this.token = data.token ?? null;
    }

    return { ...data, status: res.status };
  }

  /** GET on the main TLS port, presenting the client certificate. */
  async get(path: string): Promise<HttpReply> {
    const { status, body } = await this.tlsRequest('GET', path);
    return { status, body };
  }

  /** POST on the main TLS port, presenting the client certificate. */
  async post(path: string, body: unknown): Promise<HttpReply> {
    const res = await this.tlsRequest('POST', path, body);
    return { status: res.status, body: res.body };
  }

  /** Any method on the main TLS port, presenting the client certificate. */
  async request(method: string, path: string, body?: unknown): Promise<HttpReply> {
    const res = await this.tlsRequest(method, path, body);
    return { status: res.status, body: res.body };
  }

  /** A plain HTTP request to the pairing port. */
  pairingPortRequest(method: string, path: string, body?: unknown): Promise<HttpReply> {
    return new Promise((resolve, reject) => {
      const jsonBody = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({
        hostname: this.host,
        port: this.pairingPort,
        path,
        method,
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          ...(jsonBody ? { 'Content-Length': Buffer.byteLength(jsonBody) } : {}),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode || 0, body: parseJson(data) }));
      });
      req.on('error', reject);
      if (jsonBody) req.write(jsonBody);
      req.end();
    });
  }

  // ---------------------------------------------------------------------------
  // WebSocket methods
  // ---------------------------------------------------------------------------

  /**
   * Connect to the WebSocket endpoint over mTLS. Must pair first. A refused
   * upgrade rejects with an UpgradeRefusedError carrying the status and body.
   */
  connect(query = ''): Promise<void> {
    if (!this.paired) throw new Error('Must pair before connecting');
    return this.openSocket(query);
  }

  /** Attempt the WebSocket upgrade whether or not this client has paired. */
  openSocket(query = ''): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://${this.host}:${this.port}/ws${query ? `?${query}` : ''}`, {
        cert: this.clientIdentity.certPem,
        key: this.clientIdentity.keyPem,
        rejectUnauthorized: false,
        maxPayload: 16 * 1024 * 1024,
      });
      this.ws = ws;
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        if (this.ws === ws) this.ws = null;
        reject(err);
      };

      ws.on('upgrade', (res) => {
        try {
          this.checkServerCertificate(res.socket as tls.TLSSocket);
        } catch (err) {
          ws.terminate();
          fail(err);
        }
      });
      ws.on('unexpected-response', (_req, res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => fail(new UpgradeRefusedError(res.statusCode || 0, parseJson(data))));
        res.on('error', () => fail(new UpgradeRefusedError(res.statusCode || 0, data)));
      });
      ws.on('open', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      ws.on('error', (err) => fail(err));

      ws.on('message', (data) => {
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

  /** Resolves with the close code and reason when the open socket closes. */
  waitForClose(timeout = 10_000): Promise<{ code: number; reason: string }> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error('WebSocket not connected'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WebSocket did not close within ${timeout}ms`)), timeout);
      ws.once('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
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

  /** Close the WebSocket only; the pairing stays, so `connect()` works again. */
  closeSocket(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.messageQueue = [];
    this.messageListeners = [];
  }

  /**
   * Disconnect and forget the pairing.
   */
  disconnect(): void {
    this.closeSocket();
    this.paired = false;
    this.token = null;
    this.serverCertSha256 = null;
  }
}
