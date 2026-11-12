import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent, AppEventInput } from '../app-event-bus';

// The Actions service over a real engine and step runner; everything around it is faked.
const h = vi.hoisted(() => ({
  saved: { actions: [] as unknown[], state: { nextAt: {}, waits: [] } as unknown },
  runs: new Map<string, { actionId: string; startedAt: number }>(),
  deliver: null as unknown as ReturnType<typeof vi.fn>,
  note: null as unknown as ReturnType<typeof vi.fn>,
  clear: null as unknown as ReturnType<typeof vi.fn>,
  events: new Set<(event: AppEvent) => void>(),
  focused: true,
  idle: 0,
  sleepSeconds: 0,
  known: new Map<string, { projectPath: string; name: string; parentAgentId?: string }>(),
  dispatcherName: 'Rosie',
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    app: new EventEmitter(),
    powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleTime: vi.fn(() => h.idle) }),
    BrowserWindow: { getFocusedWindow: () => h.focused ? {} : null },
  };
});
vi.mock('os', () => ({ uptime: () => performance.now() / 1000 + h.sleepSeconds }));
vi.mock('../../util/ipc-broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
vi.mock('../agent-system', () => ({ isAgentRunning: () => false }));
vi.mock('../annex-device-presence', () => ({ devicePresenceOnline: () => undefined }));
vi.mock('../annex-devices', () => ({ listDevices: () => [] }));
vi.mock('../agent-runtime', () => ({ getAgentRuntime: () => undefined, isAgentStoppingError: () => false }));
vi.mock('../app-event-bus', () => ({
  onAppEvent: (fn: (event: AppEvent) => void) => { h.events.add(fn); return () => { h.events.delete(fn); }; },
  publishAppEvent: vi.fn((event: AppEventInput) => { for (const fn of h.events) fn({ at: Date.now(), ...event } as AppEvent); }),
  setAgentChain: vi.fn(),
}));
vi.mock('../app-event-sources', () => ({ knownAgent: (id: string) => h.known.get(id), knownAgents: () => h.known }));
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
vi.mock('../dispatcher/dispatcher-service', async () => ({
  DISPATCHER_NAME: 'Dispatcher',
  getDispatcherAgentId: () => 'disp',
  getDispatcherState: () => ({ config: { name: 'Rosie' } }),
  dispatcherDisplayName: (role: 'chat' | 'work' = 'chat') => dispatcherRoleDisplayName(role, h.dispatcherName),
  isDispatcherAgentId: (id: string) => id === 'disp',
  isDispatcherIdentityAgentId: (id: string) => id === 'disp' || id === 'disp-chat',
  isDispatcherPath: (p?: string) => p === 'dispatcher-folder',
}));
import { dispatcherRoleDisplayName } from '../../../shared/dispatcher-name';
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
    list: (id?: string) => [...h.runs.values()].filter((r) => id === undefined || r.actionId === id),
    flush: async () => {},
  }),
}));

import {
  actionHistory,
  actionNames,
  actionUsage,
  actionsReady,
  createAction,
  deleteAction,
  ensureAppAction,
  ensureAppSubscription,
  getAction,
  listActions,
  listAppActions,
  observeActions,
  removeAppAction,
  runActionNow,
  recordExternalRun,
  setAppActionGate,
  setActionEnabled,
  startActions,
  stopActions,
} from './index';
import { ActionError } from '../../../shared/actions';
import { app, powerMonitor } from 'electron';
import { publishAppEvent } from '../app-event-bus';

const message = (text: string) => [{ kind: 'message', agentId: 'disp', text }];
const nightly = { kind: 'schedule', preset: 'daily', cron: '30 3 * * *', missed: 'once' };
const idle = { kind: 'event', event: 'agent.idle', source: { kind: 'agent', agentId: 'disp' }, delayMinutes: 20 } as const;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

it('retains one external Annex receipt across engine restart without creating executable work', async () => {
  const at = Date.now();
  const receipt = {
    id: 'annex-delivery:c1', actionId: 'annex-delivery:c1', externalSource: 'annex_delivery' as const,
    owner: { kind: 'agent' as const, agentId: 'sender' }, trigger: { kind: 'manual' as const, at },
    chain: [], startedAt: at, endedAt: at, outcome: 'expired' as const, reason: 'Delivery expired', steps: [],
  };
  await recordExternalRun(receipt);
  await recordExternalRun(receipt);
  expect(actionHistory(receipt.actionId)).toHaveLength(1);
  expect(listActions()).toEqual([]);
  expect(() => runActionNow(receipt.actionId)).toThrow('No action');
  stopActions();
  await startActions();
  expect(actionHistory(receipt.actionId)).toMatchObject([receipt]);
});

it('includes retained runs after an Action is deleted from the saved list', async () => {
  const action = createAction({ name: 'Once', trigger: { kind: 'once', at: Date.now() + 60_000 }, steps: [{ kind: 'notify', text: 'Ready' }] }, { kind: 'user' });
  runActionNow(action.id);
  await flush();
  deleteAction(action.id);
  expect(getAction(action.id)).toBeUndefined();
  expect(actionUsage()).toMatchObject([{ owner: { kind: 'user' }, actions: [], runs24h: 1, runs7d: 1 }]);
});

beforeEach(async () => {
  h.saved = { actions: [], state: { nextAt: {}, waits: [] } };
  h.runs.clear();
  h.known.clear();
  h.dispatcherName = 'Rosie';
  h.deliver.mockClear();
  h.note.mockClear();
  h.clear.mockClear();
  h.focused = true;
  h.idle = 0;
  h.sleepSeconds = 0;
  vi.mocked(powerMonitor.getSystemIdleTime).mockClear();
  vi.mocked(publishAppEvent).mockClear();
  await startActions();
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  stopActions();
  setAppActionGate('Upkeep', null);
});

it('excludes both Dispatcher identities and owned helper ancestry from any-agent turn batches', async () => {
  vi.useFakeTimers();
  try {
    h.known.set('lead', { projectPath: 'project-folder', name: 'Lead' });
    h.known.set('disp-chat', { projectPath: 'dispatcher-folder', name: 'Chat' });
    h.known.set('helper', { projectPath: 'project-folder', name: 'Helper', parentAgentId: 'disp' });
    h.known.set('nested', { projectPath: 'project-folder', name: 'Nested', parentAgentId: 'helper' });
    h.known.set('internal', { projectPath: 'dispatcher-folder', name: 'Internal' });
    const a = createAction({
      trigger: { kind: 'event', event: 'agent.turn_ended', source: { kind: 'any' }, coalesceSeconds: 10 },
      steps: [{ kind: 'notify', text: 'Turns finished' }],
    }, { kind: 'user' });
    for (const agentId of ['disp', 'disp-chat', 'helper', 'nested', 'internal', 'lead']) {
      publishAppEvent({ type: 'turn.ended', agentId, via: 'chat', outcome: 'done' });
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(actionHistory(a.id)).toHaveLength(1);
    expect(actionHistory(a.id)[0].trigger).toMatchObject({ agentIds: ['lead'], detail: 'Finished turns: Lead' });
  } finally {
    stopActions();
    vi.useRealTimers();
  }
});

it.each(['Dispatcher', 'Rosie'])('labels real Action targets as controller with base name %s, leaving ownership and delivery IDs unchanged', async (name) => {
  h.dispatcherName = name;
  h.known.set('disp', { projectPath: 'dispatcher-folder', name });
  h.known.set('disp-chat', { projectPath: 'dispatcher-chat-folder', name });
  h.known.set('ordinary', { projectPath: 'project-folder', name: 'Builder' });
  expect(actionNames().agent('disp')).toBe('Dispatcher controller');
  expect(actionNames().agent('disp-chat')).toBe(name);
  expect(actionNames().agent('ordinary')).toBe('Builder');
  const action = createAction({ trigger: nightly, steps: message('hello') }, { kind: 'user' });
  runActionNow(action.id);
  await flush();
  expect(h.deliver).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'disp', targetName: 'Dispatcher controller' }));
  expect(getAction(action.id)).toMatchObject({ owner: { kind: 'user' }, steps: [{ kind: 'message', agentId: 'disp', text: 'hello' }] });
  expect(actionHistory(action.id)[0]).toMatchObject({ outcome: 'done' });
});

it('wires Electron presence only for enabled return actions and persists use without publishing absence details', async () => {
  vi.useFakeTimers();
  try {
    expect(powerMonitor.listenerCount('lock-screen')).toBe(0);
    expect(app.listenerCount('browser-window-focus')).toBe(0);
    expect(powerMonitor.getSystemIdleTime).not.toHaveBeenCalled();
    const a = createAction({
      trigger: { kind: 'event', event: 'app.returned', source: { kind: 'app' }, absenceMinutes: 5 },
      steps: [{ kind: 'notify', text: 'Welcome back' }],
    }, { kind: 'user' });
    expect(powerMonitor.listenerCount('lock-screen')).toBe(1);
    expect((h.saved.state as { lastUse?: number }).lastUse).toBe(Date.now());
    powerMonitor.emit('lock-screen');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    powerMonitor.emit('unlock-screen');
    app.emit('browser-window-focus');
    await flush();
    expect(publishAppEvent).toHaveBeenCalledExactlyOnceWith({ type: 'app.returned', actionIds: [a.id] });
    expect(getAction(a.id)?.runsUsed).toBe(1);
    setActionEnabled(a.id, false);
    expect(powerMonitor.listenerCount('lock-screen')).toBe(0);
    expect(app.listenerCount('browser-window-focus')).toBe(0);
  } finally {
    stopActions();
    vi.useRealTimers();
  }
});

it.each([-1, 1])('ignores a %i-hour wall-clock adjustment during a short lock', async (direction) => {
  vi.useFakeTimers();
  try {
    createAction({
      trigger: { kind: 'event', event: 'app.returned', source: { kind: 'app' }, absenceMinutes: 5 },
      steps: [{ kind: 'notify', text: 'Welcome back' }],
    }, { kind: 'user' });
    powerMonitor.emit('lock-screen');
    vi.setSystemTime(Date.now() + direction * 60 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    powerMonitor.emit('unlock-screen');
    expect(publishAppEvent).not.toHaveBeenCalled();
    powerMonitor.emit('lock-screen');
    vi.setSystemTime(Date.now() + direction * 60 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    powerMonitor.emit('unlock-screen');
    expect(publishAppEvent).toHaveBeenCalledTimes(1);
  } finally {
    stopActions();
    vi.useRealTimers();
  }
});

it.each([-1, 1])('never replays persisted last use %i day from launch or delays a newly observed absence', async (direction) => {
  vi.useFakeTimers();
  try {
    const a = createAction({
      trigger: { kind: 'event', event: 'app.returned', source: { kind: 'app' }, absenceMinutes: 5 },
      steps: [{ kind: 'notify', text: 'Welcome back' }],
    }, { kind: 'user' });
    stopActions();
    h.saved.state = { nextAt: {}, waits: [], lastUse: Date.now() + direction * 24 * 60 * 60_000 };
    h.focused = false;
    await startActions();
    expect(publishAppEvent).not.toHaveBeenCalled();
    powerMonitor.emit('suspend');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    powerMonitor.emit('resume');
    h.focused = true;
    app.emit('browser-window-focus');
    expect(publishAppEvent).toHaveBeenCalledExactlyOnceWith({ type: 'app.returned', actionIds: [a.id] });
    expect((h.saved.state as { lastUse?: number }).lastUse).toBe(Date.now());
  } finally {
    stopActions();
    vi.useRealTimers();
  }
});

it.each([1, 5])('measures %i minutes of suspend without running polling timers', (minutes) => {
  vi.useFakeTimers();
  try {
    const a = createAction({
      trigger: { kind: 'event', event: 'app.returned', source: { kind: 'app' }, absenceMinutes: 5 },
      steps: [{ kind: 'notify', text: 'Welcome back' }],
    }, { kind: 'user' });
    powerMonitor.emit('suspend');
    h.sleepSeconds += minutes * 60;
    vi.setSystemTime(Date.now() + minutes * 60_000);
    powerMonitor.emit('resume');
    app.emit('browser-window-focus');
    if (minutes < 5) expect(publishAppEvent).not.toHaveBeenCalled();
    else expect(publishAppEvent).toHaveBeenCalledExactlyOnceWith({ type: 'app.returned', actionIds: [a.id] });
  } finally {
    stopActions();
    vi.useRealTimers();
  }
});

it('cleans up presence listeners through repeated enable, disable and deletion', () => {
  for (let i = 0; i < 10; i++) {
    const a = createAction({
      trigger: { kind: 'event', event: 'app.returned', source: { kind: 'app' } },
      steps: [{ kind: 'notify', text: 'Welcome back' }],
    }, { kind: 'user' });
    setActionEnabled(a.id, false);
    setActionEnabled(a.id, true);
    expect(powerMonitor.listenerCount('lock-screen')).toBe(1);
    expect(powerMonitor.listenerCount('resume')).toBe(2);
    expect(app.listenerCount('browser-window-focus')).toBe(1);
    deleteAction(a.id);
    for (const event of ['lock-screen', 'unlock-screen', 'suspend']) expect(powerMonitor.listenerCount(event)).toBe(0);
    expect(powerMonitor.listenerCount('resume')).toBe(1);
    expect(app.listenerCount('browser-window-focus')).toBe(0);
    expect(app.listenerCount('browser-window-blur')).toBe(0);
  }
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
        steps: [expect.objectContaining({ detail: "Queued for Dispatcher controller's next turn", delivery: 'queued' })],
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
