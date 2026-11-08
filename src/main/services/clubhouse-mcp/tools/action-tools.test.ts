import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Action, ActionOwner, ActionRun } from '../../../../shared/actions';
import type { ActionsEngine } from '../../actions/engine';

// What the gate decides is covered in mcp-call-gate.test.ts; here every caller is open and its kind is set per test.
const h = vi.hoisted(() => ({
  callerKinds: new Map<string, string>(),
  dispatchers: new Set<string>(),
  trackedDispatchers: new Set<string>(),
  /** agent id to name, project and parent */
  known: new Map<string, { projectPath: string; projectId: string; name: string; parentAgentId?: string }>(),
  /** wires: "from>to" */
  wires: new Set<string>(),
  engine: null as unknown,
  history: new Map<string, unknown>(),
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

// The Actions service over a real engine with the real interim rights, and
// facts from the table above. Mirrors src/main/services/actions/index.ts.
vi.mock('../../actions', async () => {
  const shared = await import('../../../../shared/actions');
  const { ActionsEngine } = await import('../../actions/engine');
  const { createInterimRights } = await import('../../actions/rights');
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
    h.engine = new ActionsEngine({
      clock: { now: () => Date.now(), setTimeout: () => 0, clearTimeout: () => undefined },
      storage: { load: () => ({ actions: [], state: { nextAt: {}, waits: [] } }), saveActions: () => undefined, saveState: () => undefined },
      history: {
        put: (run) => { h.history.set(run.id, run); },
        list: (id) => [...(h.history.values() as Iterable<ActionRun>)].filter((r) => r.actionId === id),
      },
      facts: {
        agentExists: (id) => h.known.has(id),
        isRunning: () => false,
        agentName,
        agentProjectId,
        projectName,
        projectIdForPath: () => undefined,
        repoOwner: () => ({}),
      },
      steps: { run: async (step) => ({ kind: step.kind, outcome: 'done', detail: 'ok' }) },
      rights: createInterimRights({
        agentName,
        parentOf: (id) => h.known.get(id)?.parentAgentId,
        isConnected: (from, to) => h.wires.has(`${from}>${to}`),
        agentProjectId,
        dispatcherAgentId: () => (h.dispatchers.has('dispatcher') ? 'dispatcher' : undefined),
        canStartAgents: () => true,
        agentAccess: () => 'ask',
      }),
    });
  };
  const e = () => {
    if (h.unavailable) throw new shared.ActionError('unavailable', 'Actions are still starting. Try again in a moment.');
    return h.engine as ActionsEngine;
  };
  const view = (a: Action) => ({ ...a, running: false });
  const visible = (id: string) => {
    const a = e().get(id);
    if (!a || a.owner.kind === 'app') throw new shared.ActionError('not_found', 'No action with that id.');
    return a;
  };
  return {
    listActions: vi.fn(() => e().list().filter((a) => a.owner.kind !== 'app').map(view)),
    getAction: vi.fn((id: string) => { const a = e().get(id); return a && a.owner.kind !== 'app' ? view(a) : undefined; }),
    createAction: vi.fn((input: unknown, owner: ActionOwner) => view(e().create(input, owner))),
    updateAction: vi.fn((id: string, input: unknown) => { visible(id); return view(e().update(id, input)); }),
    setActionEnabled: vi.fn((id: string, enabled: boolean) => { visible(id); return view(e().setEnabled(id, enabled)); }),
    deleteAction: vi.fn((id: string) => { visible(id); e().remove(id); }),
    runActionNow: vi.fn((id: string) => { visible(id); return { runId: e().runNow(id) }; }),
    actionHistory: vi.fn((id: string) => (e().get(id)?.owner.kind === 'app' ? [] : e().history(id))),
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

  it('registers all six tools, each mapped to an action.* permission', () => {
    expect(ACTION_TOOL_PERMISSIONS).toEqual({
      create_action: 'action.create', list_actions: 'action.list', update_action: 'action.update',
      delete_action: 'action.delete', run_action: 'action.run', action_history: 'action.history',
    });
    for (const tool of Object.keys(ACTION_TOOL_PERMISSIONS)) expect(isGlobalTool(tool)).toBe(true);
  });

  it('lists the tools for agents and the Dispatcher, not for quick agents or a turned-off Dispatcher', () => {
    const listed = (id: string) => {
      vi.spyOn(agentRegistry, 'get').mockReturnValue({ projectPath: 'web-root', orchestrator: 'claude-code', runtime: 'chat' });
      return getScopedToolList(id).map((t) => t.name).filter((n) => n in ACTION_TOOL_PERMISSIONS);
    };
    expect(listed('agent-a')).toHaveLength(6);
    expect(listed('helper-a')).toHaveLength(6);
    expect(listed('dispatcher')).toHaveLength(6);
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

    it('a helper owns its actions as a helper, and may act only on itself', async () => {
      expect(actionScope('helper-a').owner).toEqual({ kind: 'agent', agentId: 'helper-a', helper: true });
      const own = await call('helper-a', 'create_action', { trigger: DAILY, steps: [{ kind: 'wake', agentId: 'self' }] });
      expect(own.body.action.owner).toEqual({ kind: 'agent', agentId: 'helper-a', helper: true });
      expect(own.body.action.steps[0]).toEqual({ kind: 'wake', agentId: 'helper-a' });
      const other = await call('helper-a', 'create_action', { trigger: DAILY, steps: [{ kind: 'wake', agentId: 'agent-a' }] });
      expect(other).toEqual({ isError: true, body: { error: { code: 'not_allowed', message: 'helper is a helper, so its actions can only act on itself.' } } });
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

    it('an agent lists only its own actions', async () => {
      const r = await call('agent-a', 'list_actions');
      expect(r.body.actions.map((a: Action) => a.id)).toEqual([ids['own-a']]);
      expect(r.body.count).toBe(1);
    });

    it('the Dispatcher lists every visible action, never Clubhouse’s own', async () => {
      const r = await call('dispatcher', 'list_actions');
      expect(r.body.actions.map((a: Action) => a.id).sort()).toEqual([ids['by-dispatcher'], ids['by-user'], ids['own-a'], ids['own-b']].sort());
    });

    it('another agent’s action reads as not found, the same as a missing one', async () => {
      for (const tool of ['update_action', 'delete_action', 'run_action', 'action_history']) {
        const args = tool === 'update_action' ? { id: ids['own-b'], enabled: false } : { id: ids['own-b'] };
        const theirs = await call('agent-a', tool, args);
        const missing = await call('agent-a', tool, { ...args, id: 'nope' });
        expect(theirs).toEqual({ isError: true, body: { error: { code: 'not_found', message: 'No action with that id.' } } });
        expect(theirs).toEqual(missing);
      }
      expect(actions.setActionEnabled).not.toHaveBeenCalled();
      expect(actions.deleteAction).not.toHaveBeenCalled();
      expect(actions.runActionNow).not.toHaveBeenCalled();
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
          expect(r.body.error.code).toBe('not_found');
        }
      }
      expect(engine().get(ids.hidden)).toBeDefined();
    });
  });

  describe('rights (review of #2952)', () => {
    it('an agent’s action never starts a quick agent above the agent’s own Access level', async () => {
      const r = await call('agent-a', 'create_action', { trigger: DAILY, steps: [{ kind: 'quick', prompt: 'x', access: 'full_access' }] });
      expect(r.body.error.code).toBe('not_allowed');
      expect(r.body.error.message).toMatch(/runs at Ask first/);
      expect((await call('agent-a', 'create_action', { trigger: DAILY, steps: [{ kind: 'quick', prompt: 'x', access: 'plan' }] })).isError).toBe(false);
    });

    it('the Dispatcher reaches only agents connected to it, and starts no quick agents', async () => {
      expect((await call('dispatcher', 'create_action', { trigger: DAILY, steps: [{ kind: 'wake', agentId: 'agent-a' }] })).isError).toBe(false);
      const unconnected = await call('dispatcher', 'create_action', { trigger: DAILY, steps: [{ kind: 'wake', agentId: 'agent-c' }] });
      expect(unconnected.body.error).toEqual({ code: 'not_allowed', message: 'The Dispatcher can’t act on that agent.' });
      const quick = await call('dispatcher', 'create_action', { trigger: DAILY, steps: [{ kind: 'quick', projectId: 'web', prompt: 'x' }] });
      expect(quick.body.error.code).toBe('not_allowed');
    });

    it('event sources follow the same rights', async () => {
      const watch = (agentId: string) => ({ kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId } });
      expect((await call('agent-a', 'create_action', { trigger: watch('helper-a'), steps: [NOTIFY] })).isError).toBe(false);
      expect((await call('agent-a', 'create_action', { trigger: watch('agent-b'), steps: [NOTIFY] })).body.error.code).toBe('not_allowed');
      expect((await call('helper-a', 'create_action', { trigger: watch('agent-a'), steps: [NOTIFY] })).body.error.code).toBe('not_allowed');
      expect((await call('dispatcher', 'create_action', { trigger: watch('agent-b'), steps: [NOTIFY] })).isError).toBe(false);
      expect((await call('dispatcher', 'create_action', { trigger: watch('agent-c'), steps: [NOTIFY] })).body.error.code).toBe('not_allowed');
    });

    it('an agent’s refusal reads the same whether or not the agent or project exists', async () => {
      const step = (agentId: string) => ({ trigger: DAILY, steps: [{ kind: 'wake', agentId }] });
      const exists = await call('agent-a', 'create_action', step('agent-c'));
      const missing = await call('agent-a', 'create_action', step('no-such-agent'));
      expect(exists).toEqual(missing);
      expect(exists.body.error).toEqual({ code: 'not_allowed', message: 'release-lead can’t act on that agent.' });
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
      expect(r.body.error).toEqual({ code: 'not_allowed', message: 'release-lead can’t act on that agent.' });
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
      expect((await call('agent-a', 'run_action', { id: '  ' })).body.error.code).toBe('invalid_input');
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

    it('its owner and the Dispatcher read a one-time action’s runs after it deleted itself; no one else does', async () => {
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
      const other = await call('agent-b', 'action_history', { id });
      expect(other.body.error.code).toBe('not_found');
      expect(other).toEqual(await call('agent-b', 'action_history', { id: 'never' }));
    });
  });
});
