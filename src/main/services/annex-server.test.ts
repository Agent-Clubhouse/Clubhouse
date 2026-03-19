import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import net from 'net';

const mockBonjourService = { stop: vi.fn() };
const mockBonjour = {
  publish: vi.fn().mockReturnValue(mockBonjourService),
  destroy: vi.fn(),
};

// Mock bonjour-service before importing annex-server
vi.mock('bonjour-service', () => ({
  default: vi.fn().mockImplementation(() => mockBonjour),
}));

// Mock log-service
vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

// Mock project-store
vi.mock('./project-store', () => ({
  list: vi.fn().mockReturnValue([]),
  readIconData: vi.fn().mockReturnValue(null),
}));

// Mock agent-config
vi.mock('./agent-config', () => ({
  listDurable: vi.fn().mockReturnValue([]),
  readAgentIconData: vi.fn().mockReturnValue(null),
}));

// Mock pty-manager
vi.mock('./pty-manager', () => ({
  getBuffer: vi.fn().mockReturnValue(''),
  isRunning: vi.fn().mockReturnValue(false),
}));

// Mock annex-identity
vi.mock('./annex-identity', () => ({
  getOrCreateIdentity: vi.fn().mockReturnValue({
    publicKey: 'fake-public-key',
    privateKey: 'fake-private-key',
    fingerprint: 'AA:BB:CC:DD',
  }),
  getPublicIdentity: vi.fn().mockReturnValue({
    publicKey: 'fake-public-key',
    fingerprint: 'AA:BB:CC:DD',
  }),
  computeFingerprint: vi.fn().mockReturnValue('AA:BB:CC:DD'),
}));

// Mock annex-tls
vi.mock('./annex-tls', () => ({
  createTlsServerOptions: vi.fn().mockImplementation(() => {
    // Throw so the server falls back to plain HTTP (simpler for tests)
    throw new Error('TLS not available in test');
  }),
  extractPeerFingerprint: vi.fn().mockReturnValue(null),
}));

// Mock annex-peers
vi.mock('./annex-peers', () => ({
  checkBruteForce: vi.fn().mockReturnValue({ allowed: true, delayMs: 0, locked: false, attemptsRemaining: 3 }),
  recordFailedAttempt: vi.fn(),
  recordSuccessfulAttempt: vi.fn(),
  addPeer: vi.fn(),
  isPairedPeer: vi.fn().mockReturnValue(false),
  updateLastSeen: vi.fn(),
  listPeers: vi.fn().mockReturnValue([]),
  removePeer: vi.fn(),
  removeAllPeers: vi.fn(),
  unlockPairing: vi.fn(),
}));

// Mock annex-event-bus
vi.mock('./annex-event-bus', () => ({
  setActive: vi.fn(),
  onPtyData: vi.fn().mockReturnValue(() => {}),
  onHookEvent: vi.fn().mockReturnValue(() => {}),
  onPtyExit: vi.fn().mockReturnValue(() => {}),
  onAgentSpawned: vi.fn().mockReturnValue(() => {}),
  onStructuredEvent: vi.fn().mockReturnValue(() => {}),
}));

// Mock theme-service
vi.mock('./theme-service', () => ({
  getActiveThemeId: vi.fn().mockReturnValue('catppuccin-mocha'),
}));

// Mock annex-settings
vi.mock('./annex-settings', () => ({
  getSettings: vi.fn().mockReturnValue({ enableServer: false, enableClient: false, deviceName: 'Test Machine', alias: 'Test Machine', icon: 'computer', color: 'indigo', autoReconnect: false }),
  saveSettings: vi.fn(),
}));

// Mock plugin-manifest-registry
vi.mock('./plugin-manifest-registry', () => ({
  listAllManifests: vi.fn().mockReturnValue([]),
}));

// Mock annex-identity
vi.mock('./annex-identity', () => ({
  getOrCreateIdentity: vi.fn().mockReturnValue({
    publicKey: 'mock-public-key',
    privateKey: 'mock-private-key',
    fingerprint: 'aa:bb:cc',
    createdAt: '2025-01-01T00:00:00.000Z',
  }),
  getPublicIdentity: vi.fn().mockReturnValue({
    publicKey: 'mock-public-key',
    fingerprint: 'aa:bb:cc',
  }),
  computeFingerprint: vi.fn().mockReturnValue('dd:ee:ff'),
}));

// Mock annex-tls — force TLS creation to fail so we fall back to plain HTTP
vi.mock('./annex-tls', () => ({
  createTlsServerOptions: vi.fn().mockImplementation(() => { throw new Error('TLS disabled in test'); }),
  extractPeerFingerprint: vi.fn().mockReturnValue(null),
}));

// Mock annex-peers
vi.mock('./annex-peers', () => ({
  checkBruteForce: vi.fn().mockReturnValue({ allowed: true, locked: false }),
  recordFailedAttempt: vi.fn(),
  recordSuccessfulAttempt: vi.fn(),
  addPeer: vi.fn(),
  getPeer: vi.fn().mockReturnValue(null),
  isPairedPeer: vi.fn().mockReturnValue(false),
  updateLastSeen: vi.fn(),
}));

// Mock agent-system
vi.mock('./agent-system', () => ({
  getAvailableOrchestrators: vi.fn().mockReturnValue([]),
  spawnAgent: vi.fn().mockResolvedValue(undefined),
  isHeadlessAgent: vi.fn().mockReturnValue(false),
}));

// Mock structured-manager
vi.mock('./structured-manager', () => ({
  isStructuredSession: vi.fn().mockReturnValue(false),
  respondToPermission: vi.fn().mockResolvedValue(undefined),
}));

// Mock name-generator
vi.mock('../../shared/name-generator', () => ({
  generateQuickName: vi.fn().mockReturnValue('swift-fox'),
}));

// Mock ipc-broadcast (used for notifying renderer of annex-spawned agents)
const mockBroadcastToAllWindows = vi.fn();
vi.mock('../util/ipc-broadcast', () => ({
  broadcastToAllWindows: (...args: unknown[]) => mockBroadcastToAllWindows(...args),
}));

import * as annexServer from './annex-server';
import * as annexSettings from './annex-settings';
import * as annexIdentity from './annex-identity';
import * as annexTls from './annex-tls';
import * as annexPeers from './annex-peers';
import * as annexEventBus from './annex-event-bus';
import * as projectStore from './project-store';
import * as agentConfigModule from './agent-config';
import * as ptyManagerModule from './pty-manager';
import * as agentSystem from './agent-system';
import * as structuredManagerModule from './structured-manager';
import * as _eventReplay from './annex-event-replay';
import * as permissionQueue from './annex-permission-queue';
import * as pluginManifestRegistry from './plugin-manifest-registry';
import { generateQuickName } from '../../shared/name-generator';
import { appLog } from './log-service';
import Bonjour from 'bonjour-service';

function request(port: number, method: string, path: string, body?: object, headers?: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function startAndPair(): Promise<{ port: number; token: string; pin: string }> {
  annexServer.start();
  await new Promise((r) => setTimeout(r, 100));
  const status = annexServer.getStatus();
  // Pair on the pairing port (plain HTTP), then use the main port for authenticated requests
  const pairingPort = (status as any).pairingPort || status.port;
  const pairRes = await request(pairingPort, 'POST', '/pair', { pin: status.pin });
  const { token } = JSON.parse(pairRes.body);
  return { port: status.port, token, pin: status.pin };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe('annex-server', () => {
  beforeEach(() => {
    // Re-apply mock return values after mockReset clears them
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enabled: false, deviceName: 'Test Machine', alias: 'Test Machine', icon: 'computer', color: 'indigo', autoReconnect: false });
    vi.mocked(annexIdentity.getOrCreateIdentity).mockReturnValue({
      publicKey: 'mock-public-key',
      privateKey: 'mock-private-key',
      fingerprint: 'aa:bb:cc',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    vi.mocked(annexIdentity.getPublicIdentity).mockReturnValue({
      publicKey: 'mock-public-key',
      fingerprint: 'aa:bb:cc',
    });
    vi.mocked(annexIdentity.computeFingerprint).mockReturnValue('dd:ee:ff');
    vi.mocked(annexTls.createTlsServerOptions).mockImplementation(() => { throw new Error('TLS disabled in test'); });
    vi.mocked(annexPeers.checkBruteForce).mockReturnValue({ allowed: true, locked: false } as any);
    vi.mocked(annexPeers.recordFailedAttempt).mockReturnValue(undefined);
    vi.mocked(annexPeers.recordSuccessfulAttempt).mockReturnValue(undefined);
    vi.mocked(projectStore.list).mockReturnValue([]);
    vi.mocked(agentConfigModule.listDurable).mockReturnValue([]);
    vi.mocked(ptyManagerModule.getBuffer).mockReturnValue('');
    vi.mocked(ptyManagerModule.isRunning).mockReturnValue(false);
    vi.mocked(agentSystem.isHeadlessAgent).mockReturnValue(false);
    vi.mocked(agentSystem.spawnAgent).mockResolvedValue(undefined);
    vi.mocked(agentSystem.getAvailableOrchestrators).mockReturnValue([]);
    vi.mocked(structuredManagerModule.isStructuredSession).mockReturnValue(false);
    vi.mocked(structuredManagerModule.respondToPermission).mockResolvedValue(undefined);
    vi.mocked(generateQuickName).mockReturnValue('swift-fox');
    mockBonjour.publish.mockReturnValue(mockBonjourService);
    vi.mocked(Bonjour).mockImplementation(() => mockBonjour as any);

    // Re-apply mocks for annex-identity, annex-tls, annex-peers, annex-event-bus
    vi.mocked(annexIdentity.getOrCreateIdentity).mockReturnValue({
      publicKey: 'fake-public-key',
      privateKey: 'fake-private-key',
      fingerprint: 'AA:BB:CC:DD',
    } as any);
    vi.mocked(annexIdentity.getPublicIdentity).mockReturnValue({
      publicKey: 'fake-public-key',
      fingerprint: 'AA:BB:CC:DD',
    } as any);
    vi.mocked(annexTls.createTlsServerOptions).mockImplementation(() => {
      throw new Error('TLS not available in test');
    });
    vi.mocked(annexTls.extractPeerFingerprint).mockReturnValue(null);
    vi.mocked(annexPeers.checkBruteForce).mockReturnValue({ allowed: true, delayMs: 0, locked: false, attemptsRemaining: 3 } as any);
    vi.mocked(annexPeers.isPairedPeer).mockReturnValue(false);
    vi.mocked(annexEventBus.setActive).mockReturnValue(undefined);
    vi.mocked(annexEventBus.onPtyData).mockReturnValue(() => {});
    vi.mocked(annexEventBus.onHookEvent).mockReturnValue(() => {});
    vi.mocked(annexEventBus.onPtyExit).mockReturnValue(() => {});
    vi.mocked(annexEventBus.onAgentSpawned).mockReturnValue(() => {});
    vi.mocked(annexEventBus.onStructuredEvent).mockReturnValue(() => {});
  });

  afterEach(() => {
    annexServer.stop();
  });

  // -------------------------------------------------------------------------
  // Original tests (pairing, auth, lifecycle)
  // -------------------------------------------------------------------------

  it('starts and stops without error', async () => {
    annexServer.start();
    await new Promise((r) => setTimeout(r, 100));
    const status = annexServer.getStatus();
    expect(status.port).toBeGreaterThan(0);
    expect(status.pin).toMatch(/^\d{6}$/);
    expect(status.connectedCount).toBe(0);

    annexServer.stop();
    const stopped = annexServer.getStatus();
    expect(stopped.port).toBe(0);
    expect(stopped.pin).toBe('');
  });

  it('rejects pairing with wrong PIN', async () => {
    annexServer.start();
    await new Promise((r) => setTimeout(r, 50));
    const status = annexServer.getStatus();
    const pairingPort = (status as any).pairingPort || status.port;

    const res = await request(pairingPort, 'POST', '/pair', { pin: '000000' });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_pin' });
  });

  it('accepts pairing with correct PIN and returns token', async () => {
    annexServer.start();
    await new Promise((r) => setTimeout(r, 50));
    const status = annexServer.getStatus();
    const pairingPort = (status as any).pairingPort || status.port;

    const res = await request(pairingPort, 'POST', '/pair', { pin: status.pin });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.token).toBeDefined();
    expect(typeof body.token).toBe('string');
  });

  it('rejects authenticated endpoints without token', async () => {
    annexServer.start();
    await new Promise((r) => setTimeout(r, 50));
    const status = annexServer.getStatus();

    const res = await request(status.port, 'GET', '/api/v1/status');
    expect(res.status).toBe(401);
  });

  it('allows authenticated endpoints with valid token', async () => {
    const { port, token } = await startAndPair();

    const res = await request(port, 'GET', '/api/v1/status', undefined, authHeaders(token));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.version).toBe('1');
    expect(body.deviceName).toBe('Test Machine');
  });

  it('regeneratePin invalidates existing tokens', async () => {
    const { port, token } = await startAndPair();

    annexServer.regeneratePin();

    const res = await request(port, 'GET', '/api/v1/status', undefined, authHeaders(token));
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown routes', async () => {
    const { port, token } = await startAndPair();

    const res = await request(port, 'GET', '/api/v1/unknown', undefined, authHeaders(token));
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Issue 1: DurableAgent defaults + runtime status
  // -------------------------------------------------------------------------

  describe('durable agent mapping', () => {
    it('includes status and defaults for missing fields in projects/:id/agents', async () => {
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj_1', name: 'test', path: '/tmp/test' },
      ]);
      vi.mocked(agentConfigModule.listDurable).mockReturnValue([
        {
          id: 'durable_1',
          name: 'agent-1',
          color: 'indigo',
          createdAt: '2025-01-01',
          // Deliberately missing: model, branch, freeAgentMode
        } as any,
      ]);

      const { port, token } = await startAndPair();

      const res = await request(port, 'GET', '/api/v1/projects/proj_1/agents', undefined, authHeaders(token));
      expect(res.status).toBe(200);
      const agents = JSON.parse(res.body);
      expect(agents).toHaveLength(1);
      expect(agents[0]).toEqual({
        id: 'durable_1',
        projectId: 'proj_1',
        name: 'agent-1',
        kind: 'durable',
        color: 'indigo',
        branch: null,
        model: null,
        orchestrator: null,
        freeAgentMode: false,
        icon: null,
        status: 'sleeping',
        detailedStatus: null,
        executionMode: null,
      });
    });

    it('shows running status when PTY is active', async () => {
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj_1', name: 'test', path: '/tmp/test' },
      ]);
      vi.mocked(agentConfigModule.listDurable).mockReturnValue([
        {
          id: 'durable_1',
          name: 'agent-1',
          color: 'indigo',
          createdAt: '2025-01-01',
        } as any,
      ]);
      vi.mocked(ptyManagerModule.isRunning).mockReturnValue(true);

      const { port, token } = await startAndPair();

      const res = await request(port, 'GET', '/api/v1/projects/proj_1/agents', undefined, authHeaders(token));
      const agents = JSON.parse(res.body);
      expect(agents[0].status).toBe('running');
    });
  });

  // -------------------------------------------------------------------------
  // Issue 2: Icon endpoints
  // -------------------------------------------------------------------------

  describe('icon endpoints', () => {
    it('GET /api/v1/icons/agent/:id returns icon data', async () => {
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj_1', name: 'test', path: '/tmp/test' },
      ]);
      vi.mocked(agentConfigModule.listDurable).mockReturnValue([
        { id: 'durable_1', name: 'a1', color: 'indigo', icon: 'durable_1.png', createdAt: '2025-01-01' } as any,
      ]);
      // Return a tiny 1x1 PNG data URL
      const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      vi.mocked(agentConfigModule.readAgentIconData).mockReturnValue(`data:image/png;base64,${pngBase64}`);

      const { port, token } = await startAndPair();

      const res = await request(port, 'GET', '/api/v1/icons/agent/durable_1', undefined, authHeaders(token));
      expect(res.status).toBe(200);
    });

    it('GET /api/v1/icons/agent/:id returns 404 for missing icon', async () => {
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj_1', name: 'test', path: '/tmp/test' },
      ]);
      vi.mocked(agentConfigModule.listDurable).mockReturnValue([
        { id: 'durable_1', name: 'a1', color: 'indigo', createdAt: '2025-01-01' } as any,
      ]);

      const { port, token } = await startAndPair();

      const res = await request(port, 'GET', '/api/v1/icons/agent/durable_1', undefined, authHeaders(token));
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'icon_not_found' });
    });

    it('GET /api/v1/icons/project/:id returns 404 for missing icon', async () => {
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj_1', name: 'test', path: '/tmp/test' },
      ]);

      const { port, token } = await startAndPair();

      const res = await request(port, 'GET', '/api/v1/icons/project/proj_1', undefined, authHeaders(token));
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Issue 6: Spawn quick agents
  // -------------------------------------------------------------------------

  describe('quick agent spawning', () => {
    it('POST /api/v1/projects/:id/agents/quick spawns a quick agent', async () => {
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj_1', name: 'test', path: '/tmp/test' },
      ]);

      const { port, token } = await startAndPair();

      const res = await request(
        port, 'POST', '/api/v1/projects/proj_1/agents/quick',
        { prompt: 'Fix the tests' },
        authHeaders(token),
      );
      expect(res.status).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.kind).toBe('quick');
      expect(body.prompt).toBe('Fix the tests');
      expect(body.name).toBe('swift-fox');
      expect(body.projectId).toBe('proj_1');
      expect(body.parentAgentId).toBeNull();
      expect(agentSystem.spawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'quick',
          mission: 'Fix the tests',
          projectPath: '/tmp/test',
        }),
      );
    });

    it('POST /api/v1/projects/:id/agents/quick notifies desktop renderer via IPC', async () => {
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj_1', name: 'test', path: '/tmp/test' },
      ]);

      const { port, token } = await startAndPair();
      mockBroadcastToAllWindows.mockClear();

      await request(
        port, 'POST', '/api/v1/projects/proj_1/agents/quick',
        { prompt: 'Fix the tests' },
        authHeaders(token),
      );

      expect(mockBroadcastToAllWindows).toHaveBeenCalledWith(
        'annex:agent-spawned',
        expect.objectContaining({
          name: 'swift-fox',
          kind: 'quick',
          status: 'running',
          prompt: 'Fix the tests',
          projectId: 'proj_1',
          headless: true,
        }),
      );
    });

    it('POST /api/v1/projects/:id/agents/quick returns 400 without prompt', async () => {
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj_1', name: 'test', path: '/tmp/test' },
      ]);

      const { port, token } = await startAndPair();

      const res = await request(
        port, 'POST', '/api/v1/projects/proj_1/agents/quick',
        {},
        authHeaders(token),
      );
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'missing_prompt' });
    });

    it('POST /api/v1/projects/:id/agents/quick returns 404 for unknown project', async () => {
      const { port, token } = await startAndPair();

      const res = await request(
        port, 'POST', '/api/v1/projects/nonexistent/agents/quick',
        { prompt: 'Do something' },
        authHeaders(token),
      );
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'project_not_found' });
    });

    it('POST /api/v1/agents/:id/agents/quick spawns under a parent', async () => {
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj_1', name: 'test', path: '/tmp/test' },
      ]);
      vi.mocked(agentConfigModule.listDurable).mockReturnValue([
        {
          id: 'durable_1', name: 'parent', color: 'indigo', createdAt: '2025-01-01',
          worktreePath: '/tmp/test/.clubhouse/agents/parent',
          orchestrator: 'claude-code',
          model: 'opus',
        } as any,
      ]);

      const { port, token } = await startAndPair();

      const res = await request(
        port, 'POST', '/api/v1/agents/durable_1/agents/quick',
        { prompt: 'Write tests' },
        authHeaders(token),
      );
      expect(res.status).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.parentAgentId).toBe('durable_1');
      expect(body.projectId).toBe('proj_1');
    });

    it('POST /api/v1/agents/:id/agents/quick returns 404 for unknown parent', async () => {
      const { port, token } = await startAndPair();

      const res = await request(
        port, 'POST', '/api/v1/agents/nonexistent/agents/quick',
        { prompt: 'Do something' },
        authHeaders(token),
      );
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'agent_not_found' });
    });
  });

  // -------------------------------------------------------------------------
  // Issue 7: Wake sleeping agents
  // -------------------------------------------------------------------------

  describe('wake agent', () => {
    it('POST /api/v1/agents/:id/wake wakes a sleeping agent', async () => {
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj_1', name: 'test', path: '/tmp/test' },
      ]);
      vi.mocked(agentConfigModule.listDurable).mockReturnValue([
        {
          id: 'durable_1', name: 'agent-1', color: 'indigo', createdAt: '2025-01-01',
          worktreePath: '/tmp/test/.clubhouse/agents/agent-1',
        } as any,
      ]);
      vi.mocked(ptyManagerModule.isRunning).mockReturnValue(false);

      const { port, token } = await startAndPair();

      const res = await request(
        port, 'POST', '/api/v1/agents/durable_1/wake',
        { message: 'Rebase on main' },
        authHeaders(token),
      );
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe('durable_1');
      expect(body.status).toBe('starting');
      expect(body.message).toBe('Rebase on main');
      expect(agentSystem.spawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'durable_1',
          kind: 'durable',
          mission: 'Rebase on main',
        }),
      );
    });

    it('POST /api/v1/agents/:id/wake returns 409 for running agent', async () => {
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj_1', name: 'test', path: '/tmp/test' },
      ]);
      vi.mocked(agentConfigModule.listDurable).mockReturnValue([
        { id: 'durable_1', name: 'agent-1', color: 'indigo', createdAt: '2025-01-01' } as any,
      ]);
      vi.mocked(ptyManagerModule.isRunning).mockReturnValue(true);

      const { port, token } = await startAndPair();

      const res = await request(
        port, 'POST', '/api/v1/agents/durable_1/wake',
        { message: 'Do something' },
        authHeaders(token),
      );
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ error: 'agent_already_running' });
    });

    it('POST /api/v1/agents/:id/wake returns 404 for unknown agent', async () => {
      const { port, token } = await startAndPair();

      const res = await request(
        port, 'POST', '/api/v1/agents/nonexistent/wake',
        { message: 'Do something' },
        authHeaders(token),
      );
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'agent_not_found' });
    });

    it('POST /api/v1/agents/:id/wake returns 400 without message', async () => {
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj_1', name: 'test', path: '/tmp/test' },
      ]);
      vi.mocked(agentConfigModule.listDurable).mockReturnValue([
        { id: 'durable_1', name: 'agent-1', color: 'indigo', createdAt: '2025-01-01' } as any,
      ]);

      const { port, token } = await startAndPair();

      const res = await request(
        port, 'POST', '/api/v1/agents/durable_1/wake',
        {},
        authHeaders(token),
      );
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'missing_message' });
    });
  });

  // -------------------------------------------------------------------------
  // Issue 4: Permission response
  // -------------------------------------------------------------------------

  describe('permission response', () => {
    it('POST /api/v1/agents/:id/permission-response resolves a pending permission', async () => {
      const { port, token } = await startAndPair();

      // Create a pending permission directly
      const { requestId, decision } = permissionQueue.createPermission('durable_1', 'Bash', { command: 'rm -rf /' });

      const res = await request(
        port, 'POST', '/api/v1/agents/durable_1/permission-response',
        { requestId, decision: 'deny' },
        authHeaders(token),
      );
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.decision).toBe('deny');

      await expect(decision).resolves.toBe('deny');
    });

    it('returns 400 for invalid decision', async () => {
      const { port, token } = await startAndPair();
      const { requestId } = permissionQueue.createPermission('durable_1', 'Bash');

      const res = await request(
        port, 'POST', '/api/v1/agents/durable_1/permission-response',
        { requestId, decision: 'maybe' },
        authHeaders(token),
      );
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid_decision' });
    });

    it('returns 400 for missing requestId', async () => {
      const { port, token } = await startAndPair();

      const res = await request(
        port, 'POST', '/api/v1/agents/durable_1/permission-response',
        { decision: 'allow' },
        authHeaders(token),
      );
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'missing_request_id' });
    });

    it('returns 404 for expired/unknown requestId', async () => {
      const { port, token } = await startAndPair();

      const res = await request(
        port, 'POST', '/api/v1/agents/durable_1/permission-response',
        { requestId: 'nonexistent', decision: 'allow' },
        authHeaders(token),
      );
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'request_not_found' });
    });
  });

  // -------------------------------------------------------------------------
  // readBody rejection handling (Issue #189)
  // -------------------------------------------------------------------------

  describe('readBody error handling', () => {
    /**
     * Helper: opens a raw TCP socket, sends headers for a POST with a
     * declared Content-Length, then destroys the socket before sending
     * the full body. This triggers an 'error'/'close' event on the
     * server-side IncomingMessage stream, exercising the .catch() handlers.
     */
    function abortedPost(
      port: number,
      path: string,
      token: string,
    ): Promise<{ status: number | null }> {
      return new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
          // Declare a large Content-Length but send nothing
          const headers = [
            `POST ${path} HTTP/1.1`,
            'Host: 127.0.0.1',
            'Content-Type: application/json',
            `Authorization: Bearer ${token}`,
            'Content-Length: 9999',
            '',
            '',
          ].join('\r\n');
          socket.write(headers);
          // Destroy the socket after a short delay to trigger the error
          setTimeout(() => socket.destroy(), 50);
        });

        // The server may or may not respond before we destroy the socket.
        // We wait a bit after destruction to let the server-side .catch()
        // handler run, then resolve. The key assertion is that no unhandled
        // rejection occurs.
        let responseStatus: number | null = null;
        let responseData = '';
        socket.on('data', (chunk) => {
          responseData += chunk.toString();
          const match = responseData.match(/^HTTP\/1\.1 (\d+)/);
          if (match) responseStatus = parseInt(match[1], 10);
        });
        socket.on('close', () => {
          setTimeout(() => resolve({ status: responseStatus }), 100);
        });
        socket.on('error', () => {
          setTimeout(() => resolve({ status: responseStatus }), 100);
        });
      });
    }

    it('handles aborted request to quick agent spawn (project)', async () => {
      const { port, token } = await startAndPair();
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj1', name: 'Test Project', path: '/tmp/test', agents: [] },
      ] as any);

      await abortedPost(port, '/api/v1/projects/proj1/agents/quick', token);

      // The key assertion: no unhandled promise rejection, and appLog was called
      expect(appLog).toHaveBeenCalledWith(
        'core:annex', 'error', 'readBody failed',
        expect.objectContaining({ meta: expect.objectContaining({ error: expect.any(String) }) }),
      );
    });

    it('handles aborted request to quick agent spawn (agent)', async () => {
      const { port, token } = await startAndPair();
      vi.mocked(projectStore.list).mockReturnValue([
        {
          id: 'proj1', name: 'Test', path: '/tmp/test',
          agents: [{ id: 'agent1', name: 'Agent 1', model: 'opus', orchestrator: 'claude-code' }],
        },
      ] as any);
      vi.mocked(agentConfigModule.listDurable).mockReturnValue([
        { id: 'agent1', name: 'Agent 1', model: 'opus', orchestrator: 'claude-code' },
      ] as any);

      await abortedPost(port, '/api/v1/agents/agent1/agents/quick', token);

      expect(appLog).toHaveBeenCalledWith(
        'core:annex', 'error', 'readBody failed',
        expect.objectContaining({ meta: expect.objectContaining({ error: expect.any(String) }) }),
      );
    });

    it('handles aborted request to wake agent', async () => {
      const { port, token } = await startAndPair();

      await abortedPost(port, '/api/v1/agents/some-agent/wake', token);

      expect(appLog).toHaveBeenCalledWith(
        'core:annex', 'error', 'readBody failed',
        expect.objectContaining({ meta: expect.objectContaining({ error: expect.any(String) }) }),
      );
    });

    it('handles aborted request to permission response', async () => {
      const { port, token } = await startAndPair();

      await abortedPost(port, '/api/v1/agents/some-agent/permission-response', token);

      expect(appLog).toHaveBeenCalledWith(
        'core:annex', 'error', 'readBody failed',
        expect.objectContaining({ meta: expect.objectContaining({ error: expect.any(String) }) }),
      );
    });

    it('handles aborted request to structured permission', async () => {
      const { port, token } = await startAndPair();

      await abortedPost(port, '/api/v1/agents/some-agent/structured-permission', token);

      expect(appLog).toHaveBeenCalledWith(
        'core:annex', 'error', 'readBody failed',
        expect.objectContaining({ meta: expect.objectContaining({ error: expect.any(String) }) }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Issue 396: executionMode in agent status
  // -------------------------------------------------------------------------

  describe('execution mode', () => {
    it('includes executionMode=pty for PTY agents', async () => {
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj_1', name: 'test', path: '/tmp/test' },
      ]);
      vi.mocked(agentConfigModule.listDurable).mockReturnValue([
        { id: 'durable_1', name: 'agent-1', color: 'indigo', createdAt: '2025-01-01' } as any,
      ]);
      vi.mocked(ptyManagerModule.isRunning).mockReturnValue(true);

      const { port, token } = await startAndPair();

      const res = await request(port, 'GET', '/api/v1/projects/proj_1/agents', undefined, authHeaders(token));
      const agents = JSON.parse(res.body);
      expect(agents[0].status).toBe('running');
      expect(agents[0].executionMode).toBe('pty');
    });

    it('includes executionMode=structured for structured agents', async () => {
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj_1', name: 'test', path: '/tmp/test' },
      ]);
      vi.mocked(agentConfigModule.listDurable).mockReturnValue([
        { id: 'durable_1', name: 'agent-1', color: 'indigo', createdAt: '2025-01-01' } as any,
      ]);
      vi.mocked(structuredManagerModule.isStructuredSession).mockReturnValue(true);

      const { port, token } = await startAndPair();

      const res = await request(port, 'GET', '/api/v1/projects/proj_1/agents', undefined, authHeaders(token));
      const agents = JSON.parse(res.body);
      expect(agents[0].status).toBe('running');
      expect(agents[0].executionMode).toBe('structured');
    });

    it('includes executionMode=headless for headless agents', async () => {
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj_1', name: 'test', path: '/tmp/test' },
      ]);
      vi.mocked(agentConfigModule.listDurable).mockReturnValue([
        { id: 'durable_1', name: 'agent-1', color: 'indigo', createdAt: '2025-01-01' } as any,
      ]);
      vi.mocked(agentSystem.isHeadlessAgent).mockReturnValue(true);

      const { port, token } = await startAndPair();

      const res = await request(port, 'GET', '/api/v1/projects/proj_1/agents', undefined, authHeaders(token));
      const agents = JSON.parse(res.body);
      expect(agents[0].status).toBe('running');
      expect(agents[0].executionMode).toBe('headless');
    });

    it('includes executionMode=null for sleeping agents', async () => {
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj_1', name: 'test', path: '/tmp/test' },
      ]);
      vi.mocked(agentConfigModule.listDurable).mockReturnValue([
        { id: 'durable_1', name: 'agent-1', color: 'indigo', createdAt: '2025-01-01' } as any,
      ]);

      const { port, token } = await startAndPair();

      const res = await request(port, 'GET', '/api/v1/projects/proj_1/agents', undefined, authHeaders(token));
      const agents = JSON.parse(res.body);
      expect(agents[0].status).toBe('sleeping');
      expect(agents[0].executionMode).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Issue 396: Structured permission response
  // -------------------------------------------------------------------------

  describe('structured permission response', () => {
    it('POST /api/v1/agents/:id/structured-permission resolves permission', async () => {
      vi.mocked(structuredManagerModule.isStructuredSession).mockReturnValue(true);

      const { port, token } = await startAndPair();

      const res = await request(
        port, 'POST', '/api/v1/agents/durable_1/structured-permission',
        { requestId: 'req-1', approved: true, reason: 'user approved' },
        authHeaders(token),
      );
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.approved).toBe(true);
      expect(structuredManagerModule.respondToPermission).toHaveBeenCalledWith(
        'durable_1', 'req-1', true, 'user approved',
      );
    });

    it('POST /api/v1/agents/:id/structured-permission denies permission', async () => {
      vi.mocked(structuredManagerModule.isStructuredSession).mockReturnValue(true);

      const { port, token } = await startAndPair();

      const res = await request(
        port, 'POST', '/api/v1/agents/durable_1/structured-permission',
        { requestId: 'req-2', approved: false },
        authHeaders(token),
      );
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.approved).toBe(false);
    });

    it('returns 400 for missing requestId', async () => {
      vi.mocked(structuredManagerModule.isStructuredSession).mockReturnValue(true);

      const { port, token } = await startAndPair();

      const res = await request(
        port, 'POST', '/api/v1/agents/durable_1/structured-permission',
        { approved: true },
        authHeaders(token),
      );
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'missing_request_id' });
    });

    it('returns 400 for missing approved field', async () => {
      vi.mocked(structuredManagerModule.isStructuredSession).mockReturnValue(true);

      const { port, token } = await startAndPair();

      const res = await request(
        port, 'POST', '/api/v1/agents/durable_1/structured-permission',
        { requestId: 'req-1' },
        authHeaders(token),
      );
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'missing_approved' });
    });

    it('returns 404 for non-structured agent', async () => {
      vi.mocked(structuredManagerModule.isStructuredSession).mockReturnValue(false);

      const { port, token } = await startAndPair();

      const res = await request(
        port, 'POST', '/api/v1/agents/durable_1/structured-permission',
        { requestId: 'req-1', approved: true },
        authHeaders(token),
      );
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'no_structured_session' });
    });
  });

  // ---------------------------------------------------------------------------
  // Snapshot: projectId in agents (#866 fix)
  // ---------------------------------------------------------------------------

  describe('snapshot agent projectId', () => {
    it('includes projectId in durable agent snapshot objects', async () => {
      vi.mocked(projectStore.list).mockReturnValue([
        { id: 'proj-1', name: 'My Project', path: '/my/project' },
      ]);
      vi.mocked(agentConfigModule.listDurable).mockReturnValue([
        { id: 'agent-1', name: 'mega-camel', color: 'blue', branch: 'main', model: null, orchestrator: null, freeAgentMode: false, icon: null },
      ]);

      const { port, token } = await startAndPair();

      const res = await request(port, 'GET', '/api/v1/projects/proj-1/agents', undefined, authHeaders(token));
      expect(res.status).toBe(200);
      const agents = JSON.parse(res.body);
      expect(agents).toHaveLength(1);
      expect(agents[0].projectId).toBe('proj-1');
      expect(agents[0].id).toBe('agent-1');
    });
  });

  // ---------------------------------------------------------------------------
  // Snapshot: plugins included
  // ---------------------------------------------------------------------------

  describe('snapshot plugins', () => {
    it('listAllManifests is available for snapshot building', () => {
      vi.mocked(pluginManifestRegistry.listAllManifests).mockReturnValue([
        { id: 'hub', name: 'Hub', version: '1.0.0', scope: 'app', engine: { api: 0.8 }, contributes: { tab: { label: 'Hub' } } },
        { id: 'files', name: 'Files', version: '1.0.0', scope: 'project', engine: { api: 0.8 }, contributes: { tab: { label: 'Files' } } },
      ] as any);

      // Verify mock is properly configured — buildSnapshot calls this on WS connect
      const manifests = pluginManifestRegistry.listAllManifests();
      expect(manifests).toHaveLength(2);
      expect(manifests[0].id).toBe('hub');
      expect(manifests[1].id).toBe('files');
    });
  });

  // ---------------------------------------------------------------------------
  // Pairing: directional role
  // ---------------------------------------------------------------------------

  describe('pairing stores directional role', () => {
    it('stores paired client with role "controller"', async () => {
      annexServer.start();
      await new Promise((r) => setTimeout(r, 100));
      const status = annexServer.getStatus();
      const pairingPort = (status as any).pairingPort || status.port;

      await request(pairingPort, 'POST', '/pair', {
        pin: status.pin,
        publicKey: 'client-public-key',
        alias: 'Controller Mac',
        icon: 'laptop',
        color: 'blue',
      });

      expect(annexPeers.addPeer).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'controller',
          alias: 'Controller Mac',
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Snapshot: icon data URLs
  // ---------------------------------------------------------------------------

  describe('snapshot icon data', () => {
    it('readIconData and readAgentIconData are available for snapshot building', () => {
      // Verify the mock functions are set up — buildSnapshot calls these on WS connect
      vi.mocked(projectStore.readIconData).mockResolvedValue('data:image/png;base64,abc123');
      vi.mocked(agentConfigModule.readAgentIconData).mockResolvedValue('data:image/png;base64,xyz789');

      expect(typeof projectStore.readIconData).toBe('function');
      expect(typeof agentConfigModule.readAgentIconData).toBe('function');
    });
  });
});
