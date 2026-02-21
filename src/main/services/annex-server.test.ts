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
}));

// Mock agent-config
vi.mock('./agent-config', () => ({
  listDurable: vi.fn().mockReturnValue([]),
}));

// Mock pty-manager
vi.mock('./pty-manager', () => ({
  getBuffer: vi.fn().mockReturnValue(''),
}));

// Mock annex-settings
vi.mock('./annex-settings', () => ({
  getSettings: vi.fn().mockReturnValue({ enabled: false, deviceName: 'Test Machine' }),
  saveSettings: vi.fn(),
}));

import * as annexServer from './annex-server';
import * as annexSettings from './annex-settings';
import * as projectStore from './project-store';
import * as agentConfigModule from './agent-config';
import * as ptyManagerModule from './pty-manager';
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

describe('annex-server', () => {
  beforeEach(() => {
    // Re-apply mock return values after mockReset clears them
    vi.mocked(annexSettings.getSettings).mockReturnValue({ enabled: false, deviceName: 'Test Machine' });
    vi.mocked(projectStore.list).mockReturnValue([]);
    vi.mocked(agentConfigModule.listDurable).mockReturnValue([]);
    vi.mocked(ptyManagerModule.getBuffer).mockReturnValue('');
    mockBonjour.publish.mockReturnValue(mockBonjourService);
    vi.mocked(Bonjour).mockImplementation(() => mockBonjour as any);
  });

  afterEach(() => {
    annexServer.stop();
  });

  it('starts and stops without error', async () => {
    annexServer.start();
    // Wait for server to bind
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
    // Wait for server to be listening
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
    annexServer.start();
    await new Promise((r) => setTimeout(r, 50));
    const status = annexServer.getStatus();

    // Pair first
    const pairRes = await request(status.port, 'POST', '/pair', { pin: status.pin });
    const { token } = JSON.parse(pairRes.body);

    // Now request status
    const res = await request(status.port, 'GET', '/api/v1/status', undefined, {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.version).toBe('1');
    expect(body.deviceName).toBe('Test Machine');
  });

  it('regeneratePin invalidates existing tokens', async () => {
    annexServer.start();
    await new Promise((r) => setTimeout(r, 50));
    const status = annexServer.getStatus();

    // Pair
    const pairRes = await request(status.port, 'POST', '/pair', { pin: status.pin });
    const { token } = JSON.parse(pairRes.body);

    // Regenerate PIN
    annexServer.regeneratePin();

    // Old token should be invalid
    const res = await request(status.port, 'GET', '/api/v1/status', undefined, {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown routes', async () => {
    annexServer.start();
    await new Promise((r) => setTimeout(r, 50));
    const status = annexServer.getStatus();

    // Pair to get a token
    const pairRes = await request(status.port, 'POST', '/pair', { pin: status.pin });
    const { token } = JSON.parse(pairRes.body);

    const res = await request(status.port, 'GET', '/api/v1/unknown', undefined, {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(404);
  });
});
