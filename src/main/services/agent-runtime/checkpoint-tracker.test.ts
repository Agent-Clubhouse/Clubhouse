import { describe, it as rawIt, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatEvent } from '../../../shared/chat';
import { CHAT_CONTRACT_VERSION } from '../../../shared/chat';
import { CheckpointFixtureLifetime } from '../../../../test/checkpoint-fixture-lifetime';
import { ownedRegistration } from '../../../../test/dispatcher-work-owner';

const lifetime = vi.hoisted(() => ({ current: undefined as CheckpointFixtureLifetime | undefined }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { ownCheckpointExecFile } = await import('../../../../test/checkpoint-fixture-lifetime');
  return { ...actual, execFile: ownCheckpointExecFile(actual.execFile, () => lifetime.current) };
});

const reg = vi.hoisted(() => ({
  cwd: '',
  /** Extra agents beyond agent-1, by id. */
  others: new Map<string, { cwd: string; runtime: 'chat' | 'pty' | 'headless' }>(),
  state: 'idle' as string,
}));
vi.mock('../agent-registry', () => {
  const registration = (id: string) => {
    const other = reg.others.get(id);
    const cwd = other?.cwd ?? reg.cwd;
    return { cwd, projectPath: cwd, runtime: other?.runtime ?? 'chat', orchestrator: 'claude-code' };
  };
  return {
    agentRegistry: {
      get: (id: string) => registration(id),
      getAllRegistrations: () => new Map(['agent-1', ...reg.others.keys()].map((id) => [id, registration(id)])),
    },
  };
});
vi.mock('./index', () => ({
  getAgentRuntime: (id: string) => ({
    kind: reg.others.get(id)?.runtime === 'pty' ? 'pty' : 'chat',
    isRunning: () => true,
    getState: () => (id === 'agent-1' ? reg.state : 'idle'),
  }),
}));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { captureBeforePrompt as actualCaptureBeforePrompt, clearCheckpointCaches, getChanges as actualGetChanges, handleChatEventForCheckpoints as actualHandleChatEvent, isRevertRunning as actualIsRevertRunning, listTurns as actualListTurns, revertTurn as actualRevertTurn, undoRevert as actualUndoRevert, whenCheckpointsIdle as actualWhenIdle } from './checkpoint-tracker';

// Every plain async body is captured before Vitest's timeout wrapper abandons it.
const it = ownedRegistration(rawIt, 1, (promise) => { fixture().observeRaw(promise); });
function fixture(): CheckpointFixtureLifetime {
  if (!lifetime.current) throw new Error('Checkpoint fixture is missing');
  return lifetime.current;
}
function ownOperation<A extends unknown[], R>(operation: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return function (this: unknown, ...args: A): Promise<R> {
    const owner = fixture();
    return owner.observeDirect(operation.apply(this, args));
  };
}
const captureBeforePrompt = ownOperation(actualCaptureBeforePrompt);
const getChanges = ownOperation(actualGetChanges);
const isRevertRunning = ownOperation(actualIsRevertRunning);
const listTurns = ownOperation(actualListTurns);
const revertTurn = ownOperation(actualRevertTurn);
const undoRevert = ownOperation(actualUndoRevert);
const whenCheckpointsIdle = ownOperation(actualWhenIdle);
function handleChatEventForCheckpoints(...args: Parameters<typeof actualHandleChatEvent>): ReturnType<typeof actualHandleChatEvent> {
  fixture().event();
  return actualHandleChatEvent(...args);
}
// Captured paths/options belong to one fixture until complete retirement, never
// the mutable repo/reg alias used by subsequent setup. Auxiliary deletion is deferred.
let directories: Array<{ directory: string; options: fs.RmOptions }> = [];
let removeAbortListener: () => void = () => {};
function retainDirectory(directory: string, options: fs.RmOptions): string {
  directories.push({ directory, options });
  return directory;
}

let repo: string;
let seq = 0;
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}
function turnEvent(type: 'turn_started' | 'turn_ended', turnId: string, agentId = 'agent-1'): ChatEvent {
  const data = type === 'turn_started' ? { trigger: 'prompt' as const } : { stopReason: 'end_turn' as const };
  return { v: CHAT_CONTRACT_VERSION, agentId, sessionId: 'sess', turnId, seq: ++seq, ts: Date.now(), type, data } as ChatEvent;
}
async function runTurn(turnId: string, edit: () => void, agentId = 'agent-1'): Promise<void> {
  handleChatEventForCheckpoints(turnEvent('turn_started', turnId, agentId));
  await settle(async () => (await listTurns(agentId)).some((t) => t.turnId === turnId));
  edit();
  handleChatEventForCheckpoints(turnEvent('turn_ended', turnId, agentId));
  await settle(async () => !!(await listTurns(agentId)).find((t) => t.turnId === turnId)?.end);
}
async function settle(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for checkpoints');
}

beforeEach((context) => {
  // A hook timeout can abandon afterEach too. Refuse *before* any base/cache/mock
  // mutation until the captured old owner has actually retired.
  lifetime.current?.assertRetired();
  const owner = new CheckpointFixtureLifetime();
  lifetime.current = owner;
  directories = [];
  const abort = () => { owner.freezeFailure('abort'); reportFailure(owner); };
  context.signal.addEventListener('abort', abort, { once: true });
  removeAbortListener = () => { context.signal.removeEventListener('abort', abort); };
  repo = retainDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-tracker-')), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  reg.cwd = repo;
  reg.others.clear();
  reg.state = 'idle';
  clearCheckpointCaches();
  git('init', '-q', '-b', 'main');
  // Windows runners default to core.autocrlf=true; these tests compare exact bytes.
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  owner.phaseFinished();
});

const reportedFailures = new WeakSet<CheckpointFixtureLifetime>();
function reportFailure(owner: CheckpointFixtureLifetime): void {
  try {
    const { failure } = owner.evidence();
    if (!failure || reportedFailures.has(owner)) return;
    reportedFailures.add(owner);
    console.error('[checkpoint-fixture-failure]', JSON.stringify(failure));
  } catch { /* Diagnostics must not replace or delay the original failure. */ }
}

afterEach(async (context) => {
  const owner = fixture();
  const capturedDirectories = directories;
  const unsubscribe = removeAbortListener;
  if (context.task.result?.state === 'fail') owner.freezeFailure('failed-case');
  reportFailure(owner);
  try {
    // Raw/direct roots precede event idle; callback AND close receipts then cover
    // fail-fast Git siblings excluded by those returned promises. Admission stays
    // open for their late descendants. This controller is not one of its own roots.
    await owner.close(actualWhenIdle, () => {
      unsubscribe();
      for (const { directory, options } of capturedDirectories) fs.rmSync(directory, options);
    });
  } catch (error) {
    owner.freezeFailure('teardown-error');
    reportFailure(owner);
    throw error;
  } finally {
    // Freeze the original phase at abort/rejection, not whichever phase a late raw
    // continuation reaches. The separate teardown receipt contains no paths/data.
    try {
      const evidence = owner.evidence();
      if (evidence.failure) console.error('[checkpoint-fixture-teardown]', JSON.stringify(evidence.teardown));
    } catch { /* Diagnostics must not replace the failure. */ }
  }
});

describe('checkpoint tracker', () => {
  it('names the pre-prompt snapshot as the turn start, checkpoints the end and reports the turn diff', async () => {
    fixture().phaseStarted('capture');
    await captureBeforePrompt('agent-1');
    fixture().phaseFinished();
    // The agent edits before turn_started is observed: the start checkpoint must not include it.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    fixture().phaseStarted('start');
    handleChatEventForCheckpoints(turnEvent('turn_started', 'turn-1'));
    await settle(async () => (await listTurns('agent-1')).length === 1);
    fixture().phaseFinished();
    fixture().phaseStarted('end');
    handleChatEventForCheckpoints(turnEvent('turn_ended', 'turn-1'));
    await settle(async () => !!(await listTurns('agent-1'))[0]?.end);

    fixture().phaseFinished();
    fixture().phaseStarted('diff');
    const changes = await getChanges('agent-1', { turnId: 'turn-1' }, 'a.txt');
    fixture().phaseFinished();
    expect(changes.available).toBe(true);
    expect(changes.live).toBe(false);
    expect(changes.files).toEqual([expect.objectContaining({ path: 'a.txt', status: 'modified', additions: 1, deletions: 1 })]);
    expect(changes.patch).toContain('+two');

    // The pending snapshot ref is cleaned up once the turn names it.
    expect(git('for-each-ref', 'refs/clubhouse/pending/')).toBe('');
  });

  it('reverts a completed turn and undoes the revert with exact bytes and undoable state', async () => {
    await runTurn('turn-1', () => fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n'));

    fixture().phaseStarted('revert');
    const result = await revertTurn('agent-1', 'turn-1');
    expect(result).toEqual({ reverted: ['a.txt'], conflicts: [], skipped: [], undoable: true });
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('one\n');
    expect((await listTurns('agent-1'))[0].undoable).toBe(true);

    fixture().phaseFinished();
    fixture().phaseStarted('undo');
    const undo = await undoRevert('agent-1', 'turn-1');
    expect(undo).toEqual({ reverted: ['a.txt'], conflicts: [], skipped: [], undoable: false });
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('two\n');
    expect((await listTurns('agent-1'))[0].undoable).toBeUndefined();
    fixture().phaseFinished();
  });

  it('works from a subdirectory, with paths relative to the repository root', async () => {
    fs.mkdirSync(path.join(repo, 'pkg'));
    reg.cwd = path.join(repo, 'pkg');
    await runTurn('turn-sub', () => {
      fs.writeFileSync(path.join(repo, 'a.txt'), 'root edit\n');
      fs.writeFileSync(path.join(repo, 'pkg', 'b.txt'), 'pkg file\n');
    });
    const changes = await getChanges('agent-1', { turnId: 'turn-sub' });
    expect(changes.files.map((f) => f.path).sort()).toEqual(['a.txt', 'pkg/b.txt']);

    const result = await revertTurn('agent-1', 'turn-sub');
    expect(result.reverted.sort()).toEqual(['a.txt', 'pkg/b.txt']);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('one\n');
    expect(fs.existsSync(path.join(repo, 'pkg', 'b.txt'))).toBe(false);
  });

  it('marks turns shared when another agent works in the same worktree', async () => {
    reg.others.set('agent-2', { cwd: repo, runtime: 'chat' });
    handleChatEventForCheckpoints(turnEvent('turn_started', 'turn-a', 'agent-1'));
    await settle(async () => (await listTurns('agent-1')).length === 1);
    handleChatEventForCheckpoints(turnEvent('turn_started', 'turn-b', 'agent-2'));
    await settle(async () => (await listTurns('agent-1'))[0]?.shared === true);
    await settle(async () => (await listTurns('agent-2'))[0]?.shared === true);

    // While agent-2 is mid-turn, agent-1 can't revert.
    handleChatEventForCheckpoints(turnEvent('turn_ended', 'turn-a', 'agent-1'));
    await settle(async () => !!(await listTurns('agent-1'))[0]?.end);
    await expect(revertTurn('agent-1', 'turn-a')).rejects.toThrow(/Another agent is working in this worktree/);
  });

  it('marks a turn shared with a live terminal agent in the same worktree', async () => {
    reg.others.set('term-1', { cwd: repo, runtime: 'pty' });
    await runTurn('turn-t', () => fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n'));
    expect((await listTurns('agent-1'))[0].shared).toBe(true);
    // ...and refuses to revert while it's still there.
    await expect(revertTurn('agent-1', 'turn-t')).rejects.toThrow(/Another agent is working in this worktree/);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('x\n');
  });

  it('marks and closes a turn that ends before its start checkpoint is written', async () => {
    reg.others.set('term-1', { cwd: repo, runtime: 'pty' });
    handleChatEventForCheckpoints(turnEvent('turn_started', 'turn-q'));
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    handleChatEventForCheckpoints(turnEvent('turn_ended', 'turn-q'));
    await whenCheckpointsIdle();
    const [turn] = await listTurns('agent-1');
    expect(turn.end).toBeTruthy();
    expect(turn.shared).toBe(true);
    // The turn is closed: once the terminal agent leaves, it can be reverted.
    reg.others.clear();
    await expect(revertTurn('agent-1', 'turn-q')).resolves.toMatchObject({ conflicts: [] });
  });

  it('reports a revert in progress so new prompts can wait for it', async () => {
    await runTurn('turn-p', () => fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n'));
    expect(await isRevertRunning('agent-1')).toBe(false);
    const reverting = revertTurn('agent-1', 'turn-p');
    await settle(() => isRevertRunning('agent-1'));
    await reverting;
    expect(await isRevertRunning('agent-1')).toBe(false);
  });

  it('does not mark turns shared for agents in other worktrees', async () => {
    const other = retainDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'other-wt-')), { recursive: true, force: true });
    reg.others.set('term-2', { cwd: other, runtime: 'pty' });
    await runTurn('turn-o', () => fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n'));
    expect((await listTurns('agent-1'))[0].shared).toBeUndefined();
  });

  it('refuses to revert while the agent is mid-turn', async () => {
    await runTurn('turn-r', () => fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n'));
    reg.state = 'running';
    await expect(revertTurn('agent-1', 'turn-r')).rejects.toThrow(/finish its turn/);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('x\n');
  });

  it('shows session changes against the working tree', async () => {
    handleChatEventForCheckpoints(turnEvent('turn_started', 'turn-2'));
    await settle(async () => (await listTurns('agent-1')).length === 1);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
    const changes = await getChanges('agent-1', { sessionId: 'sess' });
    expect(changes.live).toBe(true);
    expect(changes.files.map((f) => f.path)).toEqual(['b.txt']);
  });

  it('reports unavailable outside a git repository and refuses to revert an unfinished turn', async () => {
    handleChatEventForCheckpoints(turnEvent('turn_started', 'turn-3'));
    await settle(async () => (await listTurns('agent-1')).length === 1);
    await expect(revertTurn('agent-1', 'turn-3')).rejects.toThrow(/no end checkpoint/);

    const owner = fixture();
    // Exclude this raw body from the controller it awaits; settle the previous
    // direct/event/child epoch before changing the registration/cache underneath it.
    await owner.settleEpoch(actualWhenIdle);
    owner.mutateEpoch(() => {
      const plain = retainDirectory(fs.mkdtempSync(path.join(os.tmpdir(), 'plain-')), { recursive: true, force: true });
      reg.cwd = plain;
      clearCheckpointCaches();
    });
    expect(await getChanges('agent-1', { turnId: 'turn-3' })).toEqual({ available: false, files: [] });
  });
});
