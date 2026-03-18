/**
 * Integration tests for the Annex protocol client.
 *
 * These tests validate that the AnnexProtocolClient can pair with a real
 * (in-process) Annex server, connect via WebSocket, and receive snapshots.
 *
 * Note: These use vitest's integration project and require the annex server
 * modules to be importable (no Electron runtime needed for the HTTP/WS layer).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AnnexProtocolClient } from '../../e2e/annex-v2/protocol-client';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomInt, randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Minimal mock Annex server for unit testing the protocol client
// ---------------------------------------------------------------------------

interface MockAnnexServer {
  server: http.Server;
  wss: WebSocketServer;
  port: number;
  pin: string;
  tokens: Set<string>;
  close: () => Promise<void>;
}

async function createMockAnnexServer(): Promise<MockAnnexServer> {
  const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const tokens = new Set<string>();

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'POST' && req.url === '/pair') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.pin === pin) {
            const token = randomUUID();
            tokens.add(token);
            res.writeHead(200);
            res.end(JSON.stringify({ token }));
          } else {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'invalid_pin' }));
          }
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'invalid_json' }));
        }
      });
      return;
    }

    // Require auth for everything else
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (!token || !tokens.has(token)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'unauthorized' }));
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
    const url = new URL(req.url || '/', `http://localhost`);
    const urlToken = url.searchParams.get('token');
    if (!urlToken || !tokens.has(urlToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
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

  return {
    server,
    wss,
    port,
    pin,
    tokens,
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
  let mockServer: MockAnnexServer;
  let client: AnnexProtocolClient;

  beforeEach(async () => {
    mockServer = await createMockAnnexServer();
    client = new AnnexProtocolClient({ host: '127.0.0.1', port: mockServer.port });
  });

  afterEach(async () => {
    client.disconnect();
    await mockServer.close();
  });

  it('should pair with a valid PIN', async () => {
    const result = await client.pair(mockServer.pin);
    expect(result.token).toBeDefined();
    expect(typeof result.token).toBe('string');
    expect(client.authToken).toBe(result.token);
  });

  it('should reject an invalid PIN', async () => {
    const result = await client.pair('000000');
    expect(result.error).toBe('invalid_pin');
    expect(client.authToken).toBeNull();
  });

  it('should fetch authenticated endpoints after pairing', async () => {
    await client.pair(mockServer.pin);
    const result = await client.get('/api/v1/status');
    expect(result.status).toBe(200);
    expect((result.body as { version: string }).version).toBe('1');
  });

  it('should reject unauthenticated requests', async () => {
    const result = await client.get('/api/v1/status');
    expect(result.status).toBe(401);
  });

  it('should connect to WebSocket and receive snapshot', async () => {
    await client.pair(mockServer.pin);
    await client.connect();
    expect(client.isConnected).toBe(true);

    const snapshot = await client.waitForMessage('snapshot', 5_000);
    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.payload).toBeDefined();
  });

  it('should throw when connecting without pairing', () => {
    expect(() => client.connect()).toThrow('Must pair before connecting');
  });

  it('should handle message draining', async () => {
    await client.pair(mockServer.pin);
    await client.connect();

    // Wait for the snapshot to arrive
    await client.waitForMessage('snapshot', 5_000);

    // Drain should return empty since we already consumed it
    const drained = client.drainMessages('snapshot');
    expect(drained).toHaveLength(0);
  });

  it('should clean up on disconnect', async () => {
    await client.pair(mockServer.pin);
    await client.connect();
    await client.waitForMessage('snapshot', 5_000);

    client.disconnect();
    expect(client.isConnected).toBe(false);
    expect(client.authToken).toBeNull();
  });
});
