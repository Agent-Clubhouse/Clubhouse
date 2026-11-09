import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../base-dir', () => ({ getBaseDirPath: () => '/nonexistent-base-dir' }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('./dispatcher-service', () => ({ isDispatcherIdentityAgentId: () => false }));

import type { ChatEvent } from '../../../shared/chat';
import { publishChatEvent, removeAllChatEventListeners } from '../agent-runtime/chat-event-bus';
import {
  BACKGROUND_MARK_MS,
  _flushDispatcherUsageForTesting,
  _resetDispatcherUsageForTesting,
  _setDispatcherUsageDepsForTesting,
  clearDispatcherBackgroundWork,
  getDispatcherUsageDays,
  getDispatcherUsageSplit,
  noteDispatcherBackgroundWork,
  startDispatcherUsage,
} from './dispatcher-usage';

const WORK = 'disp-work';
const CHAT = 'disp-chat';
const DAY = '2026-11-09';

let tmp: string;
let file: string;
let now: number;
let seq = 0;

function setDeps(): void {
  _setDispatcherUsageDepsForTesting({ isDispatcherAgent: (id) => id === WORK || id === CHAT, file: () => file, now: () => now });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-usage-'));
  file = path.join(tmp, 'dispatcher-usage.json');
  now = new Date(2026, 10, 9, 10, 0).getTime();
  _resetDispatcherUsageForTesting();
  setDeps();
  startDispatcherUsage();
});
afterEach(() => {
  _resetDispatcherUsageForTesting();
  removeAllChatEventListeners();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function emit(agentId: string, type: string, data: unknown, turnId?: string): void {
  publishChatEvent({ v: 1, agentId, sessionId: 's', seq: ++seq, ts: now, type, data, ...(turnId && { turnId }) } as unknown as ChatEvent);
}

/** One whole turn: started, its usage, ended. */
function turn(agentId: string, turnId: string, tokens?: { input?: number; output?: number }, costUsd?: number): void {
  emit(agentId, 'turn_started', { trigger: 'immediate' }, turnId);
  if (tokens || costUsd !== undefined) emit(agentId, 'usage', { scope: 'turn', ...(tokens && { tokens }), ...(costUsd !== undefined && { costUsd }) }, turnId);
  emit(agentId, 'turn_ended', { stopReason: 'end_turn' }, turnId);
}

describe('Dispatcher usage is split into conversations and background work', () => {
  it('counts a turn as background only after background work was noted for that agent', () => {
    turn(CHAT, 't1', { input: 100, output: 10 }, 0.01);
    noteDispatcherBackgroundWork(WORK);
    turn(WORK, 't2', { input: 500, output: 50 }, 0.05);
    turn(WORK, 't3', { input: 7, output: 1 });

    const split = getDispatcherUsageSplit();
    expect(split.day).toBe(DAY);
    expect(split.background).toMatchObject({ turns: 1, input: 500, output: 50, costUsd: 0.05 });
    expect(split.conversations).toMatchObject({ turns: 2, input: 107, output: 11, costUsd: 0.01 });
  });

  it('a mark that waited too long, or whose delivery failed, claims no turn', () => {
    noteDispatcherBackgroundWork(WORK);
    now += BACKGROUND_MARK_MS + 1;
    turn(WORK, 't1', { input: 1 });
    noteDispatcherBackgroundWork(WORK);
    clearDispatcherBackgroundWork(WORK);
    turn(WORK, 't2', { input: 1 });
    expect(getDispatcherUsageSplit().background.turns).toBe(0);
    expect(getDispatcherUsageSplit().conversations.turns).toBe(2);
  });

  it('ignores other agents, subagents’ figures and running totals', () => {
    turn('someone-else', 'x', { input: 999 });
    emit(WORK, 'turn_started', { trigger: 'immediate' }, 't1');
    emit(WORK, 'usage', { scope: 'session', tokens: { input: 10_000 } }, 't1');
    emit(WORK, 'usage', { scope: 'turn', subagentId: 'sub', tokens: { input: 5_000 } }, 't1');
    emit(WORK, 'usage', { scope: 'turn', tokens: { input: 40 } }, 't1');
    emit(WORK, 'turn_ended', { stopReason: 'end_turn' }, 't1');
    expect(getDispatcherUsageSplit().conversations).toMatchObject({ turns: 1, input: 40 });
  });

  it('takes turn_ended’s own figures, and counts a turn with none apart', () => {
    emit(WORK, 'turn_started', { trigger: 'immediate' }, 't1');
    emit(WORK, 'turn_ended', { stopReason: 'end_turn', usage: { input: 3, output: 4 }, costUsd: 0.002 }, 't1');
    turn(WORK, 't2');
    expect(getDispatcherUsageSplit().conversations).toMatchObject({ turns: 2, turnsWithoutUsage: 1, input: 3, output: 4, costUsd: 0.002 });
  });

  it('keeps each day apart and saves the totals across a restart', async () => {
    noteDispatcherBackgroundWork(WORK);
    turn(WORK, 't1', { input: 10 });
    now += 24 * 60 * 60 * 1000;
    turn(CHAT, 't2', { input: 20 });
    await _flushDispatcherUsageForTesting();

    _resetDispatcherUsageForTesting();
    setDeps();
    expect(getDispatcherUsageSplit(DAY).background.input).toBe(10);
    expect(getDispatcherUsageSplit().conversations.input).toBe(20);
    expect(getDispatcherUsageDays().map((d) => d.day)).toEqual([DAY, '2026-11-10']);
  });

  it('a day with nothing counted is all zeros, and callers get a copy', () => {
    const split = getDispatcherUsageSplit('2026-01-01');
    expect(split.conversations.turns).toBe(0);
    expect(split.background.turns).toBe(0);
    turn(CHAT, 't1', { input: 5 });
    getDispatcherUsageSplit().conversations.input = 1_000;
    expect(getDispatcherUsageSplit().conversations.input).toBe(5);
  });
});
