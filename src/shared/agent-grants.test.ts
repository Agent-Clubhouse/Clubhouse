import { describe, expect, it } from 'vitest';
import {
  GRANT_ACTIONS, GRANT_REFUSAL_MESSAGES, evaluateGrant, isGrantAction, targetCovers,
  type Grant, type GrantCall, type GrantCallTarget, type GrantCaller,
} from './agent-grants';

const agent: GrantCaller = { kind: 'agent', agentId: 'me', projectPath: '/p', access: 'auto' };
const call = (action: GrantCall['action'], target: GrantCallTarget, extra: Partial<GrantCall> = {}): GrantCall =>
  ({ caller: agent, action, target, ...extra });
const allow = (action: Grant['action'], target: Grant['target']): Grant => ({ action, target, mode: 'allow' });
const ask = (action: Grant['action'], target: Grant['target']): Grant => ({ action, target, mode: 'ask' });

describe('agent grants (#2966)', () => {
  describe('targets', () => {
    const cases: Array<[Grant['target'], GrantCallTarget, boolean]> = [
      [{ kind: 'self' }, { kind: 'agent', relations: ['self'] }, true],
      [{ kind: 'self' }, { kind: 'agent', relations: ['connected'] }, false],
      [{ kind: 'parent' }, { kind: 'agent', relations: ['parent'] }, true],
      [{ kind: 'parent' }, { kind: 'agent', relations: ['connected'] }, false],
      [{ kind: 'my_helpers' }, { kind: 'agent', relations: ['my_helper'] }, true],
      [{ kind: 'my_helpers' }, { kind: 'agent', relations: [] }, false],
      [{ kind: 'connected' }, { kind: 'agent', relations: ['connected'] }, true],
      [{ kind: 'connected' }, { kind: 'agent', relations: ['parent'] }, false],
      // Waking the Dispatcher by messaging it (#3037): the Dispatcher alone.
      [{ kind: 'connected', onlyDispatcher: true }, { kind: 'agent', relations: ['connected'], isDispatcher: true }, true],
      [{ kind: 'connected', onlyDispatcher: true }, { kind: 'agent', relations: ['connected'] }, false],
      [{ kind: 'connected', onlyDispatcher: true }, { kind: 'agent', relations: ['parent'], isDispatcher: true }, false],
      [{ kind: 'connected', excludeDispatcher: true }, { kind: 'agent', relations: ['connected'], isDispatcher: true }, false],
      // Wake it on the connection (#3215): only where the caller's switch is on.
      [{ kind: 'connected', wakeOn: true }, { kind: 'agent', relations: ['connected'], wakeOn: true }, true],
      [{ kind: 'connected', wakeOn: true }, { kind: 'agent', relations: ['connected'] }, false],
      [{ kind: 'connected', wakeOn: true }, { kind: 'agent', relations: ['parent'], wakeOn: true }, false],
      [{ kind: 'connected' }, { kind: 'agent', relations: ['connected'], wakeOn: true }, true],
      [{ kind: 'group_members' }, { kind: 'agent', relations: ['group_member'] }, true],
      [{ kind: 'project', project: 'own' }, { kind: 'project', projectPath: '/p/' }, true],
      [{ kind: 'project', project: 'own' }, { kind: 'project', projectPath: '/q' }, false],
      [{ kind: 'project', project: 'own' }, { kind: 'agent', projectPath: '/p' }, true],
      [{ kind: 'project', project: 'any' }, { kind: 'project', projectPath: '/q' }, true],
      [{ kind: 'project', project: { path: '/q' } }, { kind: 'project', projectPath: '/q' }, true],
      [{ kind: 'project', project: { path: '/q' } }, { kind: 'project', projectPath: '/p' }, false],
      [{ kind: 'project', project: 'any' }, { kind: 'app' }, false],
      [{ kind: 'group_project', role: 'member' }, { kind: 'group_project', groupRole: 'member' }, true],
      [{ kind: 'group_project', role: 'member' }, { kind: 'group_project', groupRole: 'admin' }, true],
      [{ kind: 'group_project', role: 'admin' }, { kind: 'group_project', groupRole: 'member' }, false],
      [{ kind: 'group_project', role: 'member' }, { kind: 'group_project', groupRole: null }, false],
      [{ kind: 'app' }, { kind: 'app' }, true],
      [{ kind: 'app' }, { kind: 'project', projectPath: '/p' }, false],
      [{ kind: 'any' }, { kind: 'agent', relations: [] }, true],
      [{ kind: 'any' }, { kind: 'library' }, true],
      [{ kind: 'action', id: 'a1' }, { kind: 'action', actionId: 'a1' }, true],
      [{ kind: 'action', id: 'a1' }, { kind: 'action', actionId: 'a2' }, false],
      [{ kind: 'self' }, { kind: 'action', actionId: 'a1', relations: ['self'] }, true],
      [{ kind: 'app' }, { kind: 'action', actionId: 'a1' }, false],
    ];
    it.each(cases)('%j covers %j: %s', (grant, target, covered) => {
      expect(targetCovers(grant, agent, target)).toBe(covered);
    });
  });

  describe('project.add (#3050)', () => {
    const folder: GrantCallTarget = { kind: 'project', projectPath: '/new/repo' };
    it.each<[Grant['target'], GrantCallTarget, boolean]>([
      [{ kind: 'project', project: 'any' }, folder, true],
      [{ kind: 'project', project: 'any' }, { kind: 'project' }, true],
      [{ kind: 'project', project: { path: '/new/repo/' } }, folder, true],
      [{ kind: 'project', project: { path: '/other' } }, folder, false],
      [{ kind: 'project', project: { path: '/new/repo' } }, { kind: 'project' }, false],
      // Its own project is already added; an agent target isn't a folder to add.
      [{ kind: 'project', project: 'own' }, { kind: 'project', projectPath: '/p' }, false],
      [{ kind: 'project', project: 'any' }, { kind: 'agent', projectPath: '/p' }, false],
      [{ kind: 'app' }, folder, false],
      [{ kind: 'any' }, folder, true],
    ])('%j covers %j: %s', (grant, target, covered) => {
      expect(targetCovers(grant, agent, target, 'project.add')).toBe(covered);
    });

    it('sits next to project.read, and asks first on an Ask first grant', () => {
      expect(GRANT_ACTIONS.indexOf('project.add')).toBe(GRANT_ACTIONS.indexOf('project.read') + 1);
      expect(evaluateGrant(call('project.add', folder), [ask('project.add', { kind: 'project', project: 'any' })]).outcome).toBe('ask');
      expect(evaluateGrant(call('project.add', folder), [allow('project.read', { kind: 'project', project: 'any' })]))
        .toEqual({ outcome: 'refuse', reason: 'no_grant' });
    });
  });

  describe('modes', () => {
    it('refuses what no grant covers, with no word on whether the target exists', () => {
      expect(evaluateGrant(call('agent.reset', { kind: 'agent', relations: ['parent'] }), [allow('agent.message', { kind: 'parent' })]))
        .toEqual({ outcome: 'refuse', reason: 'no_grant' });
      expect(GRANT_REFUSAL_MESSAGES.no_grant).not.toMatch(/exist|not found/i);
    });

    it('allows on an Allow grant and asks on an Ask first grant', () => {
      const target: GrantCallTarget = { kind: 'project', projectPath: '/p' };
      expect(evaluateGrant(call('agent.create', target), [allow('agent.create', { kind: 'project', project: 'own' })]).outcome).toBe('allow');
      expect(evaluateGrant(call('agent.create', target), [ask('agent.create', { kind: 'project', project: 'own' })]).outcome).toBe('ask');
    });

    it('lets Allow win over Ask first when both cover the call', () => {
      const grants = [ask('settings.app.write', { kind: 'app' }), allow('settings.app.write', { kind: 'any' })];
      expect(evaluateGrant(call('settings.app.write', { kind: 'app' }), grants)).toMatchObject({ outcome: 'allow', grant: grants[1] });
    });

    it('only matches the same action', () => {
      expect(evaluateGrant(call('agent.wake', { kind: 'agent', relations: ['connected'] }), [allow('agent.sleep', { kind: 'connected' })]).outcome).toBe('refuse');
    });

    it('a removed grant refuses the next call', () => {
      const target: GrantCallTarget = { kind: 'agent', relations: ['connected'] };
      const grants = [allow('agent.read', { kind: 'connected' })];
      expect(evaluateGrant(call('agent.read', target), grants).outcome).toBe('allow');
      expect(evaluateGrant(call('agent.read', target), [])).toEqual({ outcome: 'refuse', reason: 'no_grant' });
    });
  });

  describe('fixed rules', () => {
    it('1: no raising yourself, even with a grant that covers it', () => {
      expect(evaluateGrant(call('agent.grant', { kind: 'agent', relations: ['self'] }), [allow('agent.grant', { kind: 'any' })]))
        .toEqual({ outcome: 'refuse', reason: 'raise_self' });
    });

    it('2: no Access above your own', () => {
      const grants = [allow('agent.grant', { kind: 'connected' })];
      const target: GrantCallTarget = { kind: 'agent', relations: ['connected'] };
      expect(evaluateGrant(call('agent.grant', target, { change: { access: 'full_access' } }), grants))
        .toEqual({ outcome: 'refuse', reason: 'exceeds_caller' });
      expect(evaluateGrant(call('agent.grant', target, { change: { access: 'auto' } }), grants).outcome).toBe('allow');
      // An unknown caller level reads as Ask first.
      expect(evaluateGrant({ caller: { kind: 'agent', agentId: 'x' }, action: 'agent.grant', target, change: { access: 'auto_edit' } }, grants).outcome).toBe('refuse');
    });

    it('2: no grant you don\'t hold yourself', () => {
      const held = [allow('agent.grant', { kind: 'connected' }), allow('agent.read', { kind: 'connected' }), ask('agent.wake', { kind: 'any' })];
      const target: GrantCallTarget = { kind: 'agent', relations: ['connected'] };
      const give = (g: Grant) => evaluateGrant(call('agent.grant', target, { change: { grants: [g] } }), held);
      expect(give(allow('agent.read', { kind: 'connected' })).outcome).toBe('allow');
      expect(give(allow('agent.reset', { kind: 'connected' })).outcome).toBe('refuse');
      // Ask first held can't be given as Allow, only as Ask first.
      expect(give(allow('agent.wake', { kind: 'my_helpers' })).outcome).toBe('refuse');
      expect(give(ask('agent.wake', { kind: 'my_helpers' })).outcome).toBe('allow');
      // A narrower held target doesn't cover a wider one.
      expect(give(allow('agent.read', { kind: 'any' })).outcome).toBe('refuse');
    });

    it('2: a wider held target covers a narrower given one', () => {
      const target: GrantCallTarget = { kind: 'agent', relations: ['connected'] };
      const give = (held: Grant[], g: Grant) => evaluateGrant(call('agent.grant', target, { change: { grants: [g] } }), [allow('agent.grant', { kind: 'connected' }), ...held]).outcome;
      expect(give([allow('agent.reset', { kind: 'connected' })], allow('agent.reset', { kind: 'connected', excludeDispatcher: true }))).toBe('allow');
      expect(give([allow('agent.reset', { kind: 'connected', excludeDispatcher: true })], allow('agent.reset', { kind: 'connected' }))).toBe('refuse');
      // The Dispatcher alone is narrower than every connected agent, and not part of "all but the Dispatcher" (#3037).
      expect(give([allow('agent.wake', { kind: 'connected' })], allow('agent.wake', { kind: 'connected', onlyDispatcher: true }))).toBe('allow');
      expect(give([allow('agent.wake', { kind: 'connected', onlyDispatcher: true })], allow('agent.wake', { kind: 'connected' }))).toBe('refuse');
      expect(give([allow('agent.wake', { kind: 'connected', excludeDispatcher: true })], allow('agent.wake', { kind: 'connected', onlyDispatcher: true }))).toBe('refuse');
      // Connected agents with Wake it on are narrower than every connected agent (#3215).
      expect(give([allow('agent.wake', { kind: 'connected' })], allow('agent.wake', { kind: 'connected', wakeOn: true }))).toBe('allow');
      expect(give([allow('agent.wake', { kind: 'connected', wakeOn: true })], allow('agent.wake', { kind: 'connected' }))).toBe('refuse');
      expect(give([allow('agent.wake', { kind: 'connected', wakeOn: true })], allow('agent.wake', { kind: 'connected', onlyDispatcher: true }))).toBe('refuse');
      expect(give([allow('agent.create', { kind: 'project', project: 'any' })], allow('agent.create', { kind: 'project', project: 'own' }))).toBe('allow');
      expect(give([allow('agent.create', { kind: 'project', project: 'own' })], allow('agent.create', { kind: 'project', project: 'any' }))).toBe('refuse');
    });

    it('4: the user is above every agent', () => {
      expect(evaluateGrant({ caller: { kind: 'user' }, action: 'agent.grant', target: { kind: 'agent', relations: ['self'] }, change: { access: 'full_access' } }, []))
        .toEqual({ outcome: 'allow' });
    });
  });

  it('knows its actions, including the builder ones and restart', () => {
    for (const a of ['agent.restart', 'library.write', 'template.push', 'grant.request', 'settings.app.write']) expect(isGrantAction(a)).toBe(true);
    expect(isGrantAction('agent.delete')).toBe(false);
    expect(new Set(GRANT_ACTIONS).size).toBe(GRANT_ACTIONS.length);
  });
});
