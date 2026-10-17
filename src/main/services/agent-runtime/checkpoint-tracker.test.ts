import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatEvent } from '../../../shared/chat';
import { CHAT_CONTRACT_VERSION } from '../../../shared/chat';

const reg = vi.hoisted(() => ({ cwd: '' }));
vi.mock('../agent-registry', () => ({ agentRegistry: { get: () => ({ cwd: reg.cwd, projectPath: reg.cwd, runtime: 'chat', orchestrator: 'claude-code' }) } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { captureBeforePrompt, clearCheckpointCaches, getChanges, handleChatEventForCheckpoints, listTurns, revertTurn } from './checkpoint-tracker';

let repo: string;
let seq = 0;
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}
function turnEvent(type: 'turn_started' | 'turn_ended', turnId: string): ChatEvent {
  const data = type === 'turn_started' ? { trigger: 'prompt' as const } : { stopReason: 'end_turn' as const };
  return { v: CHAT_CONTRACT_VERSION, agentId: 'agent-1', sessionId: 'sess', turnId, seq: ++seq, ts: Date.now(), type, data } as ChatEvent;
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
  clearCheckpointCaches();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
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

    const result = await revertTurn('agent-1', 'turn-1');
    expect(result).toEqual({ reverted: ['a.txt'], conflicts: [] });
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('one\n');
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
