import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { randomUUID } from 'crypto';

const controls = vi.hoisted(() => ({ mode: 'ask' as 'allow' | 'ask' | 'off', enabled: true, canonical: undefined as string | undefined }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../agent-config', () => ({ getDurableConfig: vi.fn(async () => ({ name: 'Dispatcher' })) }));
vi.mock('../agent-grants-store', () => ({
  getAgentGrantChanges: () => ({ changes: [{ action: 'project.add', target: { kind: 'project', project: 'any' }, mode: controls.mode }] }),
}));
vi.mock('../project-store', () => ({
  peekProjects: async () => [],
  canonicalProjectPath: async (folder: string) => controls.canonical ?? path.resolve(folder),
}));
vi.mock('../dispatcher/dispatcher-settings', async (original) => ({
  ...await original<typeof import('../dispatcher/dispatcher-settings')>(),
  isDispatcherEnabled: () => controls.enabled,
}));

import { importAuthorization, previewAuthorization } from './approval';
import { IMPORT_EFFECTS, type ImportPlan } from './types';
import { agentRegistry } from '../agent-registry';
import { setDispatcherAgent, _resetDispatcherGateForTesting } from '../clubhouse-mcp/dispatcher-gate';
import { setMcpCaller, _resetMcpCallGateForTesting } from '../clubhouse-mcp/mcp-call-gate';
import { _resetGrantRequestsForTesting, listGrantRequests, takeGrantRequest, finishGrantAnswer, recordGrantRequest, callKey } from '../grant-requests';

function plan(): ImportPlan {
  return {
    id: randomUUID(), agentId: 'dispatcher', url: 'https://github.com/example/repo.git',
    defaultBranch: 'trunk', branch: 'release', commit: 'a'.repeat(40), headCommit: 'b'.repeat(40),
    destination: path.resolve('/work/repo'), parent: path.resolve('/work'), parentIdentity: '1:2',
    createdAt: Date.now(), expiresAt: Date.now() + 600_000, effects: IMPORT_EFFECTS,
  };
}
function humanAllows() {
  const [request] = listGrantRequests();
  expect(request).toBeDefined();
  expect(takeGrantRequest(request.requestId, true)).toMatchObject({ requestId: request.requestId, kind: 'call' });
  finishGrantAnswer(request.requestId);
  return request;
}

beforeEach(() => {
  controls.mode = 'ask';
  controls.enabled = true;
  controls.canonical = undefined;
  _resetGrantRequestsForTesting();
  _resetDispatcherGateForTesting();
  _resetMcpCallGateForTesting();
  agentRegistry.register('dispatcher', { projectPath: '/dispatcher', orchestrator: 'claude-code', runtime: 'headless', nonce: 'fixture-private-session-nonce' });
  setDispatcherAgent('dispatcher', true);
  setMcpCaller('dispatcher', '/dispatcher', {});
});

describe('real original-scope human approval for GitHub import', () => {
  it.each(['allow', 'ask'] as const)('always creates a genuine exact human request under project.add=%s', async (mode) => {
    controls.mode = mode;
    const p = plan();
    const authorize = importAuthorization('dispatcher');
    expect(await authorize(p)).toMatchObject({ kind: 'asked' });
    const [request] = listGrantRequests();
    expect(request.toolName).toBe('import_github_repository');
    expect(JSON.parse(request.argumentsText!)).toEqual({ planId: p.id, destination: p.destination });
    for (const fact of [p.url, p.destination, p.branch, p.commit, p.defaultBranch, p.headCommit, ...p.effects]) expect(request.detail).toContain(fact);
    expect(request.detail).toContain('No agent creation');
    expect(JSON.stringify(request)).not.toContain('fixture-private-session-nonce');
    expect(await authorize(p)).toMatchObject({ kind: 'asked' });
    expect(listGrantRequests()).toHaveLength(1);
    humanAllows();
    const result = await authorize(p);
    expect(result.kind).toBe('approved');
    if (result.kind !== 'approved') throw new Error('expected genuine approved decision');
    await expect(result.assertCurrent()).resolves.toBeUndefined();
    expect(await authorize(p)).toMatchObject({ kind: 'asked' });
  });

  it('refuses Off instead of treating an earlier click or generic Allow as authority', async () => {
    const p = plan();
    const authorize = importAuthorization('dispatcher');
    await authorize(p);
    humanAllows();
    controls.mode = 'off';
    await expect(authorize(p)).rejects.toMatchObject({ reason: 'permission_denied' });
    controls.mode = 'allow';
    expect(await authorize(p)).toMatchObject({ kind: 'asked' });
  });

  it('does not accept a legacy key-only allowed call as a scope-bound human proof', async () => {
    const p = plan();
    const args = { planId: p.id, destination: p.destination };
    recordGrantRequest(callKey('dispatcher', 'import_github_repository', args), {
      kind: 'call', agentId: 'dispatcher', agentName: 'Dispatcher', projectPath: '/dispatcher',
      actions: ['project.add'], where: p.destination, toolName: 'import_github_repository',
    });
    humanAllows();
    expect(await importAuthorization('dispatcher')(p)).toMatchObject({ kind: 'asked' });
  });

  it.each(['commit', 'defaultBranch', 'headCommit', 'parentIdentity', 'url', 'effects'] as const)('invalidates an answered original request when main-owned %s changes under the same plan id', async (field) => {
    const p = plan();
    const authorize = importAuthorization('dispatcher');
    await authorize(p);
    humanAllows();
    const changed = { ...p };
    if (field === 'effects') changed.effects = [...p.effects, 'Unexpected additional effect'];
    else changed[field] = field === 'commit' || field === 'headCommit' ? 'c'.repeat(40) : field === 'url' ? 'https://github.com/example/other.git' : 'different';
    expect(await authorize(changed)).toMatchObject({ kind: 'asked' });
  });

  it('withdraws a stale pending plan request so its old row cannot approve changed scope', async () => {
    const p = plan();
    const authorize = importAuthorization('dispatcher');
    await authorize(p);
    const [old] = listGrantRequests();
    await authorize({ ...p, commit: 'c'.repeat(40) });
    expect(takeGrantRequest(old.requestId, true)).toBeNull();
    expect(listGrantRequests()[0].requestId).not.toBe(old.requestId);
  });

  it.each(['policy', 'session', 'provider', 'canonical', 'dispatcher'] as const)('rejects freshness at the effect boundary after %s changes during an await', async (change) => {
    const p = plan();
    const authorize = importAuthorization('dispatcher');
    await authorize(p);
    humanAllows();
    const accepted = await authorize(p);
    if (accepted.kind !== 'approved') throw new Error('expected approved');
    if (change === 'policy') controls.mode = 'allow';
    if (change === 'session') agentRegistry.setNonce('dispatcher', 'new-fixture-session');
    if (change === 'provider') agentRegistry.get('dispatcher')!.orchestrator = 'codex-cli';
    if (change === 'canonical') controls.canonical = path.resolve('/different');
    if (change === 'dispatcher') controls.enabled = false;
    await expect(accepted.assertCurrent()).rejects.toMatchObject({ reason: change === 'dispatcher' ? 'caller_changed' : 'approval_changed' });
  });

  it('uses project.add for remote-account preview, asks under Ask, and never confuses its answer with import approval', async () => {
    const p = plan();
    const scope = { url: p.url, destination: p.destination, parent: p.parent, parentIdentity: p.parentIdentity };
    expect(await previewAuthorization('dispatcher')(scope)).toMatchObject({ kind: 'asked' });
    const previewRequest = humanAllows();
    expect(previewRequest.detail).toContain('Preview only');
    expect(previewRequest.detail).toContain('No destination directory');
    expect((await previewAuthorization('dispatcher')(scope)).kind).toBe('approved');
    expect(await importAuthorization('dispatcher')(p)).toMatchObject({ kind: 'asked' });
  });

  it('allows metadata-only preview under Allow but rechecks revocation before exposing private metadata', async () => {
    controls.mode = 'allow';
    const p = plan();
    const accepted = await previewAuthorization('dispatcher')({ url: p.url, destination: p.destination, parent: p.parent, parentIdentity: p.parentIdentity });
    expect(accepted.kind).toBe('approved');
    expect(listGrantRequests()).toEqual([]);
    if (accepted.kind !== 'approved') throw new Error('expected approved');
    controls.mode = 'off';
    await expect(accepted.assertCurrent()).rejects.toMatchObject({ reason: 'permission_denied' });
  });
});
