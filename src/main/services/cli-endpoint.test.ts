import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  baseDir: '',
  listProjectAppearances: vi.fn(async () => [{ id: 'p1' }]),
  listAgentAppearances: vi.fn(async () => [{ id: 'a1' }]),
  updateProjectAppearance: vi.fn(async () => ({ id: 'p1' })),
  updateAgentAppearance: vi.fn(async () => ({ id: 'a1' })),
}));

vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./base-dir', () => ({ getBaseDirPath: () => mocks.baseDir }));
vi.mock('./appearance-service', () => {
  class AppearanceError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  }
  return {
    AppearanceError,
    listProjectAppearances: mocks.listProjectAppearances,
    listAgentAppearances: mocks.listAgentAppearances,
    updateProjectAppearance: mocks.updateProjectAppearance,
    updateAgentAppearance: mocks.updateAgentAppearance,
  };
});

import { AppearanceError } from './appearance-service';
import { CLI_TOKEN_HEADER, handleCliRequest, publishCliEndpoint, unpublishCliEndpoint } from './cli-endpoint';

let server: http.Server;
let port: number;
let token: string;

interface Reply { status: number; body: any }

function call(method: string, route: string, options: { body?: unknown; rawBody?: string; headers?: Record<string, string>; noToken?: boolean } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const req = http.request({
      host: '127.0.0.1', port, method, path: route,
      headers: { ...(!options.noToken && { [CLI_TOKEN_HEADER]: token }), ...options.headers },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function readEndpointFile(): { port: number; token: string } {
  return JSON.parse(fs.readFileSync(path.join(mocks.baseDir, 'cli-endpoint.json'), 'utf8'));
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-endpoint-'));
  server = http.createServer((req, res) => { void handleCliRequest(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  await publishCliEndpoint(port);
  token = readEndpointFile().token;
});

afterEach(async () => {
  unpublishCliEndpoint();
  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(mocks.baseDir, { recursive: true, force: true });
});

describe('endpoint file', () => {
  it('holds the port and a long random token', () => {
    const file = readEndpointFile();
    expect(file.port).toBe(port);
    expect(file.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it.skipIf(process.platform === 'win32')('is readable by this user only, and leaves no temp file', async () => {
    const file = path.join(mocks.baseDir, 'cli-endpoint.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(await fsp.readdir(mocks.baseDir)).toEqual(['cli-endpoint.json']);
  });

  it('rotates the token at each start, and the old one stops working', async () => {
    const old = token;
    await publishCliEndpoint(port);
    token = readEndpointFile().token;
    expect(token).not.toBe(old);
    expect((await call('GET', '/cli/v1/projects')).status).toBe(200);
    expect((await call('GET', '/cli/v1/projects', { noToken: true, headers: { [CLI_TOKEN_HEADER]: old } })).status).toBe(401);
  });

  it('goes away on shutdown, and nothing is answered after', async () => {
    unpublishCliEndpoint();
    expect(fs.existsSync(path.join(mocks.baseDir, 'cli-endpoint.json'))).toBe(false);
    expect((await call('GET', '/cli/v1/projects')).status).toBe(403);
  });
});

describe('auth', () => {
  it('refuses a missing or wrong token before doing anything', async () => {
    expect((await call('GET', '/cli/v1/projects', { noToken: true })).status).toBe(401);
    expect((await call('GET', '/cli/v1/projects', { noToken: true, headers: { [CLI_TOKEN_HEADER]: 'x'.repeat(64) } })).status).toBe(401);
    expect((await call('GET', '/cli/nope', { noToken: true })).status).toBe(401);
    const update = await call('POST', '/cli/v1/projects/update', { noToken: true, body: { project: 'p1', color: 'rose' } });
    expect(update.status).toBe(401);
    expect(mocks.listProjectAppearances).not.toHaveBeenCalled();
    expect(mocks.updateProjectAppearance).not.toHaveBeenCalled();
  });

  it('refuses an agent nonce-style header: only this token counts', async () => {
    const reply = await call('GET', '/cli/v1/projects', { noToken: true, headers: { 'x-clubhouse-nonce': token } });
    expect(reply.status).toBe(401);
  });

  it('refuses a browser page even with the token', async () => {
    const reply = await call('POST', '/cli/v1/projects/update', { body: { project: 'p1', color: 'rose' }, headers: { Origin: 'https://evil.example' } });
    expect(reply.status).toBe(403);
    expect(mocks.updateProjectAppearance).not.toHaveBeenCalled();
  });

  it('refuses a name that merely resolves to loopback', async () => {
    const reply = await call('GET', '/cli/v1/projects', { headers: { Host: `evil.example:${port}` } });
    expect(reply.status).toBe(403);
    expect(mocks.listProjectAppearances).not.toHaveBeenCalled();
  });

  it('accepts localhost', async () => {
    expect((await call('GET', '/cli/v1/projects', { headers: { Host: `localhost:${port}` } })).status).toBe(200);
  });
});

describe('routes', () => {
  it('lists projects and agents', async () => {
    expect((await call('GET', '/cli/v1/projects')).body).toEqual({ ok: true, projects: [{ id: 'p1' }] });
    expect((await call('GET', '/cli/v1/agents')).body).toEqual({ ok: true, agents: [{ id: 'a1' }] });
    expect(mocks.listAgentAppearances).toHaveBeenLastCalledWith(undefined);
    await call('GET', '/cli/v1/agents?project=My%20App');
    expect(mocks.listAgentAppearances).toHaveBeenLastCalledWith('My App');
  });

  it('updates with the all scope and no agent identity', async () => {
    const project = await call('POST', '/cli/v1/projects/update', { body: { project: 'p1', displayName: 'Shiny', color: '', emoji: '🚀', imagePath: '/i.png' } });
    expect(project.body).toEqual({ ok: true, project: { id: 'p1' } });
    expect(mocks.updateProjectAppearance).toHaveBeenCalledWith({ scope: 'all' }, 'p1', { displayName: 'Shiny', color: '', emoji: '🚀', imagePath: '/i.png' });
    const agent = await call('POST', '/cli/v1/agents/update', { body: { agentId: 'a1', color: 'teal' } });
    expect(agent.body).toEqual({ ok: true, agent: { id: 'a1' } });
    expect(mocks.updateAgentAppearance).toHaveBeenCalledWith({ scope: 'all' }, 'a1', { color: 'teal' });
  });

  it.each([
    ['/cli/v1/agents/update', { agentId: 'a1', name: 'renamed' }, 'name'],
    ['/cli/v1/agents/update', { agentId: 'a1', model: 'opus' }, 'model'],
    ['/cli/v1/projects/update', { project: 'p1', name: 'folder' }, 'name'],
    ['/cli/v1/projects/update', { project: 'p1', orchestrator: 'codex-cli' }, 'orchestrator'],
  ])('refuses %s with a setting it does not change', async (route, body, field) => {
    const reply = await call('POST', route, { body });
    expect(reply.status).toBe(400);
    expect(reply.body.error.code).toBe('invalid_request');
    expect(reply.body.error.message).toContain(`Can't change ${field}`);
    expect(mocks.updateAgentAppearance).not.toHaveBeenCalled();
    expect(mocks.updateProjectAppearance).not.toHaveBeenCalled();
  });

  it('refuses bad requests', async () => {
    expect((await call('POST', '/cli/v1/agents/update', { rawBody: '{not json' })).status).toBe(400);
    expect((await call('POST', '/cli/v1/agents/update', { body: ['a1'] })).status).toBe(400);
    expect((await call('POST', '/cli/v1/agents/update', { body: { agentId: 'a1', color: 7 } })).status).toBe(400);
    expect((await call('POST', '/cli/v1/agents/update', { rawBody: JSON.stringify({ agentId: 'x'.repeat(70000) }) })).status).toBe(400);
  });

  it('answers 404 for an unknown route or the wrong method', async () => {
    expect((await call('GET', '/cli/v1/nope')).status).toBe(404);
    expect((await call('POST', '/cli/v1/projects')).status).toBe(404);
    expect((await call('GET', '/cli/v1/projects/update')).status).toBe(404);
  });

  it.each([
    ['not_found', 404], ['dispatcher_locked', 409], ['agent_creating', 409], ['ambiguous_project', 409],
    ['invalid_color', 400], ['invalid_image', 400], ['no_changes', 400],
  ])('passes a %s refusal on as %i with its message', async (code, status) => {
    mocks.updateAgentAppearance.mockRejectedValueOnce(new AppearanceError(code as never, 'Because.'));
    const reply = await call('POST', '/cli/v1/agents/update', { body: { agentId: 'a1', color: 'teal' } });
    expect(reply.status).toBe(status);
    expect(reply.body).toEqual({ ok: false, error: { code, message: 'Because.' } });
  });

  it('answers 500 for anything unexpected', async () => {
    mocks.listProjectAppearances.mockRejectedValueOnce(new Error('disk full'));
    const reply = await call('GET', '/cli/v1/projects');
    expect(reply.status).toBe(500);
    expect(reply.body.error).toEqual({ code: 'internal', message: 'disk full' });
  });
});

describe('the real CLI against this endpoint', () => {
  const { EXIT, run } = createRequire(__filename)(path.join(__dirname, 'cli', 'clubhouse-cli.js'));

  async function runCli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    let out = '';
    let err = '';
    // The CLI looks for <home>/.clubhouse-dev with --dev, so the endpoint's base dir is that here.
    const home = path.dirname(mocks.baseDir);
    const devDir = path.join(home, '.clubhouse-dev');
    await fsp.rm(devDir, { recursive: true, force: true });
    await fsp.cp(mocks.baseDir, devDir, { recursive: true });
    try {
      const code = await run([...argv, '--dev'], {
        stdout: (text: string) => { out += text; }, stderr: (text: string) => { err += text; },
        env: {}, home, cwd: path.join(path.sep, 'work'),
      });
      return { code, out, err };
    } finally {
      await fsp.rm(devDir, { recursive: true, force: true });
    }
  }

  it('authenticates and lists', async () => {
    const { code, out } = await runCli(['projects', '--json']);
    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(out)).toEqual({ ok: true, projects: [{ id: 'p1' }] });
  });

  it('sends a change the endpoint accepts, with the image made absolute', async () => {
    const { code } = await runCli(['project', 'set', 'p1', '--display-name', 'Shiny', '--image', 'i.png']);
    expect(code).toBe(EXIT.ok);
    expect(mocks.updateProjectAppearance).toHaveBeenCalledWith({ scope: 'all' }, 'p1', {
      displayName: 'Shiny', imagePath: path.resolve(path.join(path.sep, 'work'), 'i.png'),
    });
  });

  it('turns a refusal into the refused exit code', async () => {
    mocks.updateAgentAppearance.mockRejectedValueOnce(new AppearanceError('dispatcher_locked', 'Locked.'));
    const { code, err } = await runCli(['agent', 'set', 'dispatcher', '--color', 'teal']);
    expect(code).toBe(EXIT.refused);
    expect(err).toContain('Locked.');
  });
});
