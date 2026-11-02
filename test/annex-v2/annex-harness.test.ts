/**
 * The real Annex server, off the host app, for testing a phone against it. Real
 * identity, TLS, pairing, peers, routes and WebSockets, in a temp folder with HOME
 * pointed there too, so nothing reads or writes the user's data. Only the stores
 * are fixtures, and they can be told to fail. docs/annex-harness.md says how to use it.
 *
 * In a normal test run this checks the harness over real sockets, which is also the
 * server's own proof of how it behaves under these faults. `npm run harness:annex`
 * keeps it running, with a control port, for a client to point at.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import forge from 'node-forge';
import { WebSocket } from 'ws';

const H = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs'); const nodeOs = require('os') as typeof import('os'); const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'annex-harness-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return {
    dir,
    fault: 'none' as 'none' | 'fail' | 'hang' | 'oversize',
    /** How many snapshot builds have read from disk, and how many are in progress. */
    reads: 0,
    readsRunning: 0,
    maxReadsRunning: 0,
    releaseHung: [] as Array<() => void>,
    /** Annex's real listener on the project list, to fire as a write would. */
    projectListeners: new Set<() => void>(),
    projects: 2,
    agentsPerProject: 3,
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => H.dir, isPackaged: false, getVersion: () => '0.0.0-harness', getName: () => 'annex-harness', on: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle: () => {}, on: () => {} },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  shell: {},
  dialog: {},
  Notification: class {},
}));
vi.mock('bonjour-service', () => ({ default: class { publish() { return { stop() {} }; } destroy() {} } }));
vi.mock('../../src/main/services/log-service', () => ({ appLog: () => {} }));
vi.mock('../../src/main/services/annex-network-profile', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/main/services/annex-network-profile')>(),
  annexNetworkProfile: () => ({ host: '127.0.0.1', advertise: false }),
}));
vi.mock('../../src/main/services/project-store', () => ({
  list: async () => {
    // Here because a build carries on without a canvas it can't read, but not without its projects.
    if (H.fault === 'fail') {
      H.reads++;
      throw new Error('harness: read failed');
    }
    return Array.from({ length: H.projects }, (_, p) => ({
      id: `proj_${p}`, name: `project-${p}`, path: `/fixture/project-${p}`, color: 'indigo',
      // A required field, so nothing can be given up to make it fit.
      ...(H.fault === 'oversize' && { displayName: 'x'.repeat(17 * 1024 * 1024) }),
    }));
  },
  iconFilePath: async () => null,
  readIconData: async () => null,
  onProjectsChanged: (listener: () => void) => {
    H.projectListeners.add(listener);
    return () => H.projectListeners.delete(listener);
  },
}));
vi.mock('../../src/main/services/agent-config', () => ({
  listDurable: async (projectPath: string) => Array.from({ length: H.agentsPerProject }, (_, a) => ({
    id: `durable_${projectPath.slice(-1)}_${a}`, name: `agent-${a}`, color: 'indigo', createdAt: '2026-01-01T00:00:00.000Z',
  })),
  agentIconFilePath: async () => null,
  readAgentIconData: async () => null,
  getDurableConfig: async () => null,
  isSameProject: async () => false,
  onAgentConfigChanged: () => () => {},
}));
vi.mock('../../src/main/services/plugin-storage', () => ({
  // The one read every snapshot build makes once and nothing else does, so hangs and counts live here.
  readKey: async ({ key, scope }: { key: string; scope: string }) => {
    if (key !== 'canvas-instances' || scope !== 'global') return null;
    H.reads++;
    H.readsRunning++;
    H.maxReadsRunning = Math.max(H.maxReadsRunning, H.readsRunning);
    try {
      if (H.fault === 'hang') await new Promise<void>((resolve) => { H.releaseHung.push(resolve); });
      return null;
    } finally {
      H.readsRunning--;
    }
  },
  writeKey: async () => {},
}));
vi.mock('../../src/main/services/plugin-manifest-registry', () => ({ listAllManifests: () => [] }));
vi.mock('../../src/main/services/group-project-registry', () => ({ groupProjectRegistry: { list: async () => [], onChange: () => () => {} } }));
vi.mock('../../src/main/services/clubhouse-mcp/binding-manager', () => ({ bindingManager: { getAllBindings: () => [], onBindingsChanged: () => () => {} } }));

import * as annexServer from '../../src/main/services/annex-server';
import * as eventReplay from '../../src/main/services/annex-event-replay';
import { clearChatRuntimes, publishChatEvent, registerChatRuntime } from '../../src/main/services/agent-runtime';

function clientCertificate(commonName: string) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString());
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  cert.setSubject([{ name: 'commonName', value: commonName }]);
  cert.setIssuer(cert.subject.attributes);
  cert.sign(forge.pki.privateKeyFromPem(key), forge.md.sha256.create());
  return { key, cert: forge.pki.certificateToPem(cert) };
}

/** A client as a phone is: an Ed25519 identity, and a certificate named for its fingerprint. */
function phoneIdentity() {
  const der = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
  const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  const commonName = hex.match(/.{2}/g)!.join(':');
  return { publicKey: der.toString('base64'), ...clientCertificate(commonName) };
}

function pair(port: number, pin: string, phone: ReturnType<typeof phoneIdentity>): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ pin, publicKey: phone.publicKey, alias: 'Harness phone', icon: 'phone', color: 'indigo' });
    const req = https.request({ host: '127.0.0.1', port, path: '/pair', method: 'POST', key: phone.key, cert: phone.cert, rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** As if the project list were written this many times: Annex's real debounce decides the rest. */
function fireProjectsChanged(count = 1): void {
  for (let i = 0; i < count; i++) for (const listener of H.projectListeners) listener();
}

/** Clears a fault, and lets hung reads end. */
function setFault(fault: typeof H.fault): void {
  H.fault = fault;
  if (fault !== 'hang') for (const release of H.releaseHung.splice(0)) release();
}

interface Harness { port: number; pin: string }

async function startServer(): Promise<Harness> {
  annexServer.start();
  await vi.waitFor(() => expect(annexServer.getStatus().port).toBeGreaterThan(0), { timeout: 20_000 });
  const status = annexServer.getStatus();
  return { port: status.port, pin: status.pin };
}

describe('Annex harness', () => {
  let harness: Harness;
  let phone: ReturnType<typeof phoneIdentity>;
  const sockets: WebSocket[] = [];

  const connect = async () => {
    const ws = new WebSocket(`wss://127.0.0.1:${harness.port}/ws`, { key: phone.key, cert: phone.cert, rejectUnauthorized: false, maxPayload: 16 * 1024 * 1024 });
    const frames: any[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
    ws.on('error', () => {});
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
    });
    return { ws, frames };
  };
  const firstFrame = (frames: any[]) => vi.waitFor(() => { expect(frames.length).toBeGreaterThan(0); return frames[0]; }, { timeout: 30_000 });

  beforeAll(async () => {
    harness = await startServer();
    phone = phoneIdentity();
    const paired = await pair(harness.port, harness.pin, phone);
    expect(paired.status).toBe(200);
  }, 60_000);

  afterAll(() => {
    for (const ws of sockets) ws.terminate();
    annexServer.stop();
    fs.rmSync(H.dir, { recursive: true, force: true });
  });

  it('never leaves its temp folder', () => {
    expect(os.homedir()).toBe(H.dir);
    expect(fs.existsSync(path.join(H.dir, 'annex-identity.json')) || fs.readdirSync(H.dir).length > 0).toBe(true);
  });

  it('pairs another phone with the same PIN, as a client using the harness will', async () => {
    const paired = await pair(harness.port, harness.pin, phoneIdentity());
    expect(paired.status).toBe(200);
    expect(paired.body.tlsCertificateFingerprint).toBeTruthy();
  }, 60_000);

  it('a paired phone gets a snapshot first, over real mTLS, then live events in order', async () => {
    setFault('none');
    const { frames } = await connect();
    const snapshot = await firstFrame(frames);
    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.payload.projects).toHaveLength(H.projects);
    expect(snapshot.payload.lastSeq).toBe(eventReplay.getLastSeq());

    publishChatEvent({ agentId: 'durable_0_0', type: 'turn_ended', seq: 1, ts: 0, sessionId: 's', data: {} } as never);
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'chat:event')).toBe(true));
    expect(frames.find((f) => f.type === 'chat:event').seq).toBe(snapshot.payload.lastSeq + 1);
  }, 60_000);

  it('a failed build: snapshot_failed, the socket stays up, and recovery brings the snapshot', async () => {
    setFault('fail');
    const { ws, frames } = await connect();
    expect(await firstFrame(frames)).toEqual({ type: 'error', payload: { message: 'snapshot_failed' } });
    expect(ws.readyState).toBe(WebSocket.OPEN);

    setFault('none');
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'snapshot')).toBe(true), { timeout: 15_000 });
    expect(ws.readyState).toBe(WebSocket.OPEN);
  }, 60_000);

  it('many connections during one hung build: one read on the host, and everyone hears', async () => {
    await vi.waitFor(() => expect(H.readsRunning).toBe(0));
    setFault('hang');
    const readsBefore = H.reads;
    H.maxReadsRunning = 0;
    const clients = await Promise.all(Array.from({ length: 12 }, () => connect()));
    await new Promise((r) => setTimeout(r, 500));
    expect(H.reads).toBe(readsBefore + 1);

    for (const { frames } of clients) expect(await firstFrame(frames)).toEqual({ type: 'error', payload: { message: 'snapshot_failed' } });
    expect(H.maxReadsRunning).toBe(1);
    for (const { ws } of clients) expect(ws.readyState).toBe(WebSocket.OPEN);

    setFault('none');
    await vi.waitFor(() => {
      for (const { frames } of clients) expect(frames.some((f) => f.type === 'snapshot')).toBe(true);
    }, { timeout: 75_000 });
  }, 120_000);

  describe('project changes, through the real debounce', () => {
    const DEBOUNCE_MS = annexServer._testing.PROJECTS_CHANGED_DEBOUNCE_MS;
    const settle = (ms = DEBOUNCE_MS * 3) => new Promise((r) => setTimeout(r, ms));
    const snapshotsOf = (frames: any[]) => frames.filter((f) => f.type === 'snapshot');

    /** A healthy socket, past its first snapshot, with nothing pending on the host. */
    const liveClient = async () => {
      setFault('none');
      const client = await connect();
      await vi.waitFor(() => expect(snapshotsOf(client.frames)).toHaveLength(1), { timeout: 75_000 });
      await vi.waitFor(() => expect(H.readsRunning).toBe(0));
      await settle();
      return client;
    };

    it('idle, 20 give one ordered snapshot and one read, with no false gap', async () => {
      const { frames } = await liveClient();
      const reads = H.reads;
      const seq = eventReplay.getLastSeq();

      fireProjectsChanged(20);
      await vi.waitFor(() => expect(snapshotsOf(frames)).toHaveLength(2));
      await settle();

      expect(H.reads).toBe(reads + 1);
      expect(snapshotsOf(frames)).toHaveLength(2);
      expect(snapshotsOf(frames)[1].payload.lastSeq).toBe(seq);
    }, 120_000);

    it('20 during a slow read give one follow-up read, one at a time', async () => {
      const { frames } = await liveClient();
      setFault('hang');
      annexServer.broadcastSnapshotRefresh();
      await vi.waitFor(() => expect(H.readsRunning).toBe(1));
      const reads = H.reads;

      fireProjectsChanged(20);
      await settle();
      expect(H.reads).toBe(reads);

      setFault('none');
      await vi.waitFor(() => expect(H.reads).toBe(reads + 1));
      await vi.waitFor(() => expect(snapshotsOf(frames).length).toBeGreaterThanOrEqual(3));
      await settle();
      expect(H.reads).toBe(reads + 1);
      expect(H.maxReadsRunning).toBe(1);
    }, 120_000);

    it('20 during a failure backoff read nothing extra, then recover', async () => {
      const { frames } = await liveClient();
      setFault('fail');
      const started = H.reads;
      annexServer.broadcastSnapshotRefresh();
      // The failed read has happened, so the host is in its backoff window.
      await vi.waitFor(() => expect(H.reads).toBe(started + 1));
      await settle(50);
      const reads = H.reads;

      fireProjectsChanged(20);
      await settle();
      expect(H.reads).toBe(reads);

      setFault('none');
      const before = snapshotsOf(frames).length;
      await vi.waitFor(() => expect(snapshotsOf(frames).length).toBeGreaterThan(before), { timeout: 75_000 });
    }, 120_000);

    it('a disconnect during the debounce: no read for that, and no error', async () => {
      for (const ws of sockets.splice(0)) ws.terminate();
      const { ws } = await liveClient();
      const reads = H.reads;

      fireProjectsChanged(20);
      ws.terminate();
      sockets.length = 0;
      await vi.waitFor(() => expect(annexServer._testing.wss!.clients.size).toBe(0));
      await settle();

      expect(H.reads).toBe(reads);
      expect(H.readsRunning).toBe(0);
    }, 120_000);
  });

  describe('chat pages, over real TLS', () => {
    const AGENT = 'durable_0_0';
    const options = [{ optionId: 'allow', kind: 'allow_once', label: 'Allow' }, { optionId: 'deny', kind: 'reject_once', label: 'Deny' }];
    const envelope = (seq: number, type: string, data: object) => ({ v: 1, type, agentId: AGENT, sessionId: 's', seq, ts: Date.now(), data });

    /** Reads a page as raw bytes, the way a phone's transport counts them. */
    const getChat = () => new Promise<{ status: number; bytes: number; body: any }>((resolve, reject) => {
      https.get({ host: '127.0.0.1', port: harness.port, path: `/api/v1/mobile/agents/${AGENT}/chat`, key: phone.key, cert: phone.cert, rejectUnauthorized: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          resolve({ status: res.statusCode!, bytes: raw.length, body: JSON.parse(raw.toString()) });
        });
      }).on('error', reject);
    });

    const withTranscript = (events: object[]) => registerChatRuntime({
      kind: 'chat', agentId: AGENT, isRunning: () => true, getState: () => 'waiting_permission', getSessionId: () => 's', getCapabilities: () => null,
      readTranscript: async () => ({ events }),
    } as never);

    afterAll(() => clearChatRuntimes());

    it('a 20 MB tool result: a page within 8 MiB, keeping id and final status', async () => {
      withTranscript([envelope(1, 'tool_call_update', { toolCallId: 't', status: 'completed', content: [{ type: 'text', text: 't'.repeat(20 * 1024 * 1024) }] })]);
      const page = await getChat();
      expect(page.status).toBe(200);
      expect(page.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(page.body.events[0].data).toMatchObject({ toolCallId: 't', status: 'completed', contentMode: 'replace' });
    }, 60_000);

    it('more tail than fits: within 8 MiB, with a next page', async () => {
      withTranscript(Array.from({ length: 40 }, (_, i) => envelope(i + 1, 'notice', { level: 'info', message: 'n'.repeat(512 * 1024) })));
      const page = await getChat();
      expect(page.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(page.body.truncated).toBe(true);
      expect(page.body.nextBeforeSeq).toBe(page.body.events[0].seq);
    }, 60_000);

    it('many pending: every row minimal, none missing', async () => {
      withTranscript(Array.from({ length: 300 }, (_, i) => envelope(i + 1, 'permission_request', { requestId: `p${i}`, title: `Write ${i}`, toolName: 'Write', options, rawInput: { content: 'c'.repeat(8192) } })));
      const page = await getChat();
      expect(page.status).toBe(200);
      expect(page.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(page.body.pendingPermissions).toHaveLength(300);
      expect(page.body.pendingPermissions[0].data.options.map((o: { kind: string }) => o.kind)).toEqual(['reject_once']);
    }, 60_000);

    it('a question that can not fit: a 503, never a shortened one', async () => {
      withTranscript([envelope(1, 'question', { requestId: 'q', questions: [{ id: 'q', prompt: 'p'.repeat(9 * 1024 * 1024), header: 'H', options: [] }] })]);
      const page = await getChat();
      expect(page.status).toBe(503);
      expect(page.body.error).toBe('pending_overflow');
      expect(page.bytes).toBeLessThan(1024);
    }, 60_000);
  });

  it('a snapshot too large to send never goes out, and reconnects do not build it again', async () => {
    await vi.waitFor(() => expect(H.readsRunning).toBe(0));
    setFault('oversize');
    annexServer.broadcastSnapshotRefresh();
    const first = await connect();
    await vi.waitFor(() => expect(first.frames.some((f) => f.type === 'error')).toBe(true), { timeout: 45_000 });
    const readsAfter = H.reads;

    const again = await Promise.all(Array.from({ length: 4 }, () => connect()));
    for (const { frames } of again) expect(await firstFrame(frames)).toEqual({ type: 'error', payload: { message: 'snapshot_failed' } });
    expect(H.reads).toBe(readsAfter);
    for (const { ws } of [first, ...again]) expect(ws.readyState).toBe(WebSocket.OPEN);
    expect([first, ...again].flatMap(({ frames }) => frames).some((f) => f.type === 'snapshot')).toBe(false);
    setFault('none');
  }, 120_000);

  // `npm run harness:annex`: stays up until POST /stop on the control port.
  it.runIf(process.env.CLUBHOUSE_ANNEX_HARNESS === '1')('serves until told to stop', async () => {
    setFault('none');
    await new Promise<void>((resolve) => {
      const control = http.createServer((req, res) => {
        let text = '';
        req.on('data', (c) => { text += c; });
        req.on('end', () => {
          const body = text ? JSON.parse(text) : {};
          if (req.url === '/fault') setFault(body.fault);
          if (req.url === '/fixture') { H.projects = body.projects ?? H.projects; H.agentsPerProject = body.agentsPerProject ?? H.agentsPerProject; }
          if (req.url === '/refresh') annexServer.broadcastSnapshotRefresh();
          if (req.url === '/projects-changed') fireProjectsChanged(body.count);
          if (req.url === '/theme') annexServer.broadcastThemeChanged();
          // What a desktop restart does to the event seq, without new certificates.
          if (req.url === '/reset-seq') eventReplay.reset();
          if (req.url === '/chat-event') publishChatEvent({ agentId: body.agentId ?? 'durable_0_0', type: 'turn_ended', seq: 1, ts: 0, sessionId: 's', data: {} } as never);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ fault: H.fault, reads: H.reads, readsRunning: H.readsRunning, maxReadsRunning: H.maxReadsRunning, lastSeq: eventReplay.getLastSeq() }));
          if (req.url === '/stop') { control.close(); resolve(); }
        });
      });
      control.listen(0, '127.0.0.1', () => {
        const status = annexServer.getStatus();
        console.info(`ANNEX_HARNESS ${JSON.stringify({ host: '127.0.0.1', port: status.port, pairingPort: (status as { pairingPort?: number }).pairingPort, pin: status.pin, controlPort: (control.address() as { port: number }).port, dataDir: H.dir })}`);
      });
    });
  }, 24 * 60 * 60 * 1000);
});
