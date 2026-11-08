/**
 * Integration tests for the Annex protocol client.
 *
 * The client pairs over TLS on the main port with a client certificate named
 * for its identity, then uses that certificate for REST and the WebSocket.
 * These tests run it against a small mock server that checks the same things,
 * and check what the real Annex server answers when TLS can't start.
 *
 * Note: These use vitest's integration project and require the annex server
 * modules to be importable (no Electron runtime needed for the HTTP/WS layer).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { AnnexProtocolClient, UpgradeRefusedError } from '../../e2e/annex-v2/protocol-client';
import { certificateSha256, generateTestIdentity, withNewCertificate, type TestIdentity } from '../../e2e/annex-v2/tls-test-utils';

vi.mock('../../src/main/services/annex-identity', () => ({
  getOrCreateIdentity: () => ({
    publicKey: 'test-public-key',
    privateKey: 'test-private-key',
    fingerprint: 'AA:BB:CC:DD',
  }),
  getPublicIdentity: () => ({
    publicKey: 'test-public-key',
    fingerprint: 'AA:BB:CC:DD',
  }),
}));

vi.mock('../../src/main/services/annex-tls', () => ({
  createTlsServerOptions: () => {
    throw new Error('TLS disabled in integration test');
  },
  extractPeerFingerprint: () => null,
  extractPeerCertificateFingerprint: () => undefined,
  extractPeerCertificateDer: () => undefined,
  getCertificateFingerprint: () => undefined,
}));

import * as annexServer from '../../src/main/services/annex-server';
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import type * as tls from 'tls';
import WebSocket, { WebSocketServer } from 'ws';

// ---------------------------------------------------------------------------
// Minimal mock Annex server for unit testing the protocol client
// ---------------------------------------------------------------------------

interface MockAnnexServer {
  server: https.Server;
  wss: WebSocketServer;
  port: number;
  pin: string;
  certSha256: string;
  /** Identity fingerprint → SHA-256 of its pinned client certificate. */
  pinned: Map<string, string>;
  close: () => Promise<void>;
}

function identityFingerprint(publicKeyBase64: string): string {
  return crypto.createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex').slice(0, 32).match(/.{2}/g)!.join(':');
}

/** The presented client certificate's CN and SHA-256, if there is one. */
function clientCertificate(socket: tls.TLSSocket): { cn: string; sha256: string } | null {
  const cert = socket.getPeerCertificate();
  if (!cert?.raw?.length) return null;
  const cn = cert.subject?.CN;
  return { cn: Array.isArray(cn) ? cn[0] : cn ?? '', sha256: certificateSha256(cert.raw) };
}

async function createMockAnnexServer(serverIdentity: TestIdentity): Promise<MockAnnexServer> {
  const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const pinned = new Map<string, string>();

  const authenticate = (socket: tls.TLSSocket): { status: number; error: string } | null => {
    const presented = clientCertificate(socket);
    if (!presented) return { status: 401, error: 'unauthorized' };
    if (pinned.get(presented.cn) !== presented.sha256) return { status: 401, error: 'peer_not_paired' };
    return null;
  };

  const server = https.createServer({ cert: serverIdentity.certPem, key: serverIdentity.keyPem, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const socket = req.socket as tls.TLSSocket;

    if (req.method === 'POST' && req.url === '/pair') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed: { pin?: unknown; publicKey?: unknown };
        try { parsed = JSON.parse(body); } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'invalid_json' }));
          return;
        }
        const presented = clientCertificate(socket);
        if (!presented || typeof parsed.publicKey !== 'string' || identityFingerprint(parsed.publicKey) !== presented.cn) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'client_certificate_required', message: 'Pairing needs the device certificate that matches its identity.' }));
          return;
        }
        if (parsed.pin !== pin) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: 'invalid_pin', message: "That code doesn't match." }));
          return;
        }
        pinned.set(presented.cn, presented.sha256);
        res.writeHead(200);
        res.end(JSON.stringify({ token: crypto.randomUUID(), tlsCertificateFingerprint: certSha256.toUpperCase().match(/.{2}/g)!.join(':'), mobileProtocolVersion: 1, pairingMode: 'persistent' }));
      });
      return;
    }

    const refusal = authenticate(socket);
    if (refusal) {
      res.writeHead(refusal.status);
      res.end(JSON.stringify({ error: refusal.error, message: 'Pair this device again.' }));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/v1/status') {
      res.writeHead(200);
      res.end(JSON.stringify({ version: '1', deviceName: 'Test', agentCount: 0 }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const refusal = authenticate(socket as tls.TLSSocket);
    if (refusal) {
      const json = JSON.stringify({ error: refusal.error, message: 'Pair this device again.' });
      socket.end(`HTTP/1.1 ${refusal.status} Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({
      type: 'snapshot',
      payload: { projects: [], agents: {}, quickAgents: {} },
    }));
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' ? addr!.port : 0);
    });
  });
  const certSha256 = certificateSha256(serverIdentity.certPem);

  return {
    server,
    wss,
    port,
    pin,
    certSha256,
    pinned,
    close: () => new Promise<void>((resolve) => {
      for (const client of wss.clients) {
        try { client.close(); } catch { /* ignore */ }
      }
      wss.close();
      server.close(() => resolve());
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnnexProtocolClient', () => {
  let serverIdentity: TestIdentity;
  let clientIdentity: TestIdentity;
  let mockServer: MockAnnexServer;
  let client: AnnexProtocolClient;

  beforeAll(() => {
    serverIdentity = generateTestIdentity();
    clientIdentity = generateTestIdentity();
  });

  beforeEach(async () => {
    mockServer = await createMockAnnexServer(serverIdentity);
    client = new AnnexProtocolClient({ host: '127.0.0.1', port: mockServer.port, identity: clientIdentity });
  });

  afterEach(async () => {
    client.disconnect();
    await mockServer.close();
  });

  it('pairs over TLS with its client certificate, and pins the server certificate', async () => {
    const result = await client.pair(mockServer.pin);
    expect(result.status).toBe(200);
    expect(typeof result.token).toBe('string');
    expect(client.isPaired).toBe(true);
    expect(client.authToken).toBe(result.token);
    expect(client.serverCertificateFingerprint).toBe(mockServer.certSha256);
    expect(mockServer.pinned.get(clientIdentity.fingerprint)).toBe(certificateSha256(clientIdentity.certPem));
  });

  it('a wrong PIN is 409 invalid_pin with a message, and nothing is paired', async () => {
    const result = await client.pair('000000');
    expect(result.status).toBe(409);
    expect(result.error).toBe('invalid_pin');
    expect(result.message).toEqual(expect.any(String));
    expect(client.isPaired).toBe(false);
    expect(client.authToken).toBeNull();
  });

  it('fetches authenticated endpoints after pairing', async () => {
    await client.pair(mockServer.pin);
    const result = await client.get('/api/v1/status');
    expect(result.status).toBe(200);
    expect((result.body as { version: string }).version).toBe('1');
  });

  it('an identity that has not paired gets 401', async () => {
    const result = await client.get('/api/v1/status');
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: 'peer_not_paired' });
  });

  it('another certificate for a paired identity gets 401', async () => {
    await client.pair(mockServer.pin);
    client.useIdentity(withNewCertificate(clientIdentity));
    const result = await client.get('/api/v1/status');
    expect(result.status).toBe(401);
    await expect(client.connect()).rejects.toMatchObject({ status: 401 });
  });

  it('connects to the WebSocket and receives a snapshot', async () => {
    await client.pair(mockServer.pin);
    await client.connect();
    expect(client.isConnected).toBe(true);

    const snapshot = await client.waitForMessage('snapshot', 5_000);
    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.payload).toBeDefined();
  });

  it('a refused upgrade rejects with its status and body', async () => {
    const refused = await client.openSocket().catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(UpgradeRefusedError);
    expect(refused).toMatchObject({ status: 401, body: { error: 'peer_not_paired' } });
    expect(client.isConnected).toBe(false);
  });

  it('throws when connecting without pairing', () => {
    expect(() => client.connect()).toThrow('Must pair before connecting');
  });

  it('handles message draining', async () => {
    await client.pair(mockServer.pin);
    await client.connect();

    // Wait for the snapshot to arrive
    await client.waitForMessage('snapshot', 5_000);

    // Drain should return empty since we already consumed it
    const drained = client.drainMessages('snapshot');
    expect(drained).toHaveLength(0);
  });

  it('closeSocket keeps the pairing, so it can connect again', async () => {
    await client.pair(mockServer.pin);
    await client.connect();
    await client.waitForMessage('snapshot', 5_000);

    client.closeSocket();
    expect(client.isConnected).toBe(false);
    await client.connect();
    expect((await client.waitForMessage('snapshot', 5_000)).type).toBe('snapshot');
  });

  it('cleans up on disconnect', async () => {
    await client.pair(mockServer.pin);
    await client.connect();
    await client.waitForMessage('snapshot', 5_000);

    client.disconnect();
    expect(client.isConnected).toBe(false);
    expect(client.isPaired).toBe(false);
    expect(client.authToken).toBeNull();
  });
});

describe('the Annex server when TLS cannot start', () => {
  afterEach(() => {
    annexServer.stop();
  });

  const plainRequest = (port: number, method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const json = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false,
      headers: json ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) } : {} }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(json);
  });

  const startServer = async () => {
    annexServer.start();
    await vi.waitFor(() => {
      const status = annexServer.getStatus();
      expect(status.port).toBeGreaterThan(0);
      expect(status.pairingPort).toBeGreaterThan(0);
    });
    return annexServer.getStatus();
  };

  it('the main port answers 503 tls_unavailable to requests, pairing and the WebSocket', async () => {
    const status = await startServer();
    expect(status.tlsEnabled).toBe(false);
    expect(status.pairingUrl).toBeUndefined();

    for (const [method, path, body] of [['GET', '/api/v1/status'], ['GET', '/api/v1/identity'], ['POST', '/pair', { pin: status.pin }]] as const) {
      const reply = await plainRequest(status.port, method, path, body);
      expect(reply.status).toBe(503);
      expect(reply.body).toMatchObject({ error: 'tls_unavailable', message: expect.any(String) });
    }

    const upgrade = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${status.port}/ws`);
      ws.on('open', () => { ws.close(); reject(new Error('upgrade accepted')); });
      ws.on('error', () => {});
      ws.on('unexpected-response', (_req, res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
      });
    });
    expect(upgrade.status).toBe(503);
    expect(upgrade.body).toMatchObject({ error: 'tls_unavailable' });
  });

  it('the pairing port answers POST /pair with 410 update_required, and still gives its identity', async () => {
    const status = await startServer();
    const identity = generateTestIdentity();

    const pair = await plainRequest(status.pairingPort, 'POST', '/pair', { pin: status.pin, publicKey: identity.ed25519PublicKeyBase64 });
    expect(pair.status).toBe(410);
    expect(pair.body).toMatchObject({ error: 'update_required', message: expect.any(String) });
    expect(pair.body).not.toHaveProperty('token');

    const hint = await plainRequest(status.pairingPort, 'GET', '/api/v1/identity');
    expect(hint.status).toBe(200);
    expect(hint.body).toMatchObject({ fingerprint: 'AA:BB:CC:DD', publicKey: 'test-public-key' });
  });
});
