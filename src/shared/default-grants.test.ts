import { describe, expect, it } from 'vitest';
import { grantKey } from './agent-grant-changes';
import { controlFromGrantModes, controlGrantModes, defaultGrants } from './default-grants';
import { evaluateGrant, type Grant, type GrantCallTarget } from './agent-grants';
import { ORCHESTRATION_CONTROLS } from './orchestration-policy';

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
  const mode = (grants: Grant[], action: Parameters<typeof grantKey>[0]['action'], target: Parameters<typeof grantKey>[0]['target']) =>
    grants.filter((g) => grantKey(g) === grantKey({ action, target })).map((g) => g.mode).sort().reverse()[0];
  const connected = { kind: 'connected' } as const;
  const anyProject = { kind: 'project', project: 'any' } as const;

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
});
