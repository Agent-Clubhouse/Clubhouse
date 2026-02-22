import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';

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

// Mock annex-settings
vi.mock('./annex-settings', () => ({
  getSettings: vi.fn().mockReturnValue({ enabled: false, deviceName: 'Test Machine' }),
  saveSettings: vi.fn(),
}));

// Mock agent-system
vi.mock('./agent-system', () => ({
  getAvailableOrchestrators: vi.fn().mockReturnValue([]),
  spawnAgent: vi.fn().mockResolvedValue(undefined),
  isHeadlessAgent: vi.fn().mockReturnValue(false),
}));

// Mock name-generator
vi.mock('../../shared/name-generator', () => ({
  generateQuickName: vi.fn().mockReturnValue('swift-fox'),
}));

import * as annexServer from './annex-server';
import * as annexSettings from './annex-settings';
import * as projectStore from './project-store';
import * as agentConfigModule from './agent-config';
import * as ptyManagerModule from './pty-manager';
import * as agentSystem from './agent-system';
import * as eventReplay from './annex-event-replay';
import * as permissionQueue from './annex-permission-queue';
import { generateQuickName } from '../../shared/name-generator';
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
  const pairRes = await request(status.port, 'POST', '/pair', { pin: status.pin });
  const { token } = JSON.parse(pairRes.body);
  return { port: status.port, token, pin: status.pin };
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe('annex-server', () => {
  beforeEach(() => {
    // Re-apply mock return values after mockReset clears them
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enabled: false, deviceName: 'Test Machine' });
    vi.mocked(projectStore.list).mockReturnValue([]);
    vi.mocked(agentConfigModule.listDurable).mockReturnValue([]);
    vi.mocked(ptyManagerModule.getBuffer).mockReturnValue('');
    vi.mocked(ptyManagerModule.isRunning).mockReturnValue(false);
    vi.mocked(agentSystem.isHeadlessAgent).mockReturnValue(false);
    vi.mocked(agentSystem.spawnAgent).mockResolvedValue(undefined);
    vi.mocked(agentSystem.getAvailableOrchestrators).mockReturnValue([]);
    vi.mocked(generateQuickName).mockReturnValue('swift-fox');
    mockBonjour.publish.mockReturnValue(mockBonjourService);
    vi.mocked(Bonjour).mockImplementation(() => mockBonjour as any);
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

    const res = await request(status.port, 'POST', '/pair', { pin: '000000' });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_pin' });
  });

  it('accepts pairing with correct PIN and returns token', async () => {
    annexServer.start();
    await new Promise((r) => setTimeout(r, 50));
    const status = annexServer.getStatus();

    const res = await request(status.port, 'POST', '/pair', { pin: status.pin });
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
});
