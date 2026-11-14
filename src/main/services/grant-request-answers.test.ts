import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setAgentGrant: vi.fn(async () => ({ rows: [] })),
  deliver: vi.fn(async () => 'delivered' as const),
  config: { name: 'Ada' } as { name: string } | null,
  grants: [] as Array<{ action: string; target: unknown; mode: string }>,
}));
vi.mock('./agent-grants-service', () => ({ setAgentGrant: mocks.setAgentGrant }));
vi.mock('./clubhouse-mcp/tools/helper-delivery', () => ({ deliverHelperUpdate: mocks.deliver }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./agent-config', () => ({ getDurableConfig: vi.fn(async () => mocks.config) }));
vi.mock('./clubhouse-mcp/grant-check', () => ({ callerGrants: () => mocks.grants }));
vi.mock('./clubhouse-mcp/tool-registry', () => ({ registerGlobalTool: vi.fn() }));

import { agentRegistry } from './agent-registry';
import { registerGlobalTool } from './clubhouse-mcp/tool-registry';
import { registerGrantRequestTools } from './clubhouse-mcp/tools/grant-request-tools';
import { answerGrantRequest } from './grant-request-answers';
import { listGrantRequests, recordGrantRequest, _resetGrantRequestsForTesting } from './grant-requests';

type Handler = (agentId: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
let requestGrant: Handler;
const text = (r: { content: Array<{ text?: string }> }) => r.content[0].text ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  _resetGrantRequestsForTesting();
  mocks.config = { name: 'Ada' };
  mocks.grants = [];
  for (const id of [...agentRegistry.getAllRegistrations().keys()]) agentRegistry.untrack(id);
  agentRegistry.register('a1', { projectPath: '/p', orchestrator: 'claude-code', runtime: 'chat' });
  registerGrantRequestTools();
  requestGrant = vi.mocked(registerGlobalTool).mock.calls[0][2] as unknown as Handler;
});

describe('request_grant (#2970)', () => {
  it('records a request with the agent\'s reason, and changes nothing', async () => {
    const r = await requestGrant('a1', { action: 'settings.app.write', target: 'app', reason: 'To set the cheap model for easy tasks.' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('Nothing has changed yet');
    expect(listGrantRequests()).toEqual([expect.objectContaining({
      kind: 'grant', agentId: 'a1', agentName: 'Ada', actions: ['settings.app.write'], target: { kind: 'app' }, reason: 'To set the cheap model for easy tasks.',
    })]);
    expect(mocks.setAgentGrant).not.toHaveBeenCalled();
  });

  it('refuses a missing reason, an unknown action or target, and a fixed permission', async () => {
    expect((await requestGrant('a1', { action: 'settings.app.write', target: 'app', reason: ' ' })).isError).toBe(true);
    expect((await requestGrant('a1', { action: 'root.everything', target: 'app', reason: 'x' })).isError).toBe(true);
    expect((await requestGrant('a1', { action: 'settings.app.write', target: 'universe', reason: 'x' })).isError).toBe(true);
    expect((await requestGrant('a1', { action: 'action.run', target: 'action', reason: 'x' })).isError).toBe(true);
    expect(listGrantRequests()).toEqual([]);
  });

  it('says so when the agent already has it', async () => {
    mocks.grants = [{ action: 'settings.app.write', target: { kind: 'app' }, mode: 'allow' }];
    const r = await requestGrant('a1', { action: 'settings.app.write', target: 'app', reason: 'x' });
    expect(text(r)).toContain('already have');
    expect(listGrantRequests()).toEqual([]);
  });

  it('refuses starting and removing helpers, which follow the approval setting', async () => {
    for (const [action, target] of [['agent.create', 'own_project'], ['agent.dispose', 'my_helpers']]) {
      const r = await requestGrant('a1', { action, target, reason: 'x' });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('approval setting');
    }
    expect(listGrantRequests()).toEqual([]);
  });

  it('refuses an agent with no saved settings', async () => {
    mocks.config = null;
    expect((await requestGrant('a1', { action: 'settings.app.write', target: 'app', reason: 'x' })).isError).toBe(true);
  });
});

describe('answering a request (#2970)', () => {
  const grantRequest = () => {
    const r = recordGrantRequest('g', { kind: 'grant', agentId: 'a1', agentName: 'Ada', projectPath: '/p', actions: ['settings.app.write'], target: { kind: 'app' }, where: 'the app' });
    if (!r.ok) throw new Error('not recorded');
    return r.request.requestId;
  };

  it('Allow on a permission request saves it as the user\'s change, and tells the agent', async () => {
    expect(await answerGrantRequest(grantRequest(), true)).toEqual({ ok: true });
    expect(mocks.setAgentGrant).toHaveBeenCalledWith('/p', 'a1', { action: 'settings.app.write', target: { kind: 'app' }, mode: 'allow' });
    expect(mocks.deliver).toHaveBeenCalledWith('a1', expect.stringContaining('allowed'), expect.objectContaining({ fromClubhouse: true }));
    expect(listGrantRequests()).toEqual([]);
  });

  it('Decline changes nothing and tells the agent', async () => {
    expect(await answerGrantRequest(grantRequest(), false)).toEqual({ ok: true });
    expect(mocks.setAgentGrant).not.toHaveBeenCalled();
    expect(mocks.deliver).toHaveBeenCalledWith('a1', expect.stringContaining('declined'), expect.anything());
  });

  it('a save that fails keeps the request, so the user can try again or decline', async () => {
    mocks.setAgentGrant.mockRejectedValueOnce(new Error('Agent not found'));
    const id = grantRequest();
    expect(await answerGrantRequest(id, true)).toEqual({ ok: false, error: 'Agent not found' });
    expect(listGrantRequests().map((r) => r.requestId)).toEqual([id]);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it('two answers at once: the first one counts, and the other is told it was already answered', async () => {
    const id = grantRequest();
    const [allowed, declined] = await Promise.all([answerGrantRequest(id, true), answerGrantRequest(id, false)]);
    expect(allowed).toEqual({ ok: true });
    expect(declined).toMatchObject({ ok: false });
    expect(mocks.setAgentGrant).toHaveBeenCalledTimes(1);
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
  });

  it('an unknown or answered request says so', async () => {
    const id = grantRequest();
    await answerGrantRequest(id, false);
    expect(await answerGrantRequest(id, true)).toMatchObject({ ok: false });
  });

  it('Allow on a call request tells the agent to call again, and saves nothing', async () => {
    const r = recordGrantRequest('c', { kind: 'call', agentId: 'a1', agentName: 'Ada', projectPath: '/p', actions: ['settings.app.write'], where: 'the app', toolName: 'set_helper_presets' });
    if (!r.ok) throw new Error('not recorded');
    expect(await answerGrantRequest(r.request.requestId, true)).toEqual({ ok: true });
    expect(mocks.setAgentGrant).not.toHaveBeenCalled();
    expect(mocks.deliver).toHaveBeenCalledWith('a1', expect.stringContaining('same call again'), expect.anything());
  });
});

it.each(['mcp', 'dispatcher', 'mobile', 'annex_desktop', 'system'] as const)('a %s origin cannot answer a deletion batch', async (surface) => {
  const { withSettingsSurface } = await import('./settings-audit');
  const { callKey, consumeCallApprovalScope } = await import('./grant-requests');
  const key = callKey('a1', 'delete_agents', { items: [] });
  const recorded = recordGrantRequest(key, { kind: 'call', agentId: 'a1', agentName: 'Ada', projectPath: '/p', actions: ['agent.dispose'], where: 'batch', deleteReview: { items: [] } }, Date.now(), { context: 'exact', asks: [] });
  if (!recorded.ok) throw new Error('Could not record request');
  const answer = await withSettingsSurface(surface, 'a1', () => answerGrantRequest(recorded.request.requestId, true));
  expect(answer).toMatchObject({ ok: false, error: expect.stringContaining('originating computer') });
  expect(listGrantRequests()).toHaveLength(1);
  expect(consumeCallApprovalScope(key)).toBeNull();
  expect(await withSettingsSurface('ui', undefined, () => answerGrantRequest(recorded.request.requestId, true))).toEqual({ ok: true });
  expect(consumeCallApprovalScope(key)?.scope.context).toBe('exact');
});
