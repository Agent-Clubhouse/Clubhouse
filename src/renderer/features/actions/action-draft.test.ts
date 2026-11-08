import { describe, expect, it } from 'vitest';
import { draftFrom, draftToInput, newDraft, toLocalInput } from './action-draft';

const NOW = new Date(2026, 10, 9, 8, 0).getTime();

describe('action draft', () => {
  it('starts as a weekday schedule that needs an agent', () => {
    const d = newDraft(NOW);
    expect(d.when).toBe('schedule');
    expect(draftToInput(d)).toEqual({ ok: false, error: 'Step 1 needs an agent.' });
  });

  it('turns a preset and time into its cron line', () => {
    const d = { ...newDraft(NOW), preset: 'weekly' as const, weekday: 3, time: '17:30', steps: [{ ...newDraft().steps[0], kind: 'notify' as const, text: 'hi' }] };
    const r = draftToInput(d);
    expect(r.ok && r.input.trigger).toEqual({ kind: 'schedule', preset: 'weekly', cron: '30 17 * * 3', missed: 'skip' });
  });

  it('round-trips an event action with a wait and a quick agent step', () => {
    const input = {
      name: 'Tidy',
      trigger: { kind: 'event' as const, event: 'agent.slept' as const, source: { kind: 'agent' as const, agentId: 'lead' }, delayMinutes: 30 },
      steps: [{ kind: 'quick' as const, projectId: 'p1', worktreeAgentId: 'lead', prompt: 'Tidy notes' }],
      overlap: 'queue' as const,
    };
    const r = draftToInput(draftFrom(input, NOW), NOW);
    expect(r.ok && r.input).toEqual(input);
  });

  it('round-trips a one-time action in local time', () => {
    const at = new Date(2026, 10, 10, 14, 15).getTime();
    const d = draftFrom({ trigger: { kind: 'once', at }, steps: [{ kind: 'notify', text: 'x' }] }, NOW);
    expect(d.onceAt).toBe(toLocalInput(at));
    const r = draftToInput(d, NOW);
    expect(r.ok && r.input.trigger).toEqual({ kind: 'once', at });
    expect(draftToInput(d, at + 1)).toEqual({ ok: false, error: 'Pick a time in the future.' });
  });

  it('keeps a quick agent model override through an edit', () => {
    const input = { trigger: { kind: 'schedule' as const, preset: 'daily' as const, cron: '0 9 * * *', missed: 'skip' as const }, steps: [{ kind: 'quick' as const, projectId: 'p1', prompt: 'x', orchestrator: 'claude-code', model: 'opus' }] };
    const r = draftToInput(draftFrom(input, NOW), NOW);
    expect(r.ok && r.input.steps[0]).toMatchObject({ model: 'opus' });
  });

  it('refuses an empty time instead of saving midnight', () => {
    const steps = [{ ...newDraft().steps[0], kind: 'notify' as const, text: 'x' }];
    expect(draftToInput({ ...newDraft(NOW), time: '', steps }, NOW)).toEqual({ ok: false, error: 'Pick a time.' });
  });

  it('explains a bad custom line and a bad wait', () => {
    const steps = [{ ...newDraft().steps[0], kind: 'notify' as const, text: 'x' }];
    expect(draftToInput({ ...newDraft(NOW), preset: 'cron', cron: '61 * * * *', steps })).toMatchObject({ ok: false, error: expect.stringMatching(/minute/) });
    expect(draftToInput({ ...newDraft(NOW), when: 'event', source: 'agent:a', delay: 'x', steps })).toMatchObject({ ok: false, error: expect.stringMatching(/whole number/) });
  });
});
