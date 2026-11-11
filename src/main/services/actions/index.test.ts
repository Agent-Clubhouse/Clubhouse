import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Actions service over a real engine and step runner; everything around it is faked.
const h = vi.hoisted(() => ({
  saved: { actions: [] as unknown[], state: { nextAt: {}, waits: [] } as unknown },
  runs: new Map<string, { actionId: string; startedAt: number }>(),
  deliver: null as unknown as ReturnType<typeof vi.fn>,
  note: null as unknown as ReturnType<typeof vi.fn>,
  clear: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('electron', () => ({ powerMonitor: { on: vi.fn(), removeListener: vi.fn() } }));
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../agent-system', () => ({ isAgentRunning: () => false }));
vi.mock('../agent-runtime', () => ({ getAgentRuntime: () => undefined, isAgentStoppingError: () => false }));
vi.mock('../app-event-bus', () => ({ onAppEvent: () => () => undefined, setAgentChain: vi.fn() }));
vi.mock('../app-event-sources', () => ({ knownAgent: () => undefined, knownAgents: () => new Map() }));
vi.mock('../clubhouse-mcp/binding-manager', () => ({ bindingManager: { getBindingsForAgent: () => [] } }));
vi.mock('../clubhouse-mcp/orchestration-gate', () => ({ isCrossProjectEnabled: () => false, isOrchestrationEnabled: () => false, orchestrationControl: () => undefined }));
vi.mock('../dispatcher/dispatcher-settings', () => ({ isDispatcherEnabled: () => true }));
vi.mock('../clubhouse-mcp/tools/agent-lifecycle', () => ({ sleepAgent: vi.fn(), wakeWiredAgent: vi.fn() }));
vi.mock('../clubhouse-mcp/tools/dispatcher-delivery', () => {
  h.deliver = vi.fn(async () => ({ delivered: true, woke: false }));
  return { deliverToDispatcher: h.deliver, dispatcherInboxId: (id: string) => id };
});
vi.mock('../dispatcher/dispatcher-usage', () => {
  h.note = vi.fn();
  h.clear = vi.fn();
  return { noteDispatcherBackgroundWork: h.note, clearDispatcherBackgroundWork: h.clear };
});
vi.mock('../dispatcher/dispatcher-service', () => ({
  DISPATCHER_NAME: 'Dispatcher',
  getDispatcherAgentId: () => 'disp',
  getDispatcherState: () => ({ config: { name: 'Rosie' } }),
  isDispatcherAgentId: (id: string) => id === 'disp',
}));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../notification-service', () => ({ getSettings: () => ({ enabled: false }), sendNotification: vi.fn() }));
vi.mock('../project-store', () => ({ list: async () => [], onProjectsChanged: () => () => undefined }));
vi.mock('../quick-agent-service', () => ({ startQuickAgent: vi.fn() }));
vi.mock('../agent-grants-service', () => ({ grantsFromFacts: () => [] }));
vi.mock('./actions-store', () => ({
  createActionsStorage: () => ({
    load: () => ({ actions: h.saved.actions, state: h.saved.state }),
    saveActions: (a: unknown[]) => { h.saved.actions = a; },
    saveState: (s: unknown) => { h.saved.state = s; },
  }),
  createRunHistory: () => ({
    put: (run: { id: string; actionId: string; startedAt: number }) => { h.runs.set(run.id, run); },
    list: (id: string) => [...h.runs.values()].filter((r) => r.actionId === id),
  }),
}));

import {
  actionHistory,
  actionsReady,
  createAction,
  ensureAppAction,
  ensureAppSubscription,
  getAction,
  listActions,
  listAppActions,
  observeActions,
  removeAppAction,
  runActionNow,
  setAppActionGate,
  startActions,
  stopActions,
} from './index';
import { ActionError } from '../../../shared/actions';

const message = (text: string) => [{ kind: 'message', agentId: 'disp', text }];
const nightly = { kind: 'schedule', preset: 'daily', cron: '30 3 * * *', missed: 'once' };
const idle = { kind: 'event', event: 'agent.idle', source: { kind: 'agent', agentId: 'disp' }, delayMinutes: 20 } as const;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(async () => {
  h.saved = { actions: [], state: { nextAt: {}, waits: [] } };
  h.runs.clear();
  h.deliver.mockClear();
  h.note.mockClear();
  h.clear.mockClear();
  await startActions();
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  stopActions();
  setAppActionGate('Upkeep', null);
});

describe('Clubhouse’s own actions (#3040)', () => {
  it('are hidden from every list, lookup and history people and agents use', async () => {
    expect(actionsReady()).toBe(true);
    const mine = createAction({ trigger: nightly, steps: [{ kind: 'notify', text: 'hi' }] }, { kind: 'user' });
    const upkeep = ensureAppAction('Upkeep', { trigger: nightly, steps: message('tidy up'), overlap: 'skip', enabled: true });
    const sub = ensureAppSubscription('Idle upkeep', { trigger: idle, note: 'tidy up', enabled: true });
    expect(sub.subscription).toBe(true);
    expect(listActions().map((a) => a.id)).toEqual([mine.id]);
    expect(getAction(upkeep.id)).toBeUndefined();
    expect(getAction(sub.id)).toBeUndefined();
    expect(listAppActions().map((a) => a.name).sort()).toEqual(['Idle upkeep', 'Upkeep']);
    expect(() => runActionNow(upkeep.id)).toThrow(ActionError);
    expect(actionHistory(upkeep.id)).toEqual([]);
  });

  it('ensuring the same definition again changes nothing; a new one replaces it in place', () => {
    const first = ensureAppAction('Upkeep', { trigger: nightly, steps: message('tidy up'), overlap: 'skip', enabled: true });
    const again = ensureAppAction('Upkeep', { trigger: nightly, steps: message('tidy up'), overlap: 'skip', enabled: true });
    expect(again).toBe(first);
    const changed = ensureAppAction('Upkeep', { trigger: { ...nightly, cron: '0 4 * * *' }, steps: message('tidy up'), overlap: 'skip', enabled: true });
    expect(changed.id).toBe(first.id);
    expect(changed.trigger).toMatchObject({ cron: '0 4 * * *' });

    const sub = ensureAppSubscription('Idle upkeep', { trigger: idle, note: 'tidy up', enabled: true });
    expect(ensureAppSubscription('Idle upkeep', { trigger: idle, note: 'tidy up', enabled: true })).toBe(sub);
    const longer = ensureAppSubscription('Idle upkeep', { trigger: { ...idle, delayMinutes: 120 }, note: 'tidy up', enabled: true });
    expect(longer.id).toBe(sub.id);
    expect(longer.subscription).toBe(true);
    expect(removeAppAction('Idle upkeep')).toBe(true);
    expect(removeAppAction('Idle upkeep')).toBe(false);
  });

  it('runs the gate before messaging the Dispatcher, and counts the turn as background work', async () => {
    const gate = vi.fn(async () => ({ send: 'Check topics/a.md.' }));
    setAppActionGate('Upkeep', gate);
    const upkeep = ensureAppAction('Upkeep', { trigger: nightly, steps: message('fallback'), overlap: 'skip', enabled: true });
    await triggerHidden(upkeep.id);
    expect(gate).toHaveBeenCalledWith({ actionId: upkeep.id, name: 'Upkeep' });
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.deliver.mock.calls[0][0]).toMatchObject({ targetId: 'disp', text: expect.stringContaining('Check topics/a.md.'), fromAction: true });
    expect(h.note).toHaveBeenCalledWith('disp');
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('sends nothing when the gate says there is nothing to do', async () => {
    setAppActionGate('Upkeep', async () => ({ skip: 'Nothing to check.' }));
    const upkeep = ensureAppAction('Upkeep', { trigger: nightly, steps: message('fallback'), overlap: 'skip', enabled: true });
    const outcomes = watchRuns();
    await triggerHidden(upkeep.id);
    expect(h.deliver).not.toHaveBeenCalled();
    expect(h.note).not.toHaveBeenCalled();
    // A skipped message is a finished run, not a failure.
    expect(outcomes).toEqual(['done']);
  });

  it('forgets the background mark when the message couldn’t be delivered', async () => {
    h.deliver.mockResolvedValueOnce({ delivered: false, text: 'Rosie is turned off.' });
    const upkeep = ensureAppAction('Upkeep', { trigger: nightly, steps: message('tidy up'), overlap: 'skip', enabled: true });
    const outcomes = watchRuns();
    await triggerHidden(upkeep.id);
    expect(h.note).toHaveBeenCalledWith('disp');
    expect(h.clear).toHaveBeenCalledWith('disp');
    expect(outcomes).toEqual(['failed']);
  });

  it('a person’s action that messages the Dispatcher is not background work', async () => {
    const mine = createAction({ trigger: nightly, steps: message('hello') }, { kind: 'user' });
    runActionNow(mine.id);
    await flush();
    expect(h.deliver).toHaveBeenCalledTimes(1);
    expect(h.note).not.toHaveBeenCalled();
  });

  it('keeps queued Dispatcher acceptance in the completed run history', async () => {
    h.deliver.mockResolvedValueOnce({ delivered: true, woke: false, delivery: 'queued' });
    const mine = createAction({ trigger: nightly, steps: message('hello') }, { kind: 'user' });
    runActionNow(mine.id);
    await flush();
    expect(actionHistory(mine.id)).toEqual([
      expect.objectContaining({
        outcome: 'done',
        steps: [expect.objectContaining({ detail: "Queued for Rosie's next turn", delivery: 'queued' })],
      }),
    ]);
  });
});

/** Run outcomes as the engine reports them to telemetry, which sees hidden runs too. */
function watchRuns(): string[] {
  const outcomes: string[] = [];
  const stop = observeActions((o) => { if (o.type === 'run') outcomes.push(o.outcome); });
  stops.push(stop);
  return outcomes;
}

const stops: Array<() => void> = [];

/**
 * Fire a hidden action as its trigger would. Hidden actions can't be run by
 * hand (runActionNow refuses them), so this flips the one in storage to a
 * one-time trigger due now and restarts the service, which runs it at launch.
 */
async function triggerHidden(id: string): Promise<void> {
  stopActions();
  h.saved.actions = (h.saved.actions as Array<{ id: string; trigger: unknown }>).map((a) => (a.id === id ? { ...a, trigger: { kind: 'once', at: Date.now() - 1000 } } : a));
  await startActions();
  await flush();
}
