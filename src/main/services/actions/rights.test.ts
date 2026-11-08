import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionTrigger } from '../../../shared/actions';
import type { AccessLevel } from '../../../shared/agent-access';
import { MAX_ACTIONS, createInterimRights } from './rights';

let dispatcherId: string | undefined = 'disp';
let leadAccess: AccessLevel = 'full_access';
const rights = createInterimRights({
  agentName: (id) => ({ lead: 'release-lead', h1: 'helper-1', qa: 'qa', pm: 'pm' } as Record<string, string>)[id],
  parentOf: (id) => (id === 'h1' ? 'lead' : undefined),
  isConnected: (from, to) => (from === 'lead' && (to === 'pm' || to === 'other')) || (from === 'disp' && (to === 'lead' || to === 'pm')),
  agentProjectId: (id) => (id === 'other' ? 'p2' : 'p1'),
  dispatcherAgentId: () => dispatcherId,
  // Only release-lead may start helpers.
  canStartAgents: (id) => id === 'lead',
  agentAccess: (id) => (id === 'lead' ? leadAccess : 'ask'),
});
beforeEach(() => {
  leadAccess = 'full_access';
  dispatcherId = 'disp';
});
const lead = { kind: 'agent', agentId: 'lead' } as const;
const helper = { kind: 'agent', agentId: 'h1', helper: true } as const;
const dispatcher = { kind: 'dispatcher' } as const;
const user = { kind: 'user' } as const;

const watchAgent = (agentId: string): ActionTrigger => ({ kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId } });
const watchProject = (projectId: string): ActionTrigger => ({ kind: 'event', event: 'git.commit', source: { kind: 'project', projectId } });
const appStarts: ActionTrigger = { kind: 'event', event: 'app.started', source: { kind: 'app' } };
const projectAdded = (projectId: string): ActionTrigger => ({ kind: 'event', event: 'project.added', source: { kind: 'project', projectId } });
const daily: ActionTrigger = { kind: 'schedule', preset: 'daily', cron: '0 9 * * *', missed: 'skip' };

describe('interim rights: steps', () => {
  it('lets people do anything, any Access level included', () => {
    expect(rights.checkStep(user, { kind: 'wake', agentId: 'qa' })).toBeNull();
    expect(rights.checkStep(user, { kind: 'quick', projectId: 'p2', prompt: 'x', access: 'full_access' })).toBeNull();
  });

  it('lets an agent act on itself, its helpers and connected agents, with one refusal for the rest', () => {
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'lead' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'message', agentId: 'h1', text: 'x' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'pm' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'notify', text: 'x' })).toBeNull();
    // An agent that exists and one that doesn't read the same.
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'qa' })).toBe('release-lead can’t act on that agent.');
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'nobody' })).toBe('release-lead can’t act on that agent.');
  });

  it('keeps an agent’s quick agents in its own project, and only for an agent at Full access', () => {
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', prompt: 'x' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p2', prompt: 'x' })).toBe('release-lead can’t act on that project.');
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'nowhere', prompt: 'x' })).toBe('release-lead can’t act on that project.');
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', worktreeAgentId: 'qa', prompt: 'x' })).toBe('release-lead can’t act on that agent.');
    for (const level of ['plan', 'ask', 'auto_edit', 'auto'] as const) {
      leadAccess = level;
      expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', prompt: 'x' })).toMatch(/^Agent steps run with Full access, and release-lead runs at .+, so its actions can’t start quick agents\.$/);
    }
    leadAccess = 'auto_edit';
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', prompt: 'x' })).toBe('Agent steps run with Full access, and release-lead runs at Auto-accept edits, so its actions can’t start quick agents.');
    // Other steps don't depend on the agent's level.
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'pm' })).toBeNull();
    leadAccess = 'full_access';
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', prompt: 'x' })).toBeNull();
  });

  it('keeps an agent’s quick agent out of a worktree in another project', () => {
    // release-lead is connected to both; pm is in its project, "other" in p2.
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', worktreeAgentId: 'pm', prompt: 'x' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', worktreeAgentId: 'other', prompt: 'x' })).toBe('release-lead can’t act on that agent.');
  });

  it('lets a person’s action start quick agents whatever anyone’s level', () => {
    leadAccess = 'plan';
    expect(rights.checkStep(user, { kind: 'quick', projectId: 'p1', prompt: 'x' })).toBeNull();
    leadAccess = 'full_access';
  });

  it('keeps a helper to itself', () => {
    expect(rights.checkStep(helper, { kind: 'message', agentId: 'h1', text: 'x' })).toBeNull();
    expect(rights.checkStep(helper, { kind: 'wake', agentId: 'lead' })).toMatch(/helper/);
    expect(rights.checkStep(helper, { kind: 'quick', projectId: 'p1', prompt: 'x' })).toMatch(/helper/);
    expect(rights.checkStep(helper, { kind: 'notify', text: 'x' })).toBeNull();
  });

  it('lets the Dispatcher reach only agents connected to it, and start no quick agents', () => {
    expect(rights.checkStep(dispatcher, { kind: 'wake', agentId: 'lead' })).toBeNull();
    expect(rights.checkStep(dispatcher, { kind: 'sleep', agentId: 'pm' })).toBeNull();
    expect(rights.checkStep(dispatcher, { kind: 'message', agentId: 'qa', text: 'x' })).toBe('The Dispatcher can’t act on that agent.');
    expect(rights.checkStep(dispatcher, { kind: 'quick', projectId: 'p1', prompt: 'x' })).toMatch(/can’t start quick agents/);
    expect(rights.checkStep(dispatcher, { kind: 'notify', text: 'x' })).toBeNull();
    dispatcherId = undefined;
    expect(rights.checkStep(dispatcher, { kind: 'wake', agentId: 'lead' })).toBe('The Dispatcher can’t act on that agent.');
    dispatcherId = 'disp';
  });
});

describe('interim rights: what an action watches', () => {
  it('ignores schedules and one-time actions, and lets people watch anything', () => {
    expect(rights.checkSource(lead, daily)).toBeNull();
    expect(rights.checkSource(user, watchAgent('qa'))).toBeNull();
    expect(rights.checkSource(user, watchProject('p2'))).toBeNull();
  });

  it('an agent watches itself, its helpers, connected agents, its own project and app events', () => {
    expect(rights.checkSource(lead, watchAgent('lead'))).toBeNull();
    expect(rights.checkSource(lead, watchAgent('h1'))).toBeNull();
    expect(rights.checkSource(lead, watchAgent('pm'))).toBeNull();
    expect(rights.checkSource(lead, watchAgent('qa'))).toBe('release-lead can’t act on that agent.');
    expect(rights.checkSource(lead, watchProject('p1'))).toBeNull();
    expect(rights.checkSource(lead, watchProject('p2'))).toBe('release-lead can’t act on that project.');
    expect(rights.checkSource(lead, appStarts)).toBeNull();
  });

  it('a helper watches only itself', () => {
    expect(rights.checkSource(helper, watchAgent('h1'))).toBeNull();
    expect(rights.checkSource(helper, watchAgent('lead'))).toMatch(/helper/);
    expect(rights.checkSource(helper, watchProject('p1'))).toMatch(/helper/);
    expect(rights.checkSource(helper, appStarts)).toMatch(/helper/);
  });

  it('the Dispatcher watches agents connected to it and app events', () => {
    expect(rights.checkSource(dispatcher, watchAgent('lead'))).toBeNull();
    expect(rights.checkSource(dispatcher, watchAgent('qa'))).toBe('The Dispatcher can’t act on that agent.');
    expect(rights.checkSource(dispatcher, appStarts)).toBeNull();
    expect(rights.checkSource(dispatcher, projectAdded('p2'))).toBeNull();
    expect(rights.checkSource(dispatcher, watchProject('p1'))).toBe('The Dispatcher can’t act on that project.');
  });
});

describe('interim rights: how many actions', () => {
  it('limits agents, helpers and the Dispatcher, not people', () => {
    expect(rights.maxActions(lead)).toBe(MAX_ACTIONS.agent);
    expect(rights.maxActions(helper)).toBe(MAX_ACTIONS.helper);
    expect(rights.maxActions(dispatcher)).toBe(MAX_ACTIONS.dispatcher);
    expect(rights.maxActions(user)).toBeNull();
    expect(MAX_ACTIONS).toEqual({ agent: 20, helper: 5, dispatcher: 50 });
  });

  it('starts quick agents only for an owner that may start helpers', () => {
    const pm = { kind: 'agent', agentId: 'pm' } as const;
    expect(rights.checkStep(pm, { kind: 'quick', projectId: 'p1', prompt: 'x' })).toMatch(/can’t start agents/);
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', prompt: 'x' })).toBeNull();
  });
});

describe('interim rights: the Dispatcher telling itself (#3042)', () => {
  it('its actions may message or wake the Dispatcher, never put it to sleep', () => {
    expect(rights.checkStep(dispatcher, { kind: 'message', agentId: 'disp', text: 'x' })).toBeNull();
    expect(rights.checkStep(dispatcher, { kind: 'wake', agentId: 'disp' })).toBeNull();
    expect(rights.checkStep(dispatcher, { kind: 'sleep', agentId: 'disp' })).toBe('The Dispatcher can’t act on that agent.');
    // Still only agents connected to it otherwise.
    expect(rights.checkStep(dispatcher, { kind: 'message', agentId: 'qa', text: 'x' })).toBe('The Dispatcher can’t act on that agent.');
  });

  it('an agent’s actions reach the Dispatcher only over a wire to it, like any agent', () => {
    expect(rights.checkStep(lead, { kind: 'message', agentId: 'disp', text: 'x' })).toBe('release-lead can’t act on that agent.');
    dispatcherId = undefined;
    expect(rights.checkStep(dispatcher, { kind: 'message', agentId: 'disp', text: 'x' })).toBe('The Dispatcher can’t act on that agent.');
  });
});
