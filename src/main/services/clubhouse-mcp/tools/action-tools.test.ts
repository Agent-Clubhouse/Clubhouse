import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Action, ActionOwner, ActionRun } from '../../../../shared/actions';
import type { ActionsEngine } from '../../actions/engine';
import type { AccessLevel } from '../../../../shared/agent-access';

// What the gate decides is covered in mcp-call-gate.test.ts; here every caller is open and its kind is set per test.
const h = vi.hoisted(() => ({
  callerKinds: new Map<string, string>(),
  dispatchers: new Set<string>(),
  trackedDispatchers: new Set<string>(),
  /** agent id to name, project and parent */
  known: new Map<string, { projectPath: string; projectId: string; name: string; parentAgentId?: string }>(),
  /** wires: "from>to" */
  wires: new Set<string>(),
  /** agent id to Access level; unset is Full access */
  access: new Map<string, string>(),
  activityModes: new Map<string, 'allow' | 'ask' | 'off'>(),
  engine: null as unknown,
  history: new Map<string, unknown>(),
  /** Steps the engine ran, in order. */
  stepCalls: [] as Array<{ step: unknown; ctx: unknown }>,
  unavailable: false,
  build: null as unknown as () => void,
}));

vi.mock('../mcp-call-gate', async (original) => ({
  ...await original<typeof import('../mcp-call-gate')>(),
  mcpCallAccess: () => 'open',
  mcpCallerKind: (id: string) => h.callerKinds.get(id),
}));
vi.mock('../dispatcher-gate', async (original) => ({
  ...await original<typeof import('../dispatcher-gate')>(),
  isDispatcherAgent: (id: string) => h.dispatchers.has(id),
  isTrackedDispatcher: (id: string) => h.dispatchers.has(id) || h.trackedDispatchers.has(id),
}));
vi.mock('../../app-event-sources', () => ({ knownAgent: (id: string) => h.known.get(id) }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../dispatcher/dispatcher-action-summary', () => ({ showDispatcherActionSummary: vi.fn(async () => undefined) }));

// The Actions service over a real engine with the real grant rights, and
// facts from the table above. Mirrors src/main/services/actions/index.ts.
vi.mock('../../actions', async () => {
  const shared = await import('../../../../shared/actions');
  const { ActionsEngine } = await import('../../actions/engine');
  const { createGrantRights } = await import('../../actions/rights');
  const { defaultGrants } = await import('../../../../shared/default-grants');
  const { applyGrantChanges } = await import('../../../../shared/agent-grant-changes');
  const { matchProjectRef } = await import('../../actions/project-ref');
  const projects = [
    { id: 'proj-1', name: 'web', path: 'web-root' },
    { id: 'proj-2', name: 'api', path: 'api-root' },
    { id: 'proj-3', name: 'api', path: 'api-copy' },
  ];
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name;
  const agentName = (id: string) => h.known.get(id)?.name;
  const agentProjectId = (id: string) => h.known.get(id)?.projectId;
  h.build = () => {
    h.history.clear();
    h.stepCalls.length = 0;
    h.engine = new ActionsEngine({
      clock: { now: () => Date.now(), setTimeout: () => 0, clearTimeout: () => undefined },
      storage: { load: () => ({ actions: [], state: { nextAt: {}, waits: [] } }), saveActions: () => undefined, saveState: () => undefined },
      history: {
        put: (run) => { h.history.set(run.id, run); },
        list: (id) => [...(h.history.values() as Iterable<ActionRun>)].filter((r) => r.actionId === id),
      },
      facts: {
        // The Dispatcher counts as an agent, as in the service, so its subscriptions can message it.
        agentExists: (id) => h.known.has(id) || h.dispatchers.has(id),
        isRunning: () => false,
        agentName: (id) => agentName(id) ?? (h.dispatchers.has(id) ? 'Dispatcher' : undefined),
        agentProjectId,
        projectName,
        projectIdForPath: (p) => projects.find((x) => x.path === p)?.id,
        repoOwner: (p) => ({ projectId: projects.find((x) => x.path === p)?.id }),
        dispatcherAgentId: () => (h.dispatchers.has('dispatcher') ? 'dispatcher' : undefined),
      },
      steps: { run: async (step, ctx) => { h.stepCalls.push({ step, ctx }); return { kind: step.kind, outcome: 'done', detail: 'ok' }; } },
      rights: createGrantRights({
        agentName,
        parentOf: (id) => h.known.get(id)?.parentAgentId,
        isConnected: (from, to) => h.wires.has(`${from}>${to}`),
        agentProjectId,
        dispatcherAgentId: () => (h.dispatchers.has('dispatcher') ? 'dispatcher' : undefined),
        canStartAgents: () => true,
        agentAccess: (id) => (h.access.get(id) ?? 'full_access') as AccessLevel,
        // The default permissions for what each agent is; every agent here may start helpers.
        grantsOf: (id) => {
          const mode = h.activityModes.get(id);
          return applyGrantChanges(defaultGrants({
            dispatcher: h.dispatchers.has(id),
            helper: !!h.known.get(id)?.parentAgentId,
            orchestrates: !h.dispatchers.has(id),
            crossProject: false,
          }), { changes: mode ? [{ action: 'agent.watch', target: { kind: 'app' }, mode }] : [] });
        },
        agentProjectPath: (id) => projects.find((p) => p.id === agentProjectId(id))?.path,
        projectPath: (id) => projects.find((p) => p.id === id)?.path,
      }),
    });
  };
  const e = () => {
    if (h.unavailable) throw new shared.ActionError('unavailable', 'Actions are still starting. Try again in a moment.');
    return h.engine as ActionsEngine;
  };
  const view = (a: Action) => ({ ...a, running: false, lastRun: e().history(a.id).sort((x, y) => y.startedAt - x.startedAt)[0] });
  const visible = (id: string) => {
    const a = e().get(id);
    if (!a || a.owner.kind === 'app') throw new shared.ActionError('not_found', 'No action with that id.');
    return a;
  };
  return {
    listActions: vi.fn(() => e().list().filter((a) => a.owner.kind !== 'app').map(view)),
    getAction: vi.fn((id: string) => { const a = e().get(id); return a && a.owner.kind !== 'app' ? view(a) : undefined; }),
    createAction: vi.fn((input: unknown, owner: ActionOwner) => view(e().create(input, owner))),
    subscribe: vi.fn((input: unknown, owner: ActionOwner) => view(e().subscribe(input, owner))),
    updateAction: vi.fn((id: string, input: unknown) => { visible(id); return view(e().update(id, input)); }),
    setActionEnabled: vi.fn((id: string, enabled: boolean) => { visible(id); return view(e().setEnabled(id, enabled)); }),
    deleteAction: vi.fn((id: string) => { visible(id); e().remove(id); }),
    runActionNow: vi.fn((id: string) => { visible(id); return { runId: e().runNow(id) }; }),
    actionHistory: vi.fn((id: string, reader?: ActionOwner) => (e().get(id)?.owner.kind === 'app' ? [] : e().history(id, reader).sort((x, y) => y.startedAt - x.startedAt))),
    canWatchAgentActivity: (reader: ActionOwner) => e().canWatchAgentActivity(reader),
    actionNames: () => ({ agent: agentName, project: projectName }),
    projectIdOfAgent: agentProjectId,
    findProjectId: (ref: string, usable: (id: string) => boolean = () => true) =>
      matchProjectRef(projects.filter((p) => usable(p.id)), ref, (a, b) => a === b),
  };
});

import * as actions from '../../actions';
import { ACTION_TOOL_PERMISSIONS, actionScope, registerActionTools } from './action-tools';
import { callTool, getScopedToolList, isGlobalTool, _resetForTesting } from '../tool-registry';
import { agentRegistry } from '../../agent-registry';
import { showDispatcherActionSummary } from '../../dispatcher/dispatcher-action-summary';

const engine = () => h.engine as ActionsEngine;
const NOTIFY = { kind: 'notify', text: 'Stand-up time' };
const DAILY = { kind: 'schedule', preset: 'daily', cron: '0 9 * * *' };
const ids: Record<string, string> = {};

function seed(key: string, owner: ActionOwner): void {
  ids[key] = engine().create({ name: `Action ${key}`, trigger: DAILY, steps: [{ kind: 'notify', text: 'hi' }] }, owner).id;
}

async function call(caller: string, tool: string, args: Record<string, unknown> = {}) {
  const result = await callTool(caller, tool, args);
  const text = result.content[0].text ?? '';
  let body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { body = JSON.parse(text); } catch { body = { text }; }
  return { isError: !!result.isError, body };
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('action tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    h.callerKinds.clear();
    h.access.clear();
    h.activityModes.clear();
    h.dispatchers.clear();
    h.trackedDispatchers.clear();
    h.known.clear();
    h.wires.clear();
    h.unavailable = false;
    // Two durable agents in web, a helper of the first, one agent in api, and the Dispatcher.
    h.callerKinds.set('agent-a', 'durable').set('agent-b', 'durable').set('agent-c', 'durable').set('helper-a', 'helper').set('quick-1', 'quick');
    h.known.set('agent-a', { projectPath: 'web-root', projectId: 'proj-1', name: 'release-lead' });
    h.known.set('agent-b', { projectPath: 'web-root', projectId: 'proj-1', name: 'qa' });
    h.known.set('agent-c', { projectPath: 'api-root', projectId: 'proj-2', name: 'api-lead' });
    h.known.set('helper-a', { projectPath: 'web-root', projectId: 'proj-1', name: 'helper', parentAgentId: 'agent-a' });
    h.dispatchers.add('dispatcher');
    h.wires.add('dispatcher>agent-a').add('dispatcher>agent-b');
    h.build();
    seed('own-a', { kind: 'agent', agentId: 'agent-a' });
    seed('own-b', { kind: 'agent', agentId: 'agent-b' });
    seed('by-user', { kind: 'user' });
    seed('by-dispatcher', { kind: 'dispatcher' });
    seed('hidden', { kind: 'app' });
    registerActionTools();
  });

  it('shows successful Dispatcher creates, changes and subscriptions, but not other callers or refusals', async () => {
    const created = await call('dispatcher', 'create_action', { name: 'Morning', trigger: DAILY, steps: [NOTIFY] });
    expect(showDispatcherActionSummary).toHaveBeenCalledWith(expect.objectContaining({ id: created.body.action.id, name: 'Morning', enabled: true }), expect.anything());
    await call('dispatcher', 'update_action', { id: created.body.action.id, enabled: false });
    expect(showDispatcherActionSummary).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }), expect.anything());
    await call('dispatcher', 'subscribe', { event: 'agent.slept', source: { kind: 'agent', agentId: 'agent-a' } });
    expect(showDispatcherActionSummary).toHaveBeenCalledTimes(3);
    await call('agent-a', 'create_action', { trigger: DAILY, steps: [NOTIFY] });
    await call('dispatcher', 'create_action', { steps: [] });
    await call('dispatcher', 'list_actions');
    expect(showDispatcherActionSummary).toHaveBeenCalledTimes(3);
  });

  it('returns a successful change even if its chat receipt fails', async () => {
    vi.mocked(showDispatcherActionSummary).mockRejectedValueOnce(new Error('Transcript unavailable'));
    const result = await call('dispatcher', 'create_action', { name: 'Morning', trigger: DAILY, steps: [NOTIFY] });
    expect(result.isError).toBe(false);
    expect(engine().get(result.body.action.id)?.name).toBe('Morning');
    expect(engine().list().filter((a) => a.name === 'Morning')).toHaveLength(1);
  });

  it('requires an activity grant and round-trips any-agent windows through every MCP surface', async () => {
    const trigger = { kind: 'event', event: 'agent.turn_ended', source: { kind: 'any' }, coalesceSeconds: 15 };
    h.activityModes.set('dispatcher', 'ask');
    const refused = await call('dispatcher', 'create_action', { trigger, steps: [NOTIFY] });
    expect(refused).toMatchObject({ isError: true, body: { error: { code: 'not_allowed', message: expect.stringContaining('agent.watch') } } });
    expect(await call('agent-a', 'subscribe', { event: 'agent.turn_ended', source: { kind: 'any' } })).toMatchObject({
      isError: true, body: { text: expect.stringContaining('agent.watch') },
    });
    h.activityModes.delete('dispatcher');
    const created = await call('dispatcher', 'create_action', { trigger, steps: [NOTIFY] });
    expect(created).toMatchObject({ isError: false, body: { action: { trigger } } });
    const id = created.body.action.id;
    const updatedTrigger = { ...trigger, coalesceSeconds: 10 };
    expect((await call('dispatcher', 'update_action', { id, trigger: updatedTrigger })).body.action.trigger).toEqual(updatedTrigger);
    const listed = await call('dispatcher', 'list_actions');
    expect(listed.body.actions.find((a: Action) => a.id === id).trigger).toEqual(updatedTrigger);
    const subscribed = await call('dispatcher', 'subscribe', { event: 'agent.turn_failed', source: { kind: 'any' }, coalesceSeconds: 20 });
    expect(subscribed).toMatchObject({ isError: false, body: { action: { subscription: true, trigger: { coalesceSeconds: 20, source: { kind: 'any' } } } } });
    const invalid = await call('dispatcher', 'create_action', { trigger: { ...trigger, delayMinutes: 1 }, steps: [NOTIFY] });
    expect(invalid.body.error.code).toBe('invalid_input');
  });

  it('rechecks the real activity grant when buffered events run, without exposing names after revocation', async () => {
    vi.useFakeTimers();
    try {
      engine().start();
      const result = await call('dispatcher', 'subscribe', { event: 'agent.turn_ended', source: { kind: 'any' }, coalesceSeconds: 10 });
      engine().handleEvent({ type: 'turn.ended', agentId: 'agent-a', via: 'chat', outcome: 'done', at: Date.now() });
      h.activityModes.set('dispatcher', 'off');
      vi.setSystemTime(Date.now() + 10_000);
      engine().tick();
      await flush();
      expect(h.stepCalls).toHaveLength(0);
      expect(engine().get(result.body.action.id)?.runsUsed).toBeUndefined();
      expect(JSON.stringify(engine().history(result.body.action.id))).not.toContain('release-lead');
    } finally {
      engine().stop();
      vi.useRealTimers();
    }
  });

  it('filters grouped lastRun and history for each reader, including changed and deleted actions after revocation', async () => {
    vi.useFakeTimers();
    try {
      engine().start();
      const a = engine().create({
        name: 'Watch turns',
        trigger: { kind: 'event', event: 'agent.turn_failed', source: { kind: 'any' }, coalesceSeconds: 10 },
        steps: [NOTIFY],
      }, { kind: 'user' });
      for (const agentId of ['agent-b', 'agent-c']) {
        engine().handleEvent({ type: 'turn.ended', agentId, via: 'chat', outcome: 'failed', at: Date.now() });
      }
      vi.setSystemTime(Date.now() + 10_000);
      engine().tick();
      await flush();
      expect(engine().history(a.id)[0].trigger.agentIds).toEqual(['agent-b', 'agent-c']);

      const listed = async () => (await call('agent-a', 'list_actions')).body.actions.find((item: Action) => item.id === a.id);
      expect(await listed()).toBeUndefined();
      expect((await call('agent-a', 'action_history', { id: a.id })).body.error.code).toBe('not_found');
      h.activityModes.set('agent-a', 'allow');
      expect((await listed()).lastRun).toBeUndefined();
      h.wires.add('agent-a>agent-b');
      const first = await listed();
      expect(first.lastRun.trigger).toMatchObject({ agentIds: ['agent-b'], detail: 'Failed turns: qa' });
      expect(JSON.stringify(first)).not.toContain('api-lead');
      h.wires.add('agent-a>agent-c');
      expect((await listed()).lastRun.trigger.agentIds).toEqual(['agent-b', 'agent-c']);

      h.wires.delete('agent-a>agent-b');
      engine().update(a.id, { name: a.name, trigger: DAILY, steps: [NOTIFY] });
      const retained = await call('agent-a', 'action_history', { id: a.id });
      expect(retained.body.runs[0].trigger).toMatchObject({ agentIds: ['agent-c'], detail: 'Failed turns: api-lead' });
      expect(JSON.stringify(retained.body)).not.toContain('qa');
      for (const mode of ['ask', 'off'] as const) {
        h.activityModes.set('agent-a', mode);
        expect((await listed()).lastRun).toBeUndefined();
        expect((await call('agent-a', 'action_history', { id: a.id })).body.runs).toEqual([]);
      }

      engine().remove(a.id);
      expect((await call('agent-a', 'action_history', { id: a.id })).body.error.code).toBe('not_found');
      h.activityModes.set('agent-a', 'allow');
      expect((await call('agent-a', 'action_history', { id: a.id })).body.runs[0].trigger.agentIds).toEqual(['agent-c']);
      h.wires.delete('agent-a>agent-c');
      expect((await call('agent-a', 'action_history', { id: a.id })).body.error.code).toBe('not_found');
    } finally {
      engine().stop();
      vi.useRealTimers();
    }
  });

  it('does not expose redacted grouped activity records after their action is deleted', async () => {
    vi.useFakeTimers();
    try {
      engine().start();
      const created = await call('dispatcher', 'subscribe', { event: 'agent.turn_ended', source: { kind: 'any' }, coalesceSeconds: 10 });
      const id = created.body.action.id;
      engine().handleEvent({ type: 'turn.ended', agentId: 'agent-a', via: 'chat', outcome: 'done', at: Date.now() });
      h.activityModes.set('dispatcher', 'off');
      vi.setSystemTime(Date.now() + 10_000);
      engine().tick();
      await flush();
      expect(engine().history(id)[0].trigger.agentIds).toEqual([]);
      engine().remove(id);
      h.activityModes.delete('dispatcher');
      expect((await call('dispatcher', 'action_history', { id })).body.error.code).toBe('not_found');
    } finally {
      engine().stop();
      vi.useRealTimers();
    }
  });

  it('hides any-agent actions and their runtime status from readers without an Allow activity grant', async () => {
    vi.useFakeTimers();
    try {
      engine().start();
      h.activityModes.set('agent-a', 'allow');
      const a = engine().create({
        name: 'Private turns',
        trigger: { kind: 'event', event: 'agent.turn_ended', source: { kind: 'any' }, coalesceSeconds: 10 },
        steps: [NOTIFY], maxRuns: 1,
      }, { kind: 'agent', agentId: 'agent-a' });
      h.wires.add('agent-a>agent-b');
      const listed = async () => (await call('agent-a', 'list_actions')).body.actions.find((item: Action) => item.id === a.id);
      for (const mode of ['ask', 'off'] as const) {
        h.activityModes.set('agent-a', mode);
        const view = actions.getAction(a.id)!;
        vi.mocked(actions.listActions).mockReturnValueOnce([{ ...view, running: true, problem: 'qa was asleep' }]);
        expect(await listed()).toBeUndefined();
        for (const [tool, args] of [
          ['action_history', { id: a.id }],
          ['update_action', { id: a.id, name: 'Changed' }],
          ['run_action', { id: a.id }],
        ] as const) {
          expect((await call('agent-a', tool, args)).body.error.code).toBe('not_found');
        }
      }

      h.activityModes.set('agent-a', 'allow');
      engine().handleEvent({ type: 'turn.ended', agentId: 'agent-b', via: 'chat', outcome: 'done', at: Date.now() });
      vi.setSystemTime(Date.now() + 10_000);
      engine().tick();
      await flush();
      const completed = await listed();
      expect(completed).toMatchObject({ enabled: false, runsUsed: 1, offReason: 'Reached its 1-run limit' });
      expect(completed.description).toContain('0 of 1 runs remaining');
      expect(completed.updatedAt).toBe(Date.now());
      h.activityModes.set('agent-c', 'allow');
      const watcher = (await call('agent-c', 'list_actions')).body.actions.find((item: Action) => item.id === a.id);
      expect(watcher).toMatchObject({ enabled: false, runsUsed: 1, offReason: 'Reached its 1-run limit' });
      expect(watcher.lastRun).toBeUndefined();
      h.activityModes.set('agent-a', 'off');
      expect(await listed()).toBeUndefined();
      expect((await call('agent-a', 'action_history', { id: a.id })).body.error.code).toBe('not_found');
      expect(actions.getAction(a.id)).toMatchObject({ runsUsed: 1, enabled: false });
    } finally {
      engine().stop();
      vi.useRealTimers();
    }
  });

  it('redacts partial-batch provenance, unreadable step states and copied reasons, and first-member time', async () => {
    vi.useFakeTimers();
    try {
      engine().start();
      const a = engine().create({
        name: 'Watch turns',
        trigger: { kind: 'event', event: 'agent.turn_ended', source: { kind: 'any' }, coalesceSeconds: 10 },
        steps: [NOTIFY],
      }, { kind: 'user' });
      engine().handleEvent({ type: 'turn.ended', agentId: 'agent-b', via: 'chat', outcome: 'done', chain: ['cause-b'], at: Date.now() });
      vi.setSystemTime(Date.now() + 5000);
      engine().handleEvent({ type: 'turn.ended', agentId: 'agent-c', via: 'chat', outcome: 'done', at: Date.now() });
      vi.setSystemTime(Date.now() + 5000);
      engine().tick();
      await flush();
      const original = engine().history(a.id)[0];
      h.history.set(original.id, {
        ...original, outcome: 'failed', reason: 'qa was asleep',
        steps: [
          { kind: 'message', outcome: 'done', agentId: 'agent-a', detail: 'Queued for release-lead' },
          { kind: 'message', outcome: 'failed', agentId: 'agent-b', detail: 'qa was asleep' },
        ],
      });
      h.activityModes.set('agent-a', 'allow');
      h.wires.add('agent-a>agent-c');
      const result = await call('agent-a', 'action_history', { id: a.id });
      const run = result.body.runs[0];
      expect(run).toMatchObject({
        chain: [], trigger: { at: original.startedAt, agentIds: ['agent-c'], detail: 'Finished turns: api-lead' },
        steps: [{ agentId: 'agent-a', detail: 'Queued for release-lead' }],
      });
      expect(run.steps).toHaveLength(1);
      expect(run.reason).toBeUndefined();
      expect(JSON.stringify(result.body)).not.toContain('cause-b');
      expect(JSON.stringify(result.body)).not.toContain('qa');
      expect(result.body.action.lastRun).toEqual(run);
      expect(original.trigger.at).toBeLessThan(run.trigger.at);
      expect(engine().history(a.id)[0]).toMatchObject({ chain: ['cause-b'], trigger: { agentIds: ['agent-b', 'agent-c'], at: original.trigger.at } });
    } finally {
      engine().stop();
      vi.useRealTimers();
    }
  });

  it('round-trips optional lifetime limits through create, update and list', async () => {
    const endsAt = Date.now() + 24 * 60 * 60_000;
    const created = await call('agent-a', 'create_action', { trigger: DAILY, steps: [NOTIFY], endsAt, maxRuns: 5 });
    expect(created).toMatchObject({ isError: false, body: { action: { endsAt, maxRuns: 5 } } });
    const id = created.body.action.id;
    expect(created.body.action).toMatchObject({ endsAt, maxRuns: 5 });
    await call('agent-a', 'run_action', { id });
    await flush();
    const updated = await call('agent-a', 'update_action', { id, maxRuns: 3 });
    expect(updated.body.action).toMatchObject({ endsAt, maxRuns: 3, runsUsed: 1 });
    const listed = await call('agent-a', 'list_actions');
    expect(listed.body.actions.find((a: Action) => a.id === id)).toMatchObject({ endsAt, maxRuns: 3, runsUsed: 1, description: expect.stringContaining('2 of 3 runs remaining') });
    const cleared = await call('agent-a', 'update_action', { id, endsAt: null, maxRuns: null });
    expect(cleared.body.action.endsAt).toBeUndefined();
    expect(cleared.body.action.maxRuns).toBeUndefined();
    const invalid = await call('agent-a', 'update_action', { id, maxRuns: 0 });
    expect(invalid.body.error.code).toBe('invalid_input');
  });

  it('turns off a lowered limit without resetting starts when limits are cleared or raised', async () => {
    const created = await call('agent-a', 'create_action', { trigger: DAILY, steps: [NOTIFY], maxRuns: 5 });
    const id = created.body.action.id;
    for (let i = 0; i < 2; i++) {
      await call('agent-a', 'run_action', { id });
      await flush();
    }
    const lowered = await call('agent-a', 'update_action', { id, maxRuns: 1 });
    expect(lowered).toMatchObject({ isError: false, body: { action: { enabled: false, runsUsed: 2, maxRuns: 1, offReason: 'Reached its 1-run limit' } } });
    const cleared = await call('agent-a', 'update_action', { id, maxRuns: null });
    expect(cleared.body.action).toMatchObject({ enabled: false, runsUsed: 2 });
    expect(cleared.body.action.maxRuns).toBeUndefined();
    const raised = await call('agent-a', 'update_action', { id, maxRuns: 3, enabled: true });
    expect(raised.body.action).toMatchObject({ enabled: true, runsUsed: 2, maxRuns: 3 });
    expect(raised.body.action.offReason).toBeUndefined();
    await call('agent-a', 'run_action', { id });
    await flush();
    expect(engine().get(id)).toMatchObject({ enabled: false, runsUsed: 3, offReason: 'Reached its 3-run limit' });
  });

  it('round-trips a return trigger and its threshold over MCP', async () => {
    const trigger = { kind: 'event', event: 'app.returned', absenceMinutes: 45 };
    const result = await call('dispatcher', 'create_action', { trigger, steps: [NOTIFY] });
    expect(result).toMatchObject({ isError: false, body: { action: { trigger: { ...trigger, source: { kind: 'app' } } } } });
    expect(result.body.action.description).toContain('after at least 45 minutes away');
    const sub = await call('dispatcher', 'subscribe', { event: 'app.returned', absenceMinutes: 5 });
    expect(sub).toMatchObject({ isError: false, body: { action: { trigger: { absenceMinutes: 5 } } } });
  });

  it('round-trips generic event time filters on create, update and subscribe', async () => {
    const trigger = { kind: 'event', event: 'app.started', afterLocalTime: '08:00', oncePerDay: true };
    const result = await call('dispatcher', 'create_action', { trigger, steps: [NOTIFY] });
    expect(result).toMatchObject({ isError: false, body: { action: { trigger: { ...trigger, source: { kind: 'app' } } } } });
    expect(result.body.action.description).toContain("once per calendar day; moving the clock back doesn't give an extra run");
    const updated = await call('dispatcher', 'update_action', { id: result.body.action.id, trigger: { ...trigger, afterLocalTime: '09:30' } });
    expect(updated.body.action.trigger).toMatchObject({ afterLocalTime: '09:30', oncePerDay: true });
    const sub = await call('dispatcher', 'subscribe', { event: 'app.returned', afterLocalTime: '08:00', oncePerDay: true });
    expect(sub).toMatchObject({ isError: false, body: { action: { trigger: { afterLocalTime: '08:00', oncePerDay: true } } } });
    const invalid = await call('dispatcher', 'update_action', { id: result.body.action.id, trigger: { ...trigger, afterLocalTime: '24:00' } });
    expect(invalid.body.error.code).toBe('invalid_input');
  });

  it('registers all seven tools, each mapped to an action.* permission', () => {
    expect(ACTION_TOOL_PERMISSIONS).toEqual({
      create_action: 'action.create', list_actions: 'action.list', update_action: 'action.update',
      delete_action: 'action.delete', run_action: 'action.run', action_history: 'action.history',
      subscribe: 'action.create',
    });
    for (const tool of Object.keys(ACTION_TOOL_PERMISSIONS)) expect(isGlobalTool(tool)).toBe(true);
  });

  it('lists the tools for agents and the Dispatcher, not for quick agents or a turned-off Dispatcher', () => {
    const listed = (id: string) => {
      vi.spyOn(agentRegistry, 'get').mockReturnValue({ projectPath: 'web-root', orchestrator: 'claude-code', runtime: 'chat' });
      return getScopedToolList(id).map((t) => t.name).filter((n) => n in ACTION_TOOL_PERMISSIONS);
    };
    expect(listed('agent-a')).toHaveLength(7);
    expect(listed('helper-a')).toHaveLength(7);
    expect(listed('dispatcher')).toHaveLength(7);
    expect(listed('quick-1')).toEqual([]);
    h.dispatchers.delete('dispatcher');
    h.trackedDispatchers.add('dispatcher');
    _resetForTesting();
    registerActionTools();
    expect(listed('dispatcher')).toEqual([]);
  });

  describe('scope', () => {
    it('an agent owns what it creates', async () => {
      const r = await call('agent-a', 'create_action', { trigger: DAILY, steps: [NOTIFY] });
      expect(r.isError).toBe(false);
      expect(r.body.action.owner).toEqual({ kind: 'agent', agentId: 'agent-a' });
      expect(r.body.action.description).toBe('Every day at 9:00 AM → Notify you');
    });

    it('a helper owns its actions as a helper, and acts as its permissions allow', async () => {
      expect(actionScope('helper-a').owner).toEqual({ kind: 'agent', agentId: 'helper-a', helper: true });
      const own = await call('helper-a', 'create_action', { trigger: DAILY, steps: [{ kind: 'wake', agentId: 'self' }] });
      expect(own.body.action.owner).toEqual({ kind: 'agent', agentId: 'helper-a', helper: true });
      expect(own.body.action.steps[0]).toEqual({ kind: 'wake', agentId: 'helper-a' });
      const other = await call('helper-a', 'create_action', { trigger: DAILY, steps: [{ kind: 'wake', agentId: 'agent-a' }] });
      expect(other).toEqual({ isError: true, body: { error: { code: 'not_allowed', message: 'helper doesn’t have the Clubhouse permission agent.wake on that agent. Change it on its Clubhouse permissions page.' } } });
    });

    it('treats an agent with a parent as a helper even before its caller kind is known', () => {
      h.callerKinds.delete('helper-a');
      expect(actionScope('helper-a').owner).toEqual({ kind: 'agent', agentId: 'helper-a', helper: true });
    });

    it('the Dispatcher owns what it creates', async () => {
      const r = await call('dispatcher', 'create_action', { trigger: DAILY, steps: [NOTIFY] });
      expect(r.body.action.owner).toEqual({ kind: 'dispatcher' });
    });

    it('refuses quick agents and a Dispatcher that is turned off', () => {
      expect(() => actionScope('quick-1')).toThrow(/Quick agents/);
      h.dispatchers.delete('dispatcher');
      h.trackedDispatchers.add('dispatcher');
      expect(() => actionScope('dispatcher')).toThrow(/turned off/);
    });

    it('an agent lists every action people and agents can see', async () => {
      const r = await call('agent-a', 'list_actions');
      expect(r.body.actions.map((a: Action) => a.id).sort()).toEqual([ids['by-dispatcher'], ids['by-user'], ids['own-a'], ids['own-b']].sort());
    });

    it('the Dispatcher lists every visible action, never Clubhouse’s own', async () => {
      const r = await call('dispatcher', 'list_actions');
      expect(r.body.actions.map((a: Action) => a.id).sort()).toEqual([ids['by-dispatcher'], ids['by-user'], ids['own-a'], ids['own-b']].sort());
    });

    it('an agent can’t change, delete or run a person’s action or another agent’s, but can read it', async () => {
      // Running a person's action would start its quick agents at the person's Access level.
      for (const target of [ids['by-user'], ids['own-b'], ids['by-dispatcher']]) {
        for (const tool of ['update_action', 'delete_action', 'run_action']) {
          const args = tool === 'update_action' ? { id: target, enabled: false } : { id: target };
          const r = await call('agent-a', tool, args);
          // Refused by the grant check (#2968) before the tool's own check, which says the same.
          expect(r.isError).toBe(true);
          expect(r.body.text).toMatch(/an Action you don't own/);
        }
        expect((await call('agent-a', 'action_history', { id: target })).isError).toBe(false);
      }
      expect(actions.setActionEnabled).not.toHaveBeenCalled();
      expect(actions.deleteAction).not.toHaveBeenCalled();
      expect(actions.runActionNow).not.toHaveBeenCalled();
      // An unknown id is refused the same way: a refusal never says whether it exists.
      expect((await call('agent-a', 'run_action', { id: 'nope' })).body.text).toMatch(/an Action you don't own/);
      // Its own action it may run.
      expect((await call('agent-a', 'run_action', { id: ids['own-a'] })).body.runId).toBeTruthy();
    });

    it('the Dispatcher changes, runs, reads and deletes anyone’s action', async () => {
      expect((await call('dispatcher', 'update_action', { id: ids['own-b'], name: 'Renamed' })).body.action.name).toBe('Renamed');
      expect((await call('dispatcher', 'run_action', { id: ids['by-user'] })).body.runId).toBeTruthy();
      expect((await call('dispatcher', 'action_history', { id: ids['own-a'] })).body.runs).toEqual([]);
      expect((await call('dispatcher', 'delete_action', { id: ids['own-a'] })).body.deleted).toEqual({ id: ids['own-a'], name: 'Action own-a' });
      expect(engine().get(ids['own-a'])).toBeUndefined();
    });

    it('Clubhouse’s own actions are not found by anyone, the Dispatcher included', async () => {
      for (const caller of ['dispatcher', 'agent-a']) {
        for (const tool of ['update_action', 'delete_action', 'run_action', 'action_history']) {
          const r = await call(caller, tool, tool === 'update_action' ? { id: ids.hidden, name: 'x' } : { id: ids.hidden });
          expect(r.isError).toBe(true);
          // The Dispatcher reaches the tool and gets not_found. An agent is refused by the
          // grant check first (#2968), worded the same as for any action it doesn't own.
          if (caller === 'dispatcher' || tool === 'action_history') expect(r.body.error.code).toBe('not_found');
          else expect(r.body.text).toMatch(/an Action you don't own/);
        }
      }
      expect(engine().get(ids.hidden)).toBeDefined();
    });
  });

  describe('rights (review of #2952)', () => {
    it.each([undefined, 'auto'])('only an agent at Full access may have quick agent steps with provider %s', async (orchestrator) => {
      h.access.set('agent-a', 'ask');
      const step = { kind: 'quick', prompt: 'x', ...(orchestrator && { orchestrator }) };
      const r = await call('agent-a', 'create_action', { trigger: DAILY, steps: [step] });
      expect(r.body.error).toEqual({ code: 'not_allowed', message: 'Agent steps run with Full access, and release-lead runs at Ask first, so its actions can’t start quick agents.' });
      h.access.set('agent-a', 'full_access');
      expect((await call('agent-a', 'create_action', { trigger: DAILY, steps: [step] })).isError).toBe(false);
    });

    it('refuses an edit or turning on once the agent drops below Full access', async () => {
      const made = await call('agent-a', 'create_action', { trigger: DAILY, steps: [{ kind: 'quick', prompt: 'x' }], enabled: false });
      const id = made.body.action.id;
      h.access.set('agent-a', 'auto');
      const edit = await call('agent-a', 'update_action', { id, name: 'Renamed' });
      expect(edit.body.error.code).toBe('not_allowed');
      expect(edit.body.error.message).toMatch(/^Agent steps run with Full access/);
      expect((await call('agent-a', 'update_action', { id, enabled: true })).body.error.code).toBe('not_allowed');
    });

    it('drops an access field older callers still send', async () => {
      const r = await call('agent-a', 'create_action', { trigger: DAILY, steps: [{ kind: 'quick', prompt: 'x', access: 'plan' }] });
      expect(r.isError).toBe(false);
      expect(r.body.action.steps[0]).not.toHaveProperty('access');
    });

    it('the Dispatcher acts only on agents connected to it, and starts no quick agents', async () => {
      expect((await call('dispatcher', 'create_action', { trigger: DAILY, steps: [{ kind: 'wake', agentId: 'agent-a' }] })).isError).toBe(false);
      const unconnected = await call('dispatcher', 'create_action', { trigger: DAILY, steps: [{ kind: 'wake', agentId: 'agent-c' }] });
      expect(unconnected.body.error).toEqual({ code: 'not_allowed', message: 'The Dispatcher doesn’t have the Clubhouse permission agent.wake on that agent. Change it on its Clubhouse permissions page.' });
      const quick = await call('dispatcher', 'create_action', { trigger: DAILY, steps: [{ kind: 'quick', projectId: 'web', prompt: 'x' }] });
      expect(quick.body.error.code).toBe('not_allowed');
    });

    it('event sources follow the same rights', async () => {
      const watch = (agentId: string) => ({ kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId } });
      expect((await call('agent-a', 'create_action', { trigger: watch('helper-a'), steps: [NOTIFY] })).isError).toBe(false);
      expect((await call('agent-a', 'create_action', { trigger: watch('agent-b'), steps: [NOTIFY] })).body.error.code).toBe('not_allowed');
      expect((await call('helper-a', 'create_action', { trigger: watch('agent-a'), steps: [NOTIFY] })).body.error.code).toBe('not_allowed');
      expect((await call('dispatcher', 'create_action', { trigger: watch('agent-b'), steps: [NOTIFY] })).isError).toBe(false);
      // The Dispatcher may read any agent, so it may watch any (D131).
      expect((await call('dispatcher', 'create_action', { trigger: watch('agent-c'), steps: [NOTIFY] })).isError).toBe(false);
    });

    it('an agent’s refusal reads the same whether or not the agent or project exists', async () => {
      const step = (agentId: string) => ({ trigger: DAILY, steps: [{ kind: 'wake', agentId }] });
      const exists = await call('agent-a', 'create_action', step('agent-c'));
      const missing = await call('agent-a', 'create_action', step('no-such-agent'));
      expect(exists).toEqual(missing);
      expect(exists.body.error).toEqual({ code: 'not_allowed', message: 'release-lead doesn’t have the Clubhouse permission agent.wake on that agent. Change it on its Clubhouse permissions page.' });
      const project = (projectId: string) => ({ trigger: DAILY, steps: [{ kind: 'quick', projectId, prompt: 'x' }] });
      expect(await call('agent-a', 'create_action', project('api'))).toEqual(await call('agent-a', 'create_action', project('nowhere')));
      expect(await call('agent-a', 'create_action', project('proj-2'))).toEqual(await call('agent-a', 'create_action', project('proj-9')));
    });

    it('caps how many actions an agent, helper and the Dispatcher own', async () => {
      for (let i = 0; i < 5; i++) expect((await call('helper-a', 'create_action', { trigger: DAILY, steps: [NOTIFY] })).isError).toBe(false);
      const over = await call('helper-a', 'create_action', { trigger: DAILY, steps: [NOTIFY] });
      expect(over.body.error.code).toBe('not_allowed');
      expect(over.body.error.message).toMatch(/5 actions already/);
      for (let i = 1; i < 20; i++) await call('agent-a', 'create_action', { trigger: DAILY, steps: [NOTIFY] });
      expect((await call('agent-a', 'create_action', { trigger: DAILY, steps: [NOTIFY] })).body.error.message).toMatch(/20 actions already/);
    });

    it('turning an action on checks rights again', async () => {
      const made = await call('agent-a', 'create_action', { trigger: DAILY, steps: [{ kind: 'wake', agentId: 'helper-a' }], enabled: false });
      h.known.set('helper-a', { ...h.known.get('helper-a')!, parentAgentId: 'agent-b' });
      const r = await call('agent-a', 'update_action', { id: made.body.action.id, enabled: true });
      expect(r.body.error).toEqual({ code: 'not_allowed', message: 'release-lead doesn’t have the Clubhouse permission agent.wake on that agent. Change it on its Clubhouse permissions page.' });
    });
  });

  describe('update_action', () => {
    it('keeps the owner and every field left out', async () => {
      const r = await call('dispatcher', 'update_action', { id: ids['own-a'], steps: [{ kind: 'notify', text: 'changed' }] });
      expect(actions.updateAction).toHaveBeenCalledWith(ids['own-a'], expect.objectContaining({ name: 'Action own-a', overlap: 'skip', enabled: true }));
      expect(r.body.action.owner).toEqual({ kind: 'agent', agentId: 'agent-a' });
      expect(r.body.action.steps).toEqual([{ kind: 'notify', text: 'changed' }]);
    });

    it('a suggested name follows a new trigger; a chosen one stays', async () => {
      const made = await call('agent-a', 'create_action', { trigger: DAILY, steps: [NOTIFY] });
      expect(made.body.action.name).toBe('Every day at 9:00 AM, notify you');
      const weekdays = { kind: 'schedule', preset: 'weekdays', hour: 9, minute: 0 };
      const r = await call('agent-a', 'update_action', { id: made.body.action.id, trigger: weekdays });
      expect(r.body.action.name).toBe('Weekdays at 9:00 AM, notify you');
      const chosen = await call('agent-a', 'update_action', { id: ids['own-a'], trigger: weekdays });
      expect(chosen.body.action.name).toBe('Action own-a');
    });

    it('turns an action on or off like the Settings switch', async () => {
      const r = await call('agent-a', 'update_action', { id: ids['own-a'], enabled: false });
      expect(actions.setActionEnabled).toHaveBeenCalledWith(ids['own-a'], false);
      expect(actions.updateAction).not.toHaveBeenCalled();
      expect(r.body.action.enabled).toBe(false);
    });

    it('checks rights against the existing owner', async () => {
      const helperOwn = engine().create({ trigger: DAILY, steps: [NOTIFY] }, { kind: 'agent', agentId: 'helper-a', helper: true });
      const r = await call('dispatcher', 'update_action', { id: helperOwn.id, steps: [{ kind: 'sleep', agentId: 'agent-b' }] });
      expect(r.body.error.code).toBe('not_allowed');
    });

    it('needs something to change', async () => {
      expect((await call('agent-a', 'update_action', { id: ids['own-a'] })).body.error.code).toBe('invalid_input');
    });
  });

  describe('typed errors', () => {
    it('invalid input from the shared checks', async () => {
      const r = await call('agent-a', 'create_action', { trigger: { kind: 'event', event: 'agent.idle', source: { kind: 'agent', agentId: 'self' } }, steps: [NOTIFY] });
      expect(r).toEqual({ isError: true, body: { error: { code: 'invalid_input', message: 'Say how many minutes of idle time to wait for.' } } });
    });

    it('unavailable while Actions start', async () => {
      h.unavailable = true;
      expect((await call('agent-a', 'list_actions')).body.error.code).toBe('unavailable');
    });

    it('internal for anything unexpected', async () => {
      vi.mocked(actions.listActions).mockImplementationOnce(() => { throw new TypeError('boom'); });
      expect((await call('agent-a', 'list_actions')).body.error).toEqual({ code: 'internal', message: 'boom' });
    });

    it('a missing id', async () => {
      expect((await call('dispatcher', 'run_action', { id: '  ' })).body.error.code).toBe('invalid_input');
    });
  });

  describe('input conveniences', () => {
    it('fills a preset’s cron line from hour and minute, and refuses one out of range', async () => {
      const r = await call('agent-a', 'create_action', { trigger: { kind: 'schedule', preset: 'weekdays', hour: 8, minute: 30 }, steps: [NOTIFY] });
      expect(r.body.action.trigger).toEqual({ kind: 'schedule', preset: 'weekdays', cron: '30 8 * * 1-5', missed: 'skip' });
      const bad = await call('agent-a', 'create_action', { trigger: { kind: 'schedule', preset: 'daily', hour: 25 }, steps: [NOTIFY] });
      expect(bad.body.error).toEqual({ code: 'invalid_input', message: 'hour must be a whole number from 0 to 23.' });
    });

    it('reads a one-time date and time in local time, a bare date as local midnight, and refuses the past', async () => {
      const at = await call('agent-a', 'create_action', { trigger: { kind: 'once', at: '2099-01-02T09:00' }, steps: [NOTIFY] });
      expect(at.body.action.trigger.at).toBe(new Date(2099, 0, 2, 9, 0).getTime());
      const day = await call('agent-a', 'create_action', { trigger: { kind: 'once', at: '2099-01-02' }, steps: [NOTIFY] });
      expect(day.body.action.trigger.at).toBe(new Date(2099, 0, 2).getTime());
      expect((await call('agent-a', 'create_action', { trigger: { kind: 'once', at: 'soon' }, steps: [NOTIFY] })).body.error.code).toBe('invalid_input');
      const past = await call('agent-a', 'create_action', { trigger: { kind: 'once', at: '2020-01-02T09:00' }, steps: [NOTIFY] });
      expect(past.body.error).toEqual({ code: 'invalid_input', message: 'That time has already passed. Pick a time in the future.' });
      expect((await call('agent-a', 'create_action', { trigger: { kind: 'once', at: Date.now() - 1000 }, steps: [NOTIFY] })).body.error.code).toBe('invalid_input');
    });

    it('takes a project by name, and an agent’s own project when left out', async () => {
      const added = await call('dispatcher', 'create_action', { trigger: { kind: 'event', event: 'project.added', source: { kind: 'project', projectId: 'Web' } }, steps: [NOTIFY] });
      expect(added.body.action.trigger.source).toEqual({ kind: 'project', projectId: 'proj-1' });
      const own = await call('agent-a', 'create_action', {
        trigger: { kind: 'event', event: 'git.commit', source: { kind: 'project' }, branch: 'main' },
        steps: [{ kind: 'quick', prompt: 'review' }],
      });
      expect(own.body.action.trigger.source).toEqual({ kind: 'project', projectId: 'proj-1' });
      expect(own.body.action.steps[0].projectId).toBe('proj-1');
    });

    it('a name two projects share asks for the path', async () => {
      const r = await call('dispatcher', 'create_action', { trigger: { kind: 'event', event: 'project.removed', source: { kind: 'project', projectId: 'api' } }, steps: [NOTIFY] });
      expect(r.body.error).toEqual({ code: 'invalid_input', message: 'More than one project is named "api". Name it by its path instead.' });
    });

    it('"self" is the calling agent, and means nothing for the Dispatcher', async () => {
      const r = await call('dispatcher', 'create_action', { trigger: DAILY, steps: [{ kind: 'wake', agentId: 'self' }] });
      expect(r.body.error.code).toBe('invalid_input');
    });
  });

  describe('action_history', () => {
    it('returns an action’s runs with the action described', async () => {
      await call('agent-a', 'run_action', { id: ids['own-a'] });
      await flush();
      const r = await call('agent-a', 'action_history', { id: ids['own-a'] });
      expect(r.body.runs).toHaveLength(1);
      expect(r.body.runs[0].owner).toEqual({ kind: 'agent', agentId: 'agent-a' });
      expect(r.body.action.description).toContain('Notify you');
    });

    it('anyone reads a one-time action’s runs after it deleted itself', async () => {
      const made = await call('agent-a', 'create_action', { trigger: { kind: 'once', at: Date.now() + 60_000 }, steps: [NOTIFY] });
      const id = made.body.action.id as string;
      vi.useFakeTimers({ now: Date.now() + 120_000, toFake: ['Date'] });
      try {
        engine().tick();
      } finally {
        vi.useRealTimers();
      }
      await flush();
      expect(engine().get(id)).toBeUndefined();
      expect((await call('agent-a', 'action_history', { id })).body.runs).toHaveLength(1);
      expect((await call('dispatcher', 'action_history', { id })).body.runs).toHaveLength(1);
      expect((await call('agent-b', 'action_history', { id })).body.runs).toHaveLength(1);
      expect((await call('agent-b', 'action_history', { id: 'never' })).body.error.code).toBe('not_found');
    });
  });

  describe('subscribe (#3042)', () => {
    const fire = (event: Record<string, unknown>) => engine().handleEvent({ at: Date.now(), ...event } as never);
    // Events reach a started engine, as in the app.
    beforeEach(() => engine().start());

    it('an agent’s subscription is its own action, listed with the others, telling it', async () => {
      const r = await call('agent-a', 'subscribe', { event: 'git.remote_updated', branch: 'main', note: 'Tag the release.' });
      expect(r.isError).toBe(false);
      expect(r.body.action).toMatchObject({
        owner: { kind: 'agent', agentId: 'agent-a' },
        subscription: true,
        name: 'Tell release-lead when web is pushed, pulled or fetched (main)',
        description: 'When web is pushed, pulled or fetched (main) → Tell release-lead',
        // Left out, the source is the agent's own project.
        trigger: { kind: 'event', event: 'git.remote_updated', source: { kind: 'project', projectId: 'proj-1' }, branch: 'main' },
        steps: [{ kind: 'message', agentId: 'agent-a', text: 'Tag the release.' }],
      });
      const listed = await call('agent-b', 'list_actions', {});
      expect(listed.body.actions.map((a: { id: string }) => a.id)).toContain(r.body.action.id);
      // Its owner manages it like any action it made; others can't.
      expect((await call('agent-b', 'delete_action', { id: r.body.action.id })).body.text).toMatch(/an Action you don't own/);
      expect((await call('agent-a', 'delete_action', { id: r.body.action.id })).isError).toBe(false);
    });

    it('messages its owner when the event fires, and not for other branches or projects', async () => {
      const r = await call('agent-a', 'subscribe', { event: 'git.remote_updated', branch: 'main' });
      const id = r.body.action.id as string;
      fire({ type: 'git.remote_updated', repoPath: 'web-root', branch: 'dev' });
      fire({ type: 'git.remote_updated', repoPath: 'api-root', branch: 'main' });
      await flush();
      expect(h.stepCalls).toHaveLength(0);
      fire({ type: 'git.remote_updated', repoPath: 'web-root', branch: 'main' });
      await flush();
      expect(h.stepCalls).toHaveLength(1);
      expect(h.stepCalls[0]).toMatchObject({
        step: { kind: 'message', agentId: 'agent-a', text: 'You asked to be told when this happens.' },
        ctx: { action: { id }, trigger: { kind: 'event', detail: 'web is pushed, pulled or fetched (main)' } },
      });
    });

    it('follows the same rights as any action: an agent watches only what it may', async () => {
      // agent-b isn't connected to agent-a, and api is another project.
      const peer = await call('agent-a', 'subscribe', { event: 'agent.turn_ended', source: { kind: 'agent', agentId: 'agent-b' } });
      expect(peer.body.error).toEqual({ code: 'not_allowed', message: 'release-lead doesn’t have the Clubhouse permission agent.read on that agent. Change it on its Clubhouse permissions page.' });
      const other = await call('agent-a', 'subscribe', { event: 'git.commit', source: { kind: 'project', projectId: 'api-root' } });
      expect(other.body.error.code).toBe('invalid_input');
      h.wires.add('agent-a>agent-b');
      expect((await call('agent-a', 'subscribe', { event: 'agent.turn_ended', source: { kind: 'agent', agentId: 'agent-b' } })).isError).toBe(false);
      // A helper only itself; a quick agent owns no actions.
      expect((await call('helper-a', 'subscribe', { event: 'agent.turn_ended', source: { kind: 'agent', agentId: 'agent-a' } })).body.error.code).toBe('not_allowed');
      expect((await call('helper-a', 'subscribe', { event: 'agent.turn_ended', source: { kind: 'agent', agentId: 'self' } })).isError).toBe(false);
      expect((await call('quick-1', 'subscribe', { event: 'app.started' })).isError).toBe(true);
    });

    it('the Dispatcher subscribes to an agent’s events for itself the same way', async () => {
      const r = await call('dispatcher', 'subscribe', { event: 'agent.slept', source: { kind: 'agent', agentId: 'agent-a' }, note: 'Read its handoff.' });
      expect(r.isError).toBe(false);
      expect(r.body.action).toMatchObject({
        owner: { kind: 'dispatcher' },
        subscription: true,
        steps: [{ kind: 'message', agentId: 'dispatcher', text: 'Read its handoff.' }],
        description: 'When release-lead goes to sleep → Tell the Dispatcher',
      });
      fire({ type: 'agent.asleep', agentId: 'agent-a' });
      await flush();
      expect(h.stepCalls).toMatchObject([{ step: { kind: 'message', agentId: 'dispatcher' }, ctx: { trigger: { detail: 'release-lead goes to sleep' } } }]);
      // Any agent it may read (D131), and it names what it watches.
      expect((await call('dispatcher', 'subscribe', { event: 'agent.slept', source: { kind: 'agent', agentId: 'agent-c' } })).isError).toBe(false);
      expect((await call('dispatcher', 'subscribe', { event: 'agent.slept' })).body.error.code).toBe('invalid_input');
      expect((await call('dispatcher', 'subscribe', { event: 'app.started' })).isError).toBe(false);
    });

    it('needs an event', async () => {
      expect((await call('agent-a', 'subscribe', {})).isError).toBe(true);
      expect((await call('agent-a', 'subscribe', { event: 'agent.idle', source: { kind: 'agent', agentId: 'self' } })).body.error.code).toBe('invalid_input');
    });
  });
});
