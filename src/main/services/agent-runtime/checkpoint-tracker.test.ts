import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatEvent } from '../../../shared/chat';
import { CHAT_CONTRACT_VERSION } from '../../../shared/chat';

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

import { captureBeforePrompt, clearCheckpointCaches, getChanges, handleChatEventForCheckpoints, isRevertRunning, listTurns, revertTurn, undoRevert, whenCheckpointsIdle } from './checkpoint-tracker';

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

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-tracker-'));
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
});

afterEach(async () => {
  // Pruning runs after turn_ended in the background; on Windows deleting the repo under it fails with EBUSY.
  await whenCheckpointsIdle();
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('checkpoint tracker', () => {
  it('names the pre-prompt snapshot as the turn start, checkpoints the end and reports the turn diff', async () => {
    await captureBeforePrompt('agent-1');
    // The agent edits before turn_started is observed: the start checkpoint must not include it.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    handleChatEventForCheckpoints(turnEvent('turn_started', 'turn-1'));
    await settle(async () => (await listTurns('agent-1')).length === 1);
    handleChatEventForCheckpoints(turnEvent('turn_ended', 'turn-1'));
    await settle(async () => !!(await listTurns('agent-1'))[0]?.end);

    const changes = await getChanges('agent-1', { turnId: 'turn-1' }, 'a.txt');
    expect(changes.available).toBe(true);
    expect(changes.live).toBe(false);
    expect(changes.files).toEqual([expect.objectContaining({ path: 'a.txt', status: 'modified', additions: 1, deletions: 1 })]);
    expect(changes.patch).toContain('+two');

    // The pending snapshot ref is cleaned up once the turn names it.
    expect(git('for-each-ref', 'refs/clubhouse/pending/')).toBe('');

    const result = await revertTurn('agent-1', 'turn-1');
    expect(result).toEqual({ reverted: ['a.txt'], conflicts: [], skipped: [], undoable: true });
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('one\n');
    expect((await listTurns('agent-1'))[0].undoable).toBe(true);

    const undo = await undoRevert('agent-1', 'turn-1');
    expect(undo).toEqual({ reverted: ['a.txt'], conflicts: [], skipped: [], undoable: false });
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('two\n');
    expect((await listTurns('agent-1'))[0].undoable).toBeUndefined();
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

  it('reports a revert in progress so new prompts can wait for it', async () => {
    await runTurn('turn-p', () => fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n'));
    expect(await isRevertRunning('agent-1')).toBe(false);
    const reverting = revertTurn('agent-1', 'turn-p');
    await settle(() => isRevertRunning('agent-1'));
    await reverting;
    expect(await isRevertRunning('agent-1')).toBe(false);
  });

  it('does not mark turns shared for agents in other worktrees', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'other-wt-'));
    try {
      reg.others.set('term-2', { cwd: other, runtime: 'pty' });
      await runTurn('turn-o', () => fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n'));
      expect((await listTurns('agent-1'))[0].shared).toBeUndefined();
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
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

    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
    reg.cwd = plain;
    clearCheckpointCaches();
    expect(await getChanges('agent-1', { turnId: 'turn-3' })).toEqual({ available: false, files: [] });
    fs.rmSync(plain, { recursive: true, force: true });
  });
});
