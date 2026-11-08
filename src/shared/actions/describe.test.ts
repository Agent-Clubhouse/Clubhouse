import { describe, expect, it } from 'vitest';
import { cronToPresetFields, describeAction, describeTrigger, presetToCron, suggestActionName, type ActionNames } from './describe';
import type { ActionStep, ActionTrigger } from './types';

const names: ActionNames = {
  agent: (id) => ({ a1: 'release-lead', a2: 'pm', a3: 'qa' } as Record<string, string>)[id],
  project: (id) => ({ p1: 'web' } as Record<string, string>)[id],
};

describe('presets', () => {
  it('map to cron lines and back', () => {
    const f = { hour: 9, minute: 30, weekday: 3 };
    expect(presetToCron('daily', f)).toBe('30 9 * * *');
    expect(presetToCron('weekdays', f)).toBe('30 9 * * 1-5');
    expect(presetToCron('weekly', f)).toBe('30 9 * * 3');
    expect(presetToCron('hourly', f)).toBe('30 * * * *');
    expect(presetToCron('cron', f)).toBeNull();
    expect(cronToPresetFields('weekly', '30 9 * * 3')).toEqual(f);
  });
});

describe('describeTrigger', () => {
  it('reads schedules in plain words', () => {
    expect(describeTrigger({ kind: 'schedule', preset: 'weekdays', cron: '0 9 * * 1-5', missed: 'skip' })).toBe('Weekdays at 9:00 AM');
  });

  it('reads events with their source and wait', () => {
    const t: ActionTrigger = { kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: 'a1' }, delayMinutes: 30 };
    expect(describeTrigger(t, names)).toBe('30 minutes after release-lead goes to sleep');
    expect(describeTrigger({ kind: 'event', event: 'agent.woke', source: { kind: 'project', projectId: 'p1' } }, names))
      .toBe('When any agent in web wakes');
    expect(describeTrigger({ kind: 'event', event: 'agent.idle', source: { kind: 'agent', agentId: 'a1' }, delayMinutes: 60 }, names))
      .toBe('release-lead goes idle for 1 hour');
    expect(describeTrigger({ kind: 'event', event: 'git.remote_updated', source: { kind: 'project', projectId: 'p1' }, branch: 'main' }, names))
      .toBe('When web is pushed, pulled or fetched (main)');
    expect(describeTrigger({ kind: 'event', event: 'app.started', source: { kind: 'app' } }, names)).toBe('When Clubhouse starts');
  });

  it('falls back to generic words for unknown ids', () => {
    expect(describeTrigger({ kind: 'event', event: 'agent.woke', source: { kind: 'agent', agentId: 'gone' } }, names)).toBe('When an agent wakes');
  });
});

describe('describeAction and suggestActionName', () => {
  const steps: ActionStep[] = [
    { kind: 'wake', agentId: 'a2', prompt: 'Post the plan' },
    { kind: 'notify', text: 'Done' },
  ];

  it('makes the list line', () => {
    expect(describeAction({ trigger: { kind: 'schedule', preset: 'weekdays', cron: '0 9 * * 1-5', missed: 'skip' }, steps }, names))
      .toBe('Weekdays at 9:00 AM → Wake pm with a prompt, then notify you');
  });

  it('suggests a name from the trigger and first step', () => {
    expect(suggestActionName({
      trigger: { kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: 'a1' }, delayMinutes: 30 },
      steps: [{ kind: 'quick', projectId: 'p1', worktreeAgentId: 'a1', prompt: 'Tidy notes' }],
    }, names)).toBe('After release-lead goes to sleep, start a quick agent in release-lead’s worktree');
    expect(suggestActionName({ trigger: { kind: 'once', at: 1 }, steps }, names)).toBe('Once, wake pm with a prompt');
  });
});
