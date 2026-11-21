import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DELAY_MINUTES } from '../../shared/actions';
import { CHAIN_WINDOW_MS, onAppEvent, publishAppEvent, resetAppEventBus, type AppEvent } from './app-event-bus';
import { beginQuickAgentRun, clearQuickAgentRuns, finishQuickAgentExit, finishQuickAgentRun, knownQuickAgents, noteQuickAgentStop, noteQuickAgentTurn, noteQuickAgentRuntime, peekQuickAgentName, quickRuntimeDisplay, quickRuntimeIsCurrent } from './quick-agent-events';
import type { AgentRegistration } from './agent-registry';

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
  it('peeks display names without expiring retained IDs or hook state', () => {
    const run = beginQuickAgentRun(start); finishQuickAgentRun(run, 'completed');
    expect(peekQuickAgentName('quick', run.finishedAt)).toBe('Review');
    expect(peekQuickAgentName('quick', run.finishedAt! + MAX_DELAY_MINUTES * 60_000 + 1)).toBeUndefined();
    expect(knownQuickAgents(run.finishedAt).get('quick')).toBe(run);
  });
  it('keeps actual created-runtime linkage private and invalidates it on replacement/untrack/nonce changes without a timing heuristic', () => {
    const run = beginQuickAgentRun(start);
    const registration: AgentRegistration = { projectPath: start.projectPath, cwd: '/actual/work', orchestrator: 'codex-cli', runtime: 'pty', nonce: 'PRIVATE_NONCE' };
    let current = true;
    noteQuickAgentRuntime(run, registration, () => current);
    expect(quickRuntimeIsCurrent(run, registration)).toBe(true);
    expect(quickRuntimeIsCurrent(run, { ...registration })).toBe(false);
    expect(quickRuntimeIsCurrent(run, undefined)).toBe(false);
    expect(JSON.stringify(run)).not.toContain('PRIVATE_NONCE');
    expect(quickRuntimeDisplay(run)).toEqual({ provider: 'codex-cli', runtime: 'pty', cwd: '/actual/work' });
    registration.nonce = 'new'; expect(quickRuntimeIsCurrent(run, registration)).toBe(false);
    current = false; expect(quickRuntimeIsCurrent(run, registration)).toBe(false);
    const replacement = beginQuickAgentRun(start); // Same fake clock timestamp, distinct real run object.
    noteQuickAgentRuntime(run, registration, () => true);
    expect(quickRuntimeDisplay(replacement)).toBeUndefined();
    expect(quickRuntimeIsCurrent(run, registration)).toBe(false);
  });
  it('never adopts a late observation for an already failed or replaced launch or a different project', () => {
    const run = beginQuickAgentRun(start);
    const registration: AgentRegistration = { projectPath: '/different', orchestrator: 'codex-cli', runtime: 'headless' };
    noteQuickAgentRuntime(run, registration, () => true);
    expect(quickRuntimeDisplay(run)).toBeUndefined();
    registration.projectPath = start.projectPath;
    finishQuickAgentRun(run, 'failed');
    noteQuickAgentRuntime(run, registration, () => true);
    expect(quickRuntimeDisplay(run)).toBeUndefined();
  });
  it('retains only immutable allowlisted launch display choices, separately from execution and events', () => {
    const input = { ...start, cwd: '/project/work', orchestrator: 'codex-cli', model: 'selected-model', effort: 'high', access: 'ask' as const,
      managedTemplate: { id: 'template', agentName: 'Template agent', addParts: ['part'], removeParts: ['old'] },
      mission: 'PRIVATE_PROMPT', systemPrompt: 'PRIVATE_SYSTEM', mcpConfigs: { server: { token: 'PRIVATE_CREDENTIAL' } } };
    const run = beginQuickAgentRun(input);
    input.managedTemplate.addParts.push('later');
    expect(run.display).toEqual({ cwd: '/project/work', orchestrator: 'codex-cli', model: 'selected-model', effort: 'high', access: 'ask', template: { id: 'template', added: ['part'], removed: ['old'], omitted: 0 } });
    expect(Object.isFrozen(run.display)).toBe(true);
    expect(Object.isFrozen(run.display?.template?.added)).toBe(true);
    expect(JSON.stringify(run)).not.toMatch(/PRIVATE_|agentName/);
    finishQuickAgentRun(run, 'completed');
    expect(run.completion).toBe('completed');
    expect(JSON.stringify(events)).not.toMatch(/selected-model|PRIVATE_|template/);
  });
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
