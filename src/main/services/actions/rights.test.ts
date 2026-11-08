import { describe, expect, it } from 'vitest';
import { createInterimRights } from './rights';

const rights = createInterimRights({
  agentName: (id) => ({ lead: 'release-lead', h1: 'helper-1', qa: 'qa', pm: 'pm' } as Record<string, string>)[id],
  parentOf: (id) => (id === 'h1' ? 'lead' : undefined),
  isConnected: (from, to) => from === 'lead' && to === 'pm',
  agentProjectId: (id) => (id === 'other' ? 'p2' : 'p1'),
});
const lead = { kind: 'agent', agentId: 'lead' } as const;
const helper = { kind: 'agent', agentId: 'h1', helper: true } as const;

describe('interim rights', () => {
  it('lets people and the Dispatcher do anything', () => {
    expect(rights.checkStep({ kind: 'user' }, { kind: 'wake', agentId: 'qa' })).toBeNull();
    expect(rights.checkStep({ kind: 'dispatcher' }, { kind: 'sleep', agentId: 'qa' })).toBeNull();
  });

  it('lets an agent act on itself, its helpers and connected agents', () => {
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'lead' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'message', agentId: 'h1', text: 'x' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'pm' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'wake', agentId: 'qa' })).toBe('release-lead can no longer wake qa.');
    expect(rights.checkStep(lead, { kind: 'notify', text: 'x' })).toBeNull();
  });

  it('keeps quick agents in the agent’s own project', () => {
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', prompt: 'x' })).toBeNull();
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p2', prompt: 'x' })).toMatch(/own project/);
    expect(rights.checkStep(lead, { kind: 'quick', projectId: 'p1', worktreeAgentId: 'qa', prompt: 'x' })).toMatch(/can no longer/);
  });

  it('keeps a helper to itself', () => {
    expect(rights.checkStep(helper, { kind: 'message', agentId: 'h1', text: 'x' })).toBeNull();
    expect(rights.checkStep(helper, { kind: 'wake', agentId: 'lead' })).toMatch(/helper/);
    expect(rights.checkStep(helper, { kind: 'quick', projectId: 'p1', prompt: 'x' })).toMatch(/helper/);
    expect(rights.checkStep(helper, { kind: 'notify', text: 'x' })).toBeNull();
  });
});
