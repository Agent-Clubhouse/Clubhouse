import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionTrigger } from '../../../shared/actions';
import type { AccessLevel } from '../../../shared/agent-access';
import type { Grant } from '../../../shared/agent-grants';
import { applyGrantChanges, type AgentGrantChanges } from '../../../shared/agent-grant-changes';
import { defaultGrants } from '../../../shared/default-grants';
import { MAX_ACTIONS, createGrantRights } from './rights';

let dispatcherId: string | undefined = 'disp';
let leadAccess: AccessLevel = 'full_access';
const saved = new Map<string, AgentGrantChanges>();
/** Connections with Wake it on, as "from>to" (#3215). */
const wakeOn = new Set<string>();
const projectPaths: Record<string, string> = { p1: '/p1', p2: '/p2' };
const agentProject = (id: string) => (id === 'other' ? 'p2' : 'p1');
const rights = createGrantRights({
  agentName: (id) => ({ lead: 'release-lead', h1: 'helper-1', qa: 'qa', pm: 'pm' } as Record<string, string>)[id],
  parentOf: (id) => (id === 'h1' ? 'lead' : undefined),
  isConnected: (from, to) => (from === 'lead' && (to === 'pm' || to === 'other')) || (from === 'disp' && (to === 'lead' || to === 'pm')),
  wakeOn: (from, to) => wakeOn.has(`${from}>${to}`),
  agentProjectId: agentProject,
  dispatcherAgentId: () => dispatcherId,
  // Only release-lead may start helpers.
  canStartAgents: (id) => id === 'lead',
  agentAccess: (id) => (id === 'lead' ? leadAccess : 'ask'),
  // The real defaults for what each agent is, with any saved changes.
  grantsOf: (id): Grant[] => applyGrantChanges(defaultGrants({
    dispatcher: id === dispatcherId,
    helper: id === 'h1',
    orchestrates: id === 'lead',
    crossProject: false,
  }), saved.get(id)),
  agentProjectPath: (id) => projectPaths[agentProject(id)],
  projectPath: (id) => projectPaths[id],
});
beforeEach(() => {
  leadAccess = 'full_access';
  dispatcherId = 'disp';
  saved.clear();
  wakeOn.clear();
});
const lead = { kind: 'agent', agentId: 'lead' } as const;
const pm = { kind: 'agent', agentId: 'pm' } as const;
const helper = { kind: 'agent', agentId: 'h1', helper: true } as const;
const dispatcher = { kind: 'dispatcher' } as const;
const user = { kind: 'user' } as const;

const watchAgent = (agentId: string): ActionTrigger => ({ kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId } });
const watchProject = (projectId: string): ActionTrigger => ({ kind: 'event', event: 'git.commit', source: { kind: 'project', projectId } });
const appStarts: ActionTrigger = { kind: 'event', event: 'app.started', source: { kind: 'app' } };
const projectAdded = (projectId: string): ActionTrigger => ({ kind: 'event', event: 'project.added', source: { kind: 'project', projectId } });
const daily: ActionTrigger = { kind: 'schedule', preset: 'daily', cron: '0 9 * * *', missed: 'skip' };

describe('an action does what its owner may (#2960, D131): steps', () => {
  it('lets people do anything, any Access level included', () => {
    expect(rights.checkStep(user, { kind: 'wake', agentId: 'qa' })).toBeNull();
    expect(rights.checkStep(user, { kind: 'quick', projectId: 'p2', prompt: 'x', access: 'full_access' })).toBeNull();
  });

  it('an agent reminds, wakes and sleeps itself, acts on its helpers, and messages agents it is connected to', () => {
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'lead' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'message', agentId: 'lead', text: 'x' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'message', agentId: 'h1', text: 'x' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'sleep', agentId: 'h1' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'message', agentId: 'pm', text: 'x' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'notify', text: 'x' })).toBeNull();
  });

  it('waking a connected agent needs that permission, and the refusal names it; granted, it goes', () => {
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'pm' })).toBe('release-lead doesn’t have the Clubhouse permission agent.wake on that agent. Change it on its Clubhouse permissions page.');
    saved.set('lead', { changes: [{ action: 'agent.wake', target: { kind: 'connected' }, mode: 'allow' }] });
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'pm' })).toBeNull();
  });

  it('waking a connected agent follows its Wake it switch, and the switch never opens sleep (#3215)', () => {
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'pm' })).toMatch(/agent\.wake on that agent/);
    wakeOn.add('lead>pm');
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'pm' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'pm', prompt: 'Go' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'sleep', agentId: 'pm' })).toMatch(/agent\.sleep on that agent/);
    // Per direction, and only where connected.
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'qa' })).toMatch(/agent\.wake/);
    saved.set('lead', { changes: [{ action: 'agent.wake', target: { kind: 'connected', wakeOn: true }, mode: 'ask' }] });
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'pm' })).toMatch(/set to Ask first/);
  });

  it('a wake with a prompt also needs to message the agent', () => {
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'h1', prompt: 'Go' })).toBeNull();
    saved.set('lead', { changes: [{ action: 'agent.message', target: { kind: 'my_helpers' }, mode: 'off' }] });
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'h1' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'h1', prompt: 'Go' })).toMatch(/agent\.message on that agent/);
  });

  it('a refusal reads the same whether or not the agent exists', () => {
    expect(rights.checkStep(lead, { kind: 'message', agentId: 'qa', text: 'x' })).toBe(rights.checkStep(lead, { kind: 'message', agentId: 'nobody', text: 'x' }));
  });

  it('a permission set to Ask first counts as no: nobody is there to ask', () => {
    saved.set('lead', { changes: [{ action: 'agent.message', target: { kind: 'my_helpers' }, mode: 'ask' }] });
    expect(rights.checkStep(lead, { kind: 'message', agentId: 'h1', text: 'x' })).toMatch(/Ask first, and an action runs with nobody there to ask/);
  });

  it('turning a permission off reaches the owner\'s actions', () => {
    saved.set('lead', { changes: [{ action: 'user.notify', target: { kind: 'app' }, mode: 'off' }] });
    expect(rights.checkStep(lead, { kind: 'notify', text: 'x' })).toMatch(/user\.notify/);
  });

  it('keeps an agent\'s quick agents in its own project, and only for an agent at Full access (D140)', () => {
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', prompt: 'x' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p2', prompt: 'x' })).toBe('release-lead can’t start agents in that project.');
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', worktreeAgentId: 'other', prompt: 'x' })).toBe('release-lead can’t use that agent’s worktree.');
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', worktreeAgentId: 'pm', prompt: 'x' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', worktreeAgentId: 'h1', prompt: 'x' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', worktreeAgentId: 'lead', prompt: 'x' })).toBeNull();
    // Only the worktree of an agent it works with, and the refusal reads the same for one that doesn't exist.
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', worktreeAgentId: 'qa', prompt: 'x' })).toBe('release-lead can’t use that agent’s worktree.');
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', worktreeAgentId: 'nobody', prompt: 'x' })).toBe('release-lead can’t use that agent’s worktree.');
    leadAccess = 'auto_edit';
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', prompt: 'x' })).toBe('Agent steps run with Full access, and release-lead runs at Auto-accept edits, so its actions can’t start quick agents.');
    // Starting agents in its project is a permission too.
    leadAccess = 'full_access';
    saved.set('lead', { changes: [{ action: 'agent.create', target: { kind: 'project', project: 'own' }, mode: 'off' }] });
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', prompt: 'x' })).toMatch(/agent\.create in that project/);
  });

  it('starts quick agents only for an owner that may start helpers', () => {
    expect(rights.checkStep(pm, { kind: 'quick', projectId: 'p1', prompt: 'x' })).toMatch(/can’t start agents/);
  });

  it('a helper acts on itself and reports to its orchestrator, and starts no quick agents', () => {
    expect(rights.checkStep(helper, { kind: 'message', agentId: 'h1', text: 'x' })).toBeNull();
    // A helper always reaches its orchestrator to report.
    expect(rights.checkStep(helper, { kind: 'message', agentId: 'lead', text: 'x' })).toBeNull();
    expect(rights.checkStep(helper, { kind: 'wake', agentId: 'lead' })).toMatch(/agent\.wake/);
    expect(rights.checkStep(helper, { kind: 'quick', projectId: 'p1', prompt: 'x' })).toMatch(/can’t start agents/);
    expect(rights.checkStep(helper, { kind: 'notify', text: 'x' })).toBeNull();
  });

  it('the Dispatcher reaches agents connected to it, starts no quick agents, and never puts itself to sleep', () => {
    expect(rights.checkStep(dispatcher, { kind: 'wake', agentId: 'lead' })).toBeNull();
    expect(rights.checkStep(dispatcher, { kind: 'sleep', agentId: 'pm' })).toBeNull();
    expect(rights.checkStep(dispatcher, { kind: 'message', agentId: 'qa', text: 'x' })).toMatch(/agent\.message on that agent/);
    expect(rights.checkStep(dispatcher, { kind: 'quick', projectId: 'p1', prompt: 'x' })).toMatch(/can’t start quick agents/);
    expect(rights.checkStep(dispatcher, { kind: 'notify', text: 'x' })).toBeNull();
    // Telling itself (#3042).
    expect(rights.checkStep(dispatcher, { kind: 'message', agentId: 'disp', text: 'x' })).toBeNull();
    expect(rights.checkStep(dispatcher, { kind: 'wake', agentId: 'disp' })).toBeNull();
    expect(rights.checkStep(dispatcher, { kind: 'sleep', agentId: 'disp' })).toBe('The Dispatcher’s actions can’t put it to sleep.');
    dispatcherId = undefined;
    expect(rights.checkStep(dispatcher, { kind: 'wake', agentId: 'lead' })).toBe('The Dispatcher can’t act on that agent.');
  });

  it('an agent\'s actions reach the Dispatcher only over a wire to it, like any agent', () => {
    expect(rights.checkStep(lead, { kind: 'message', agentId: 'disp', text: 'x' })).toMatch(/agent\.message on that agent/);
  });
});

describe('an action does what its owner may: what it watches', () => {
  it('requires an explicit activity grant independently of each watched agent read permission', () => {
    const any: ActionTrigger = { kind: 'event', event: 'agent.turn_ended', source: { kind: 'any' } };
    expect(rights.checkSource(user, any)).toBeNull();
    expect(rights.checkSource(dispatcher, any)).toBeNull();
    saved.set('disp', { changes: [{ action: 'agent.watch', target: { kind: 'app' }, mode: 'ask' }] });
    expect(rights.checkSource(dispatcher, any)).toMatch(/agent\.watch.*Ask first/);
    saved.set('disp', { changes: [{ action: 'agent.watch', target: { kind: 'app' }, mode: 'off' }] });
    expect(rights.checkSource(dispatcher, any)).toMatch(/agent\.watch/);
    expect(rights.checkSource(lead, any)).toMatch(/agent\.watch/);
    saved.set('lead', { changes: [{ action: 'agent.watch', target: { kind: 'app' }, mode: 'allow' }] });
    expect(rights.checkSource(lead, any)).toBeNull();
    expect(rights.checkSource(lead, watchAgent('qa'))).toMatch(/agent\.read/);
    expect(rights.checkSource(lead, watchAgent('pm'))).toBeNull();
    saved.set('lead', { changes: [{ action: 'agent.watch', target: { kind: 'app' }, mode: 'ask' }] });
    expect(rights.checkSource(lead, any)).toMatch(/Ask first/);
  });

  it('ignores schedules and one-time actions, and lets people watch anything', () => {
    expect(rights.checkSource(lead, daily)).toBeNull();
    expect(rights.checkSource(user, watchAgent('qa'))).toBeNull();
    expect(rights.checkSource(user, watchProject('p2'))).toBeNull();
  });

  it('an agent watches itself, its helpers, connected agents, its own project and app events', () => {
    expect(rights.checkSource(lead, watchAgent('lead'))).toBeNull();
    expect(rights.checkSource(lead, watchAgent('h1'))).toBeNull();
    expect(rights.checkSource(lead, watchAgent('pm'))).toBeNull();
    expect(rights.checkSource(lead, watchAgent('qa'))).toMatch(/agent\.read on that agent/);
    expect(rights.checkSource(lead, watchProject('p1'))).toBeNull();
    expect(rights.checkSource(lead, watchProject('p2'))).toMatch(/project\.read on that project/);
    expect(rights.checkSource(lead, appStarts)).toBeNull();
  });

  it('a helper watches itself and its own project, as its permissions allow', () => {
    expect(rights.checkSource(helper, watchAgent('h1'))).toBeNull();
    expect(rights.checkSource(helper, watchAgent('pm'))).toMatch(/agent\.read/);
    expect(rights.checkSource(helper, watchProject('p1'))).toBeNull();
  });

  it('the Dispatcher watches any agent it may read, app events and any project', () => {
    expect(rights.checkSource(dispatcher, watchAgent('lead'))).toBeNull();
    expect(rights.checkSource(dispatcher, watchAgent('qa'))).toBeNull();
    expect(rights.checkSource(dispatcher, appStarts)).toBeNull();
    expect(rights.checkSource(dispatcher, projectAdded('p2'))).toBeNull();
  });
});

describe('how many actions', () => {
  it('limits agents, helpers and the Dispatcher, not people', () => {
    expect(rights.maxActions(lead)).toBe(MAX_ACTIONS.agent);
    expect(rights.maxActions(helper)).toBe(MAX_ACTIONS.helper);
    expect(rights.maxActions(dispatcher)).toBe(MAX_ACTIONS.dispatcher);
    expect(rights.maxActions(user)).toBeNull();
    expect(MAX_ACTIONS).toEqual({ agent: 20, helper: 5, dispatcher: 50 });
  });
});
