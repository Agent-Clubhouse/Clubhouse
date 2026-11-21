import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isRemoteAgentChanges } from '../../shared/remote-agent-changes';
import { readRemoteAgentChanges } from './remote-agent-changes';
import { ReadOnlyGitError } from './read-only-repository-changes';
const m = vi.hoisted(() => ({ target: vi.fn(), registry: vi.fn(), runtime: vi.fn(), running: vi.fn(), root: vi.fn(), git: vi.fn(), changes: vi.fn(), refs: '', message: '', witnessCurrent: true }));
vi.mock('./read-only-agent-target-witness', () => ({ captureReadOnlyAgentTargetWitness: () => ({ current: () => m.witnessCurrent }) }));
vi.mock('./agent-config-reader', () => ({ resolveAgentConfigTarget: m.target }));
vi.mock('./agent-registry', () => ({ agentRegistry: { get: m.registry } }));
vi.mock('./agent-runtime', () => ({ getAgentRuntime: m.runtime }));
vi.mock('./agent-system', () => ({ isAgentRunning: m.running }));
vi.mock('./dispatcher/dispatcher-service', () => ({ isDispatcherIdentityAgentId: (id: string) => id === 'dispatcher' }));
vi.mock('./read-only-repository-changes', () => ({ readOnlyRepositoryRoot: m.root, readOnlyGit: m.git, readOnlyRepositoryChanges: m.changes, ReadOnlyGitError: class extends Error { constructor(readonly code: number, readonly stderr: string) { super('git unavailable'); } } }));
const head = 'a'.repeat(40), base = 'b'.repeat(40), end = 'c'.repeat(40);
beforeEach(() => {
  const reg = { nonce: 'run-a', runtime: 'chat', cwd: '/host/selected/subdir' };
  m.target.mockResolvedValue({ agent: { id: 'a1', name: 'Selected', worktreePath: '/host/selected' }, project: { id: 'p1', path: '/host/project' } });
  m.registry.mockReturnValue(reg);
  m.running.mockReturnValue(true);
  m.runtime.mockReturnValue({ kind: 'chat', getSessionId: () => 'session-a', getNativeSessionId: () => 'native-a' });
  m.root.mockResolvedValue('/host/selected');
  m.changes.mockResolvedValue({ files: [], totalFiles: 0, offset: 0, nextOffset: null, uncompared: 0 });
  m.refs = ''; m.message = ''; m.witnessCurrent = true;
  m.git.mockImplementation(async (_cwd, args: string[]) => {
    if (args[0] === 'rev-parse') { if (args.includes('HEAD^{commit}')) return Buffer.from(head); if (args.some((a) => a === 'refs/heads/main^{commit}')) return Buffer.from(base); throw new ReadOnlyGitError(1, 'missing ref'); }
    if (args[0] === 'symbolic-ref') { if (args.includes('HEAD')) return Buffer.from('feature'); throw new ReadOnlyGitError(1, 'missing ref'); }
    if (args[0] === 'merge-base') return Buffer.from(base);
    if (args[0] === 'for-each-ref') return Buffer.from(m.refs);
    if (args[0] === 'show') return Buffer.from(m.message);
    throw new Error('unexpected read');
  });
});
describe('exact selected-agent passive Changes reader', () => {
  it('derives the branch comparison from the registered worktree, accepts a subdirectory cwd and never caller paths', async () => {
    const result = await readRemoteAgentChanges('a1', { scope: 'branch' }, () => true);
    expect(result.status).toBe(200);
    expect(isRemoteAgentChanges(result.body, 'a1', { scope: 'branch' })).toBe(true);
    expect(result.body).toMatchObject({ branch: 'feature', base: 'main', state: 'ok' });
    expect(m.changes).toHaveBeenCalledWith({ root: '/host/selected', from: base, identity: 'a1:run-a:branch' }, { scope: 'branch' }, expect.any(Function));
    expect(m.target).toHaveBeenCalledWith('a1', undefined, { strict: true });
    expect((await readRemoteAgentChanges('a1', { scope: 'branch', path: '/unrelated' } as never, () => true)).status).toBe(400);
  });
  it('binds session/last-turn refs to this exact agent and current session, including shared and skipped evidence', async () => {
    m.refs = [
      `refs/clubhouse/checkpoints/a1/old-session/old-turn/start\t${head}`,
      `refs/clubhouse/checkpoints/a1/session-a/turn-a/start\t${base}`,
      `refs/clubhouse/checkpoints/a1/session-a/turn-a/end\t${end}`,
      `refs/clubhouse/checkpoints/a1/session-a/turn-a/shared\t${base}`,
    ].join('\n');
    m.message = 'Skipped-large: "large-file"\nSkipped-repo: "nested"';
    const turn = await readRemoteAgentChanges('a1', { scope: 'turn' }, () => true);
    expect(turn.status).toBe(200);
    expect(turn.body).toMatchObject({ sessionId: 'session-a', turnId: 'turn-a', live: false, shared: true, skippedLarge: ['large-file'], skippedRepos: ['nested'] });
    expect(m.changes.mock.calls[0][0]).toMatchObject({ from: base, to: end });
    expect(m.git.mock.calls.find((c) => c[1][0] === 'for-each-ref')?.[1]).toContain('refs/clubhouse/checkpoints/a1/');
    const session = await readRemoteAgentChanges('a1', { scope: 'session' }, () => true);
    expect(session.body).toMatchObject({ sessionId: 'session-a', turnId: null, live: true });
    expect(m.changes.mock.calls[1][0]).toMatchObject({ from: base, to: undefined });
  });
  it('keeps no-checkpoint/not-git and read failure distinct from verified empty', async () => {
    expect((await readRemoteAgentChanges('a1', { scope: 'turn' }, () => true)).body).toMatchObject({ state: 'no-checkpoint' });
    m.root.mockResolvedValueOnce(null);
    expect((await readRemoteAgentChanges('a1', { scope: 'branch' }, () => true)).body).toMatchObject({ state: 'not-git' });
    m.git.mockRejectedValueOnce(new ReadOnlyGitError(128, 'permission denied'));
    expect((await readRemoteAgentChanges('a1', { scope: 'branch' }, () => true)).status).toBe(500);
    m.target.mockResolvedValueOnce({ agent: { id: 'different' }, project: { path: '/private' } });
    expect((await readRemoteAgentChanges('a1', { scope: 'branch' }, () => true)).status).toBe(404);
  });
  it.each(['revoked', 'restart', 'stopped', 'removed', 'branch'] as const)('refuses late result when %s changes during the comparison', async (condition) => {
    let allowed = true;
    m.changes.mockImplementation(async () => {
      if (condition === 'revoked') allowed = false;
      if (condition === 'restart') m.registry.mockReturnValue({ nonce: 'run-b', runtime: 'chat', cwd: '/host/selected/subdir' });
      if (condition === 'stopped') m.running.mockReturnValue(false);
      if (condition === 'removed') m.target.mockRejectedValue(new Error('No registered agent matches that reference.'));
      if (condition === 'branch') m.git.mockResolvedValue(Buffer.from(end));
      return { files: [], totalFiles: 0, offset: 0, nextOffset: null, uncompared: 0 };
    });
    const result = await readRemoteAgentChanges('a1', { scope: 'branch' }, () => allowed);
    expect(result.status).toBe(condition === 'revoked' ? 403 : condition === 'removed' ? 404 : 409);
    expect(JSON.stringify(result.body)).not.toContain('/host/');
  });
  it('checks run identity after the final awaited branch probe, including a restart during that probe', async () => {
    const original = m.git.getMockImplementation()!;
    let headReads = 0;
    m.git.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1].includes('HEAD^{commit}') && ++headReads === 2) m.registry.mockReturnValue({ nonce: 'replacement', runtime: 'chat', cwd: '/host/selected/subdir' });
      return result;
    });
    expect((await readRemoteAgentChanges('a1', { scope: 'branch' }, () => true)).status).toBe(409);
  });
  it('refuses a sleeping selected ID removed during the read even when another agent has that name and identical folders', async () => {
    m.registry.mockReturnValue(undefined); m.runtime.mockReturnValue(undefined); m.running.mockReturnValue(false);
    m.changes.mockImplementation(async () => {
      m.target.mockResolvedValue({ agent: { id: 'b1', name: 'a1', worktreePath: '/host/selected' }, project: { id: 'p1', path: '/host/project' } });
      return { files: [], totalFiles: 0, offset: 0, nextOffset: null, uncompared: 0 };
    });
    const result = await readRemoteAgentChanges('a1', { scope: 'branch' }, () => true);
    expect(result.status).not.toBe(200);
    expect(result.body).not.toHaveProperty('files');
  });
  it.each(['root', 'HEAD'] as const)('refuses a sleeping target disposed or untracked during the final %s await', async (phase) => {
    m.registry.mockReturnValue(undefined); m.runtime.mockReturnValue(undefined); m.running.mockReturnValue(false);
    const original = m.git.getMockImplementation()!;
    let roots = 0, heads = 0;
    const dispose = () => { m.witnessCurrent = false; m.target.mockResolvedValue({ agent: { id: 'a1', name: 'Selected', disposedAt: '2026-11-19T00:00:00Z', worktreePath: '/host/selected' }, project: { id: 'p1', path: '/host/project' } }); };
    m.root.mockImplementation(async () => { if (++roots === 2 && phase === 'root') dispose(); return '/host/selected'; });
    m.git.mockImplementation(async (...args) => {
      const value = await original(...args);
      if (args[1].includes('HEAD^{commit}') && ++heads === 2 && phase === 'HEAD') dispose();
      return value;
    });
    const result = await readRemoteAgentChanges('a1', { scope: 'branch' }, () => true);
    expect(result.status).not.toBe(200);
    expect(result.body).not.toHaveProperty('files');
  });
  it('bounds concurrent passive comparisons globally and per target, releasing every slot after completion', async () => {
    m.target.mockImplementation(async (id) => ({ agent: { id, worktreePath: '/host/selected' }, project: { id: 'p1', path: '/host/project' } }));
    const finishes: (() => void)[] = [];
    m.changes.mockImplementation(() => new Promise((resolve) => finishes.push(() => resolve({ files: [], totalFiles: 0, offset: 0, nextOffset: null, uncompared: 0 }))));
    const first = readRemoteAgentChanges('a1', { scope: 'branch' }, () => true);
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    expect((await readRemoteAgentChanges('a1', { scope: 'branch' }, () => true)).status).toBe(429);
    const second = readRemoteAgentChanges('a2', { scope: 'branch' }, () => true);
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    expect((await readRemoteAgentChanges('a3', { scope: 'branch' }, () => true)).status).toBe(429);
    for (const finish of finishes) finish();
    expect((await Promise.all([first, second])).map((r) => r.status)).toEqual([200, 200]);
    m.changes.mockResolvedValue({ files: [], totalFiles: 0, offset: 0, nextOffset: null, uncompared: 0 });
    expect((await readRemoteAgentChanges('a3', { scope: 'branch' }, () => true)).status).toBe(200);
  });
});
