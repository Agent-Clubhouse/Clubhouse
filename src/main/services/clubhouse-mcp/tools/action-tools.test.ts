import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Action, ActionOwner, ActionRun, ActionView } from '../../../../shared/actions';

// What the gate decides is covered in mcp-call-gate.test.ts; here every caller is open and its kind is set per test.
const h = vi.hoisted(() => ({
  callerKinds: new Map<string, string>(),
  dispatchers: new Set<string>(),
  trackedDispatchers: new Set<string>(),
  known: new Map<string, { projectPath: string; name?: string; parentAgentId?: string }>(),
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

// A small stand-in for the Actions service: the shared checks, the interim
// rights and the same hiding of Clubhouse's own actions, over a map.
const svc = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  history: new Map<string, unknown[]>(),
  unavailable: false,
}));

vi.mock('../../actions', async () => {
  const shared = await import('../../../../shared/actions');
  const { createInterimRights } = await import('../../actions/rights');
  const rights = createInterimRights({
    agentName: (id) => h.known.get(id)?.name,
    parentOf: (id) => h.known.get(id)?.parentAgentId,
    isConnected: () => false,
    agentProjectId: (id) => (h.known.get(id) ? 'proj-1' : undefined),
  });
  let n = 0;
  const store = svc.store as Map<string, Action>;
  const ready = () => { if (svc.unavailable) throw new shared.ActionError('unavailable', 'Actions are still starting. Try again in a moment.'); };
  const view = (a: Action): ActionView => ({ ...a, running: false });
  const visible = (id: string) => {
    const a = store.get(id);
    if (!a || a.owner.kind === 'app') throw new shared.ActionError('not_found', 'No action with that id.');
    return a;
  };
  const check = (owner: ActionOwner, steps: Action['steps']) => {
    for (const s of steps) {
      const reason = rights.checkStep(owner, s);
      if (reason) throw new shared.ActionError('not_allowed', reason);
    }
  };
  return {
    listActions: vi.fn(() => { ready(); return [...store.values()].filter((a) => a.owner.kind !== 'app').map(view); }),
    getAction: vi.fn((id: string) => { ready(); const a = store.get(id); return a && a.owner.kind !== 'app' ? view(a) : undefined; }),
    createAction: vi.fn((input: unknown, owner: ActionOwner) => {
      ready();
      const valid = shared.assertActionInput(input);
      check(owner, valid.steps);
      const a: Action = { id: `act-${++n}`, name: valid.name ?? 'Suggested', trigger: valid.trigger, steps: valid.steps, overlap: valid.overlap, owner, enabled: valid.enabled, createdAt: 1, updatedAt: 1 };
      store.set(a.id, a);
      return view(a);
    }),
    updateAction: vi.fn((id: string, input: unknown) => {
      const current = visible(id);
      const valid = shared.assertActionInput(input);
      check(current.owner, valid.steps);
      const next: Action = { ...current, name: valid.name ?? 'Suggested', trigger: valid.trigger, steps: valid.steps, overlap: valid.overlap, enabled: valid.enabled };
      store.set(id, next);
      return view(next);
    }),
    setActionEnabled: vi.fn((id: string, enabled: boolean) => {
      const next = { ...visible(id), enabled };
      store.set(id, next);
      return view(next);
    }),
    deleteAction: vi.fn((id: string) => { visible(id); store.delete(id); }),
    runActionNow: vi.fn((id: string) => { visible(id); return { runId: 'run-1' }; }),
    actionHistory: vi.fn((id: string) => (store.get(id)?.owner.kind === 'app' ? [] : (svc.history.get(id) ?? []))),
    actionNames: () => ({ agent: (id: string) => h.known.get(id)?.name, project: (id: string) => (id === 'proj-1' ? 'web' : undefined) }),
    projectIdOfAgent: (id: string) => (h.known.get(id) ? 'proj-1' : undefined),
    findProjectId: (ref: string) => (ref === 'proj-1' || ref.toLowerCase() === 'web' ? 'proj-1' : undefined),
  };
});

import * as actions from '../../actions';
import { ACTION_TOOL_PERMISSIONS, actionScope, registerActionTools } from './action-tools';
import { callTool, isGlobalTool, _resetForTesting } from '../tool-registry';

const NOTIFY = { kind: 'notify', text: 'Stand-up time' };
const DAILY = { kind: 'schedule', preset: 'daily', cron: '0 9 * * *' };

function seed(id: string, owner: ActionOwner): void {
  (svc.store as Map<string, Action>).set(id, {
    id, name: `Action ${id}`, trigger: { kind: 'schedule', preset: 'daily', cron: '0 9 * * *', missed: 'skip' },
    steps: [{ kind: 'notify', text: 'hi' }], overlap: 'skip', owner, enabled: true, createdAt: 1, updatedAt: 1,
  });
}

async function call(caller: string, tool: string, args: Record<string, unknown> = {}) {
  const result = await callTool(caller, tool, args);
  const body = JSON.parse(result.content[0].text ?? '{}');
  return { isError: !!result.isError, body };
}

describe('action tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
    h.callerKinds.clear();
    h.dispatchers.clear();
    h.trackedDispatchers.clear();
    h.known.clear();
    svc.store.clear();
    svc.history.clear();
    svc.unavailable = false;
    // Two durable agents, a helper of the first, and the Dispatcher.
    h.callerKinds.set('agent-a', 'durable').set('agent-b', 'durable').set('helper-a', 'helper').set('quick-1', 'quick');
    h.known.set('agent-a', { projectPath: 'project', name: 'release-lead' });
    h.known.set('agent-b', { projectPath: 'project', name: 'qa' });
    h.known.set('helper-a', { projectPath: 'project', name: 'helper', parentAgentId: 'agent-a' });
    h.dispatchers.add('dispatcher');
    seed('own-a', { kind: 'agent', agentId: 'agent-a' });
    seed('own-b', { kind: 'agent', agentId: 'agent-b' });
    seed('by-user', { kind: 'user' });
    seed('by-dispatcher', { kind: 'dispatcher' });
    seed('hidden', { kind: 'app' });
    registerActionTools();
  });

  it('registers all six tools for every agent, each mapped to an action.* permission', () => {
    expect(ACTION_TOOL_PERMISSIONS).toEqual({
      create_action: 'action.create', list_actions: 'action.list', update_action: 'action.update',
      delete_action: 'action.delete', run_action: 'action.run', action_history: 'action.history',
    });
    for (const tool of Object.keys(ACTION_TOOL_PERMISSIONS)) expect(isGlobalTool(tool)).toBe(true);
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
      expect(other).toEqual({ isError: true, body: { error: { code: 'not_allowed', message: expect.stringContaining('helper') } } });
    });

    it('treats an agent with a parent as a helper even before its caller kind is known', () => {
      h.callerKinds.delete('helper-a');
      expect(actionScope('helper-a').owner).toEqual({ kind: 'agent', agentId: 'helper-a', helper: true });
    });

    it('the Dispatcher owns what it creates', async () => {
      const r = await call('dispatcher', 'create_action', { trigger: DAILY, steps: [NOTIFY] });
      expect(r.body.action.owner).toEqual({ kind: 'dispatcher' });
    });

    it('refuses quick agents and a Dispatcher that is turned off', async () => {
      expect((await call('quick-1', 'create_action', { trigger: DAILY, steps: [NOTIFY] })).body.error.code).toBe('not_allowed');
      h.dispatchers.delete('dispatcher');
      h.trackedDispatchers.add('dispatcher');
      expect((await call('dispatcher', 'list_actions')).body.error.code).toBe('not_allowed');
      expect(actions.createAction).not.toHaveBeenCalled();
    });

    it('an agent lists only its own actions', async () => {
      const r = await call('agent-a', 'list_actions');
      expect(r.body.actions.map((a: Action) => a.id)).toEqual(['own-a']);
      expect(r.body.count).toBe(1);
    });

    it('the Dispatcher lists every visible action, never Clubhouse’s own', async () => {
      const r = await call('dispatcher', 'list_actions');
      expect(r.body.actions.map((a: Action) => a.id).sort()).toEqual(['by-dispatcher', 'by-user', 'own-a', 'own-b']);
    });

    it('another agent’s action reads as not found, the same as a missing one', async () => {
      for (const tool of ['update_action', 'delete_action', 'run_action', 'action_history']) {
        const args = tool === 'update_action' ? { id: 'own-b', enabled: false } : { id: 'own-b' };
        const theirs = await call('agent-a', tool, args);
        const missing = await call('agent-a', tool, { ...args, id: 'nope' });
        expect(theirs).toEqual({ isError: true, body: { error: { code: 'not_found', message: 'No action with that id.' } } });
        expect(theirs).toEqual(missing);
      }
      expect(actions.setActionEnabled).not.toHaveBeenCalled();
      expect(actions.deleteAction).not.toHaveBeenCalled();
      expect(actions.runActionNow).not.toHaveBeenCalled();
      expect(actions.actionHistory).not.toHaveBeenCalled();
    });

    it('the Dispatcher changes, runs, reads and deletes anyone’s action', async () => {
      expect((await call('dispatcher', 'update_action', { id: 'own-b', name: 'Renamed' })).body.action.name).toBe('Renamed');
      expect((await call('dispatcher', 'run_action', { id: 'by-user' })).body.runId).toBe('run-1');
      expect((await call('dispatcher', 'action_history', { id: 'own-a' })).body.runs).toEqual([]);
      expect((await call('dispatcher', 'delete_action', { id: 'own-a' })).body.deleted).toEqual({ id: 'own-a', name: 'Action own-a' });
      expect(svc.store.has('own-a')).toBe(false);
    });

    it('Clubhouse’s own actions are not found by anyone, the Dispatcher included', async () => {
      for (const caller of ['dispatcher', 'agent-a']) {
        for (const tool of ['update_action', 'delete_action', 'run_action', 'action_history']) {
          const r = await call(caller, tool, tool === 'update_action' ? { id: 'hidden', name: 'x' } : { id: 'hidden' });
          expect(r.body.error.code).toBe('not_found');
        }
      }
      expect(svc.store.has('hidden')).toBe(true);
    });
  });

  describe('update_action', () => {
    it('keeps the owner and every field left out', async () => {
      const r = await call('dispatcher', 'update_action', { id: 'own-a', steps: [{ kind: 'notify', text: 'changed' }] });
      expect(actions.updateAction).toHaveBeenCalledWith('own-a', expect.objectContaining({ name: 'Action own-a', overlap: 'skip', enabled: true }));
      expect(r.body.action.owner).toEqual({ kind: 'agent', agentId: 'agent-a' });
      expect(r.body.action.steps).toEqual([{ kind: 'notify', text: 'changed' }]);
    });

    it('turns an action on or off like the Settings switch', async () => {
      const r = await call('agent-a', 'update_action', { id: 'own-a', enabled: false });
      expect(actions.setActionEnabled).toHaveBeenCalledWith('own-a', false);
      expect(actions.updateAction).not.toHaveBeenCalled();
      expect(r.body.action.enabled).toBe(false);
    });

    it('checks rights against the existing owner', async () => {
      seed('helper-own', { kind: 'agent', agentId: 'helper-a', helper: true });
      const r = await call('dispatcher', 'update_action', { id: 'helper-own', steps: [{ kind: 'sleep', agentId: 'agent-b' }] });
      expect(r.body.error.code).toBe('not_allowed');
    });

    it('needs something to change', async () => {
      expect((await call('agent-a', 'update_action', { id: 'own-a' })).body.error.code).toBe('invalid_input');
    });
  });

  describe('typed errors', () => {
    it('invalid input from the shared checks', async () => {
      const r = await call('agent-a', 'create_action', { trigger: { kind: 'event', event: 'agent.idle', source: { kind: 'agent', agentId: 'self' } }, steps: [NOTIFY] });
      expect(r).toEqual({ isError: true, body: { error: { code: 'invalid_input', message: 'Say how many minutes of idle time to wait for.' } } });
    });

    it('not allowed from the rights check', async () => {
      const r = await call('agent-a', 'create_action', { trigger: DAILY, steps: [{ kind: 'wake', agentId: 'agent-b' }] });
      expect(r.body.error).toEqual({ code: 'not_allowed', message: 'release-lead can no longer wake qa.' });
    });

    it('unavailable while Actions start', async () => {
      svc.unavailable = true;
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
    it('fills a preset’s cron line from hour and minute', async () => {
      const r = await call('agent-a', 'create_action', { trigger: { kind: 'schedule', preset: 'weekdays', hour: 8, minute: 30 }, steps: [NOTIFY] });
      expect(r.body.action.trigger).toEqual({ kind: 'schedule', preset: 'weekdays', cron: '30 8 * * 1-5', missed: 'skip' });
      const bad = await call('agent-a', 'create_action', { trigger: { kind: 'schedule', preset: 'daily', hour: 25 }, steps: [NOTIFY] });
      expect(bad.body.error).toEqual({ code: 'invalid_input', message: 'hour must be a whole number from 0 to 23.' });
    });

    it('reads a one-time date and time in local time', async () => {
      const r = await call('agent-a', 'create_action', { trigger: { kind: 'once', at: '2030-01-02T09:00' }, steps: [NOTIFY] });
      expect(r.body.action.trigger.at).toBe(new Date(2030, 0, 2, 9, 0).getTime());
      expect((await call('agent-a', 'create_action', { trigger: { kind: 'once', at: 'soon' }, steps: [NOTIFY] })).body.error.code).toBe('invalid_input');
    });

    it('takes a project by name, and an agent’s own project when left out', async () => {
      const named = await call('dispatcher', 'create_action', { trigger: DAILY, steps: [{ kind: 'quick', projectId: 'Web', prompt: 'tidy' }] });
      expect(named.body.action.steps[0].projectId).toBe('proj-1');
      const own = await call('agent-a', 'create_action', {
        trigger: { kind: 'event', event: 'git.commit', source: { kind: 'project' }, branch: 'main' },
        steps: [{ kind: 'quick', prompt: 'review' }],
      });
      expect(own.body.action.trigger.source).toEqual({ kind: 'project', projectId: 'proj-1' });
      expect(own.body.action.steps[0].projectId).toBe('proj-1');
      const unknown = await call('dispatcher', 'create_action', { trigger: DAILY, steps: [{ kind: 'quick', projectId: 'nowhere', prompt: 'x' }] });
      expect(unknown.body.error).toEqual({ code: 'invalid_input', message: 'No project matches "nowhere".' });
    });

    it('"self" is the calling agent, and means nothing for the Dispatcher', async () => {
      const r = await call('dispatcher', 'create_action', { trigger: DAILY, steps: [{ kind: 'wake', agentId: 'self' }] });
      expect(r.body.error.code).toBe('invalid_input');
    });
  });

  describe('action_history', () => {
    const run: ActionRun = { id: 'run-9', actionId: 'gone', trigger: { kind: 'once', at: 1 }, chain: [], startedAt: 1, endedAt: 2, outcome: 'done', steps: [] };

    it('returns an action’s runs with the action described', async () => {
      svc.history.set('own-a', [{ ...run, actionId: 'own-a' }]);
      const r = await call('agent-a', 'action_history', { id: 'own-a' });
      expect(r.body.runs).toHaveLength(1);
      expect(r.body.action.description).toContain('Notify you');
    });

    it('a one-time action that deleted itself: the Dispatcher reads it, an agent can’t tell whose it was', async () => {
      svc.history.set('gone', [run]);
      expect((await call('dispatcher', 'action_history', { id: 'gone' })).body.runs).toHaveLength(1);
      expect((await call('agent-a', 'action_history', { id: 'gone' })).body.error.code).toBe('not_found');
      expect((await call('dispatcher', 'action_history', { id: 'never' })).body.error.code).toBe('not_found');
    });
  });
});
