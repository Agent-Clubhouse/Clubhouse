import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DELAY_MINUTES } from '../../shared/actions';
import { CHAIN_WINDOW_MS, onAppEvent, publishAppEvent, resetAppEventBus, type AppEvent } from './app-event-bus';
import { beginQuickAgentRun, clearQuickAgentRuns, finishQuickAgentExit, finishQuickAgentRun, knownQuickAgents, noteQuickAgentStop, noteQuickAgentTurn } from './quick-agent-events';

let events: AppEvent[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  events = [];
  onAppEvent((event) => events.push(event));
});
afterEach(() => {
  clearQuickAgentRuns();
  resetAppEventBus();
  vi.useRealTimers();
});

const start = { agentId: 'quick', name: 'Review', projectPath: '/project' };

describe('quick run completion events', () => {
  it('publishes metadata once with no prompt, output or error content', () => {
    const run = beginQuickAgentRun({ ...start, parentAgentId: 'lead', quickOwner: { kind: 'action', actionId: 'review' }, chain: ['earlier', 'review'] });
    vi.setSystemTime(2400);
    finishQuickAgentRun(run, 'completed');
    finishQuickAgentExit('quick', 1);
    finishQuickAgentRun(run, 'failed');
    expect(events).toEqual([{
      type: 'agent.quick_finished', at: 2400, agentId: 'quick', name: 'Review', parentAgentId: 'lead',
      projectPath: '/project', durationMs: 1400, outcome: 'completed',
      owner: { kind: 'action', actionId: 'review' }, chain: ['earlier', 'review'],
    }]);
  });

  it.each([
    [0, undefined, false, 'completed'],
    [1, undefined, false, 'failed'],
    [0, 'failed', false, 'failed'],
    [0, 'interrupted', false, 'cancelled'],
    [1, undefined, true, 'cancelled'],
  ] as const)('classifies quick process completion %#', (code, turn, stopped, outcome) => {
    beginQuickAgentRun(start);
    if (turn) noteQuickAgentTurn('quick', turn);
    if (stopped) noteQuickAgentStop('quick');
    finishQuickAgentExit('quick', code);
    finishQuickAgentExit('quick', code);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome, owner: { kind: 'user' } });
  });

  it('keeps the Action chain through a run longer than the ordinary chain window', () => {
    const run = beginQuickAgentRun({ ...start, chain: ['review'], quickOwner: { kind: 'action', actionId: 'review' } });
    vi.setSystemTime(1000 + CHAIN_WINDOW_MS + 1);
    publishAppEvent({ type: 'turn.ended', agentId: 'quick', via: 'headless', outcome: 'completed' });
    finishQuickAgentRun(run, 'completed');
    expect(events.map((event) => event.chain)).toEqual([['review'], ['review']]);
  });

  it('cancels the old run once on replacement without changing the new run outcome', () => {
    const old = beginQuickAgentRun(start);
    const next = beginQuickAgentRun({ ...start, name: 'Replacement', quickOwner: { kind: 'agent', agentId: 'lead' } });
    finishQuickAgentRun(old, 'failed');
    finishQuickAgentRun(next, 'completed');
    expect(events).toMatchObject([
      { outcome: 'cancelled', name: 'Review', owner: { kind: 'user' } },
      { outcome: 'completed', name: 'Replacement', owner: { kind: 'agent', agentId: 'lead' } },
    ]);
    expect(events).toHaveLength(2);
  });

  it('retains finished scope through the maximum delayed rights check, then expires it', () => {
    const run = beginQuickAgentRun(start);
    finishQuickAgentRun(run, 'completed');
    vi.setSystemTime(Date.now() + MAX_DELAY_MINUTES * 60_000);
    expect(knownQuickAgents().has('quick')).toBe(true);
    vi.setSystemTime(Date.now() + 1);
    expect(knownQuickAgents().has('quick')).toBe(false);
  });

  it('expires finished identities without another lookup while retaining live runs', () => {
    const finished = beginQuickAgentRun(start);
    const identities = knownQuickAgents();
    finishQuickAgentRun(finished, 'completed');
    vi.advanceTimersByTime(60_000);
    const later = beginQuickAgentRun({ ...start, agentId: 'later' });
    finishQuickAgentRun(later, 'completed');
    beginQuickAgentRun({ ...start, agentId: 'live' });

    vi.advanceTimersByTime(MAX_DELAY_MINUTES * 60_000 - 60_000 + 1);
    expect(identities.has('quick')).toBe(false);
    expect(identities.has('later')).toBe(true);
    expect(identities.has('live')).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(identities.has('later')).toBe(false);
    expect(identities.has('live')).toBe(true);
    clearQuickAgentRuns();
    expect(vi.getTimerCount()).toBe(0);
  });
});
