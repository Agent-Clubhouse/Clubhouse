import { describe, expect, it } from 'vitest';
import { grantKey } from './agent-grant-changes';
import { controlFromGrantModes, controlGrantModes, defaultGrants } from './default-grants';
import { evaluateGrant, type Grant, type GrantCallTarget } from './agent-grants';
import { ORCHESTRATION_CONTROLS } from './orchestration-policy';
import { applyGrantChanges, grantRows, normalizeGrantChanges } from './agent-grant-changes';

describe('remote Dispatcher grants (#3348)', () => {
  it.each([[true, false, 'allow'], [false, true, 'ask'], [false, false, 'refuse']] as const)('defaults dispatcher=%s connected=%s to %s', (dispatcher, dispatcherConnected, expected) => {
    const grants = defaultGrants({ dispatcher, dispatcherConnected, helper: false, orchestrates: false, crossProject: false });
    expect(evaluateGrant({ caller: { kind: 'agent' }, action: 'agent.message', target: { kind: 'agent', remoteDispatcher: true } }, grants).outcome).toBe(expected);
    expect(evaluateGrant({ caller: { kind: 'agent' }, action: 'agent.message', target: { kind: 'agent' } }, grants).outcome).toBe('refuse');
  });
  it.each([[true, false, 'ask'], [false, true, 'ask'], [false, false, 'refuse']] as const)('keeps agreements under their own normal approval dispatcher=%s connected=%s', (dispatcher, dispatcherConnected, expected) => {
    const grants = defaultGrants({ dispatcher, dispatcherConnected, helper: false, orchestrates: false, crossProject: false });
    expect(evaluateGrant({ caller: { kind: 'agent' }, action: 'handoff.offer', target: { kind: 'agent', remoteDispatcher: true } }, grants).outcome).toBe(expected);
    if (expected === 'ask') expect(grantRows(grants, undefined)).toContainEqual(expect.objectContaining({ action: 'handoff.offer', target: { kind: 'remote_dispatcher' }, mode: 'ask' }));
  });
  it('exposes an Off row and preserves the person\'s grant without widening to other agents', () => {
    const defaults = defaultGrants({ dispatcher: false, helper: false, orchestrates: false, crossProject: false });
    expect(grantRows(defaults, undefined)).toContainEqual(expect.objectContaining({ action: 'agent.message', target: { kind: 'remote_dispatcher' }, mode: 'off' }));
    const saved = normalizeGrantChanges(JSON.parse(JSON.stringify({ changes: [{ action: 'agent.message', target: { kind: 'remote_dispatcher' }, mode: 'allow', by: 'user' }] })));
    const grants = applyGrantChanges(defaults, saved);
    expect(evaluateGrant({ caller: { kind: 'agent' }, action: 'agent.message', target: { kind: 'agent', remoteDispatcher: true } }, grants).outcome).toBe('allow');
    expect(evaluateGrant({ caller: { kind: 'agent' }, action: 'agent.message', target: { kind: 'agent', relations: ['connected'] } }, [{ action: 'agent.message', target: { kind: 'remote_dispatcher' }, mode: 'allow' }]).outcome).toBe('refuse');
  });
});

describe('connection management (#3336)', () => {
  it('asks before ordinary agents manage their own connections without widening their reach', () => {
    for (const helper of [false, true]) {
      const grants = defaultGrants({ dispatcher: false, helper, orchestrates: false, crossProject: false });
      const caller = { kind: 'agent' as const, agentId: 'plain' };
      expect(evaluateGrant({ caller, action: 'connection.manage', target: { kind: 'agent', relations: ['self'] } }, grants).outcome).toBe('ask');
      expect(evaluateGrant({ caller, action: 'connection.manage', target: { kind: 'agent', relations: [] } }, grants).outcome).toBe('refuse');
    }
  });
});

describe('the approval setting as grant modes (#2970)', () => {
  it('maps each setting to start and dispose modes', () => {
    expect(controlGrantModes('hands-off')).toEqual({ create: 'allow', dispose: 'allow' });
    expect(controlGrantModes('ask-before-start')).toEqual({ create: 'ask', dispose: 'allow' });
    expect(controlGrantModes('ask-everything')).toEqual({ create: 'ask', dispose: 'ask' });
  });

  it('round-trips every setting', () => {
    for (const control of ORCHESTRATION_CONTROLS) expect(controlFromGrantModes(controlGrantModes(control))).toBe(control);
  });

  it('reads the pair with no setting of its own as asking for both', () => {
    expect(controlFromGrantModes({ create: 'allow', dispose: 'ask' })).toBe('ask-everything');
  });

  it('gives an orchestrator\'s start and dispose grants the setting\'s modes', () => {
    const base = { dispatcher: false, helper: false, orchestrates: true, crossProject: true };
    const mode = (control: Parameters<typeof controlGrantModes>[0] | undefined, key: string) =>
      defaultGrants({ ...base, control }).find((g) => grantKey(g) === key)?.mode;
    const create = grantKey({ action: 'agent.create', target: { kind: 'project', project: 'own' } });
    const createAny = grantKey({ action: 'agent.create', target: { kind: 'project', project: 'any' } });
    const dispose = grantKey({ action: 'agent.dispose', target: { kind: 'my_helpers' } });
    expect([mode(undefined, create), mode(undefined, dispose)]).toEqual(['allow', 'allow']);
    expect([mode('ask-before-start', create), mode('ask-before-start', createAny), mode('ask-before-start', dispose)]).toEqual(['ask', 'ask', 'allow']);
    expect([mode('ask-everything', create), mode('ask-everything', dispose)]).toEqual(['ask', 'ask']);
  });
});

describe('the Dispatcher\'s defaults (#3050, #3034)', () => {
  const dispatcher = defaultGrants({ dispatcher: true, helper: false, orchestrates: false, crossProject: false });
  it('only the Dispatcher asks to bootstrap an agent created in the same call (#3281)', () => {
    expect(dispatcher.filter((g) => g.action === 'connection.bootstrap')).toEqual([
      { action: 'connection.bootstrap', target: { kind: 'created_by_me' }, mode: 'ask', source: 'structural' },
    ]);
    for (const facts of [
      { dispatcher: false, helper: false, orchestrates: false, crossProject: false },
      { dispatcher: false, helper: true, orchestrates: false, crossProject: false },
      { dispatcher: false, helper: false, orchestrates: true, crossProject: true },
      { dispatcherChat: true, dispatcher: false, helper: false, orchestrates: false, crossProject: false },
    ]) expect(defaultGrants(facts).some((g) => g.action === 'connection.bootstrap')).toBe(false);
  });
  const mode = (grants: Grant[], action: Parameters<typeof grantKey>[0]['action'], target: Parameters<typeof grantKey>[0]['target']) =>
    grants.filter((g) => grantKey(g) === grantKey({ action, target })).map((g) => g.mode).sort().reverse()[0];
  const connected = { kind: 'connected' } as const;
  const anyProject = { kind: 'project', project: 'any' } as const;

  it('allows memory writes only for its controller by default', () => {
    expect(mode(dispatcher, 'memory.write', { kind: 'self' })).toBe('allow');
    for (const facts of [
      { dispatcher: false, helper: false, orchestrates: false, crossProject: false },
      { dispatcher: false, helper: true, orchestrates: false, crossProject: false },
      { dispatcher: false, helper: false, orchestrates: true, crossProject: true },
      { dispatcher: true, dispatcherChat: true, helper: false, orchestrates: false, crossProject: false },
    ]) expect(defaultGrants(facts).some((g) => g.action === 'memory.write')).toBe(false);
  });

  it('allows the Dispatcher to watch readable-agent activity; nobody else gets a default activity grant', () => {
    expect(mode(dispatcher, 'agent.watch', { kind: 'app' })).toBe('allow');
    for (const facts of [
      { dispatcher: false, helper: false, orchestrates: false, crossProject: false },
      { dispatcher: false, helper: true, orchestrates: false, crossProject: false },
      { dispatcher: false, helper: false, orchestrates: true, crossProject: true },
      { dispatcherChat: true, dispatcher: false, helper: false, orchestrates: false, crossProject: false },
    ]) expect(defaultGrants(facts).some((g) => g.action === 'agent.watch')).toBe(false);
  });

  it('has broad power over connected agents, plus connections', () => {
    for (const action of ['agent.read', 'agent.message', 'agent.wake', 'agent.sleep', 'agent.reset', 'agent.display', 'agent.configure', 'connection.manage'] as const) {
      expect(mode(dispatcher, action, connected), action).toBe('allow');
    }
  });

  it('sees the Annex Network\'s devices, and asks before changing any; no other agent gets either (#3068)', () => {
    const app = { kind: 'app' } as const;
    expect(mode(dispatcher, 'device.read', app)).toBe('allow');
    expect(mode(dispatcher, 'device.manage', app)).toBe('ask');
    for (const facts of [
      { dispatcher: false, helper: false, orchestrates: false, crossProject: false },
      { dispatcher: false, helper: true, orchestrates: false, crossProject: false },
      { dispatcher: false, helper: false, orchestrates: true, crossProject: true },
      { dispatcherChat: true, dispatcher: false, helper: false, orchestrates: false, crossProject: false },
    ]) {
      const grants = defaultGrants(facts);
      expect(grants.some((g) => g.action === 'device.read' || g.action === 'device.manage')).toBe(false);
    }
  });

  it('creates agents in any project and grants up to its own level', () => {
    expect(mode(dispatcher, 'agent.create', anyProject)).toBe('allow');
    expect(mode(dispatcher, 'agent.grant', { kind: 'any' })).toBe('allow');
  });

  it('asks first to add a project, change project defaults or change app settings', () => {
    expect(mode(dispatcher, 'project.add', anyProject)).toBe('ask');
    expect(mode(dispatcher, 'project.configure', anyProject)).toBe('ask');
    expect(mode(dispatcher, 'settings.app.write', { kind: 'app' })).toBe('ask');
  });

  it('only the Dispatcher gets a default update grant, and it asks first', () => {
    expect(mode(dispatcher, 'app.update', { kind: 'app' })).toBe('ask');
    for (const facts of [
      { dispatcher: false, helper: false, orchestrates: false, crossProject: false },
      { dispatcher: false, helper: true, orchestrates: true, crossProject: true },
      { dispatcher: true, dispatcherChat: true, helper: false, orchestrates: false, crossProject: false },
    ]) expect(defaultGrants(facts).some((g) => g.action === 'app.update')).toBe(false);
  });

  it('asks first to delete any agent; no other agent deletes one outside its helpers (#3182)', () => {
    expect(mode(dispatcher, 'agent.dispose', { kind: 'any' })).toBe('ask');
    for (const facts of [
      { dispatcher: false, helper: false, orchestrates: false, crossProject: false },
      { dispatcher: false, helper: true, orchestrates: false, crossProject: false },
      { dispatcher: false, helper: false, orchestrates: true, crossProject: true },
      { dispatcherChat: true, dispatcher: false, helper: false, orchestrates: false, crossProject: false },
    ]) {
      const disposes = defaultGrants(facts).filter((g) => g.action === 'agent.dispose');
      expect(disposes.every((g) => g.target.kind === 'my_helpers'), JSON.stringify(facts)).toBe(true);
    }
  });

  it('creates, changes and runs Actions', () => {
    for (const action of ['action.read', 'action.write', 'action.run'] as const) expect(mode(dispatcher, action, { kind: 'any' }), action).toBe('allow');
  });

  it('no other agent adds projects by default', () => {
    for (const facts of [
      { dispatcher: false, helper: false, orchestrates: false, crossProject: false },
      { dispatcher: false, helper: true, orchestrates: false, crossProject: false },
      { dispatcher: false, helper: false, orchestrates: true, crossProject: true },
    ]) {
      expect(defaultGrants(facts).some((g) => g.action === 'project.add'), JSON.stringify(facts)).toBe(false);
    }
  });
});

describe('waking the Dispatcher by messaging it (#3037)', () => {
  const caller = { kind: 'agent' as const, agentId: 'a', projectPath: '/p' };
  const dispatcher: GrantCallTarget = { kind: 'agent', relations: ['connected'], isDispatcher: true };
  const peer: GrantCallTarget = { kind: 'agent', relations: ['connected'] };
  const facts = [
    { dispatcher: false, helper: false, orchestrates: false, crossProject: false },
    { dispatcher: false, helper: true, orchestrates: false, crossProject: false },
    { dispatcher: false, helper: false, orchestrates: true, crossProject: true },
  ];

  it.each(facts)('every agent may wake the Dispatcher it is connected to, and no other connected agent: %j', (f) => {
    const grants = defaultGrants(f);
    expect(evaluateGrant({ caller, action: 'agent.wake', target: dispatcher }, grants).outcome).toBe('allow');
    expect(evaluateGrant({ caller, action: 'agent.wake', target: peer }, grants).outcome).toBe('refuse');
  });

  it.each(facts)('every agent may wake a connected agent whose Wake it switch is on, and no other (#3215): %j', (f) => {
    const grants = defaultGrants(f);
    expect(evaluateGrant({ caller, action: 'agent.wake', target: { ...peer, wakeOn: true } }, grants).outcome).toBe('allow');
    expect(evaluateGrant({ caller, action: 'agent.wake', target: peer }, grants).outcome).toBe('refuse');
    // Sleep stays the Dispatcher's: no switch opens it.
    expect(evaluateGrant({ caller, action: 'agent.sleep', target: { ...peer, wakeOn: true } }, grants).outcome).toBe('refuse');
  });

  it('the Dispatcher wakes every connected agent as before, switch or not', () => {
    const grants = defaultGrants({ dispatcher: true, helper: false, orchestrates: false, crossProject: false });
    expect(evaluateGrant({ caller, action: 'agent.wake', target: peer }, grants).outcome).toBe('allow');
    expect(evaluateGrant({ caller, action: 'agent.sleep', target: peer }, grants).outcome).toBe('allow');
  });
});
