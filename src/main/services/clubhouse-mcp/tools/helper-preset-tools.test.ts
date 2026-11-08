import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../mcp-call-gate', async (original) => ({ ...await original<typeof import('../mcp-call-gate')>(), mcpCallAccess: () => 'open' }));

const mocks = vi.hoisted(() => ({
  read: vi.fn(async () => ({ revision: 'r1', providers: { 'claude-code': { cells: [] } }, serverTime: 't', labels: {}, auto: {} })),
  update: vi.fn(async () => ({ revision: 'r2', providers: { 'claude-code': { cells: [{ difficulty: 'easy' }] } } })),
  /** Stands in for a person granting settings.app.write; off, the real grant check runs. */
  granted: false,
}));
vi.mock('../grant-check', async (original) => {
  const real = await original<typeof import('../grant-check')>();
  return { ...real, checkToolGrant: (...args: Parameters<typeof real.checkToolGrant>) => (mocks.granted ? { ok: true } : real.checkToolGrant(...args)) };
});

vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../helper-routing', () => {
  class HelperRoutingError extends Error {
    constructor(readonly code: string, message: string, readonly settings?: { revision: string; providers: unknown }) { super(message); }
  }
  return { HelperRoutingError, readHelperRouting: mocks.read, updateHelperPresets: mocks.update };
});
vi.mock('../../dispatcher/dispatcher-settings', async (original) => ({ ...await original<typeof import('../../dispatcher/dispatcher-settings')>(), isDispatcherEnabled: () => true }));

import { agentRegistry } from '../../agent-registry';
import { HelperRoutingError } from '../../helper-routing';
import { callTool, getScopedToolList, _resetForTesting } from '../tool-registry';
import { setDispatcherAgent, _resetDispatcherGateForTesting } from '../dispatcher-gate';
import { registerHelperPresetTools } from './helper-preset-tools';

const parse = (r: { content: Array<{ text?: string }> }) => JSON.parse(r.content[0].text ?? '{}');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.granted = false;
  _resetForTesting();
  _resetDispatcherGateForTesting();
  for (const id of [...agentRegistry.getAllRegistrations().keys()]) agentRegistry.untrack(id);
  for (const id of ['plain', 'dispatcher']) agentRegistry.register(id, { projectPath: '/p', orchestrator: 'claude-code', runtime: 'chat' });
  setDispatcherAgent('dispatcher', true);
  registerHelperPresetTools();
});

describe('helper presets over MCP (#2785)', () => {
  it('any agent reads them, with the revision to send back', async () => {
    const result = await callTool('plain', 'read_helper_presets', {});
    expect(result.isError).toBeFalsy();
    expect(parse(result)).toEqual({ revision: 'r1', providers: { 'claude-code': { cells: [] } } });
    expect(getScopedToolList('plain').map((t) => t.name)).toContain('read_helper_presets');
  });

  it('no agent can change them without the app settings permission, the Dispatcher included', async () => {
    for (const agent of ['plain', 'dispatcher']) {
      const result = await callTool(agent, 'set_helper_presets', { revision: 'r1', reset: {} });
      expect(result.isError).toBe(true);
      expect(getScopedToolList(agent).map((t) => t.name)).not.toContain('set_helper_presets');
    }
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe('set_helper_presets with the permission', () => {
  beforeEach(() => { mocks.granted = true; });
  const handler = (args: Record<string, unknown>) => callTool('dispatcher', 'set_helper_presets', args);

  it('writes through the shared service as the mcp surface', async () => {
    const cells = [{ provider: 'claude-code', difficulty: 'easy', model: 'haiku', effort: null }];
    const result = await handler({ revision: 'r1', cells });
    expect(mocks.update).toHaveBeenCalledWith({ revision: 'r1', cells }, { surface: 'mcp' });
    expect(parse(result)).toMatchObject({ ok: true, revision: 'r2' });
  });

  it('a stale revision changes nothing and returns the current values', async () => {
    mocks.update.mockRejectedValueOnce(new HelperRoutingError('helper_routing_stale', 'Changed since you read it.', { revision: 'r3', providers: {} } as never));
    const result = await handler({ revision: 'r1', reset: {} });
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ ok: false, code: 'helper_routing_stale', revision: 'r3' });
  });

  it('refuses a call with nothing to change, or no revision', async () => {
    expect(parse(await handler({ revision: 'r1' }))).toMatchObject({ code: 'invalid_helper_routing' });
    expect((await handler({ cells: [] })).content[0].text).toContain('Missing required argument: revision');
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
