import { describe, expect, it } from 'vitest';
import { draftFrom, draftToInput, newDraft, toLocalInput } from './action-draft';

const NOW = new Date(2026, 10, 9, 8, 0).getTime();

describe('action draft', () => {
  it('round-trips Auto difficulty without changing older quick steps', () => {
    const old = {
      trigger: { kind: 'schedule', preset: 'daily', cron: '0 9 * * *', missed: 'skip' } as const,
      steps: [{ kind: 'quick', projectId: 'p1', prompt: 'Review' }] as import('../../../shared/actions').ActionStep[],
    };
    expect(draftToInput(draftFrom(old), NOW)).toMatchObject({ ok: true, input: old });
    const draft = draftFrom(old);
    draft.steps[0].orchestrator = 'auto';
    expect(draftToInput(draft, NOW)).toMatchObject({ ok: true, input: { steps: [{ ...old.steps[0], orchestrator: 'auto', difficulty: 'medium' }] } });
    draft.steps[0].difficulty = 'hard';
    expect(draftToInput(draft, NOW)).toMatchObject({ ok: true, input: { steps: [{ difficulty: 'hard' }] } });
  });

  it('round-trips an any-agent window and keeps grouping available for other sources', () => {
    const input = {
      trigger: { kind: 'event', event: 'agent.turn_ended', source: { kind: 'any' }, coalesceSeconds: 15 } as const,
      steps: [{ kind: 'notify', text: 'hi' }],
    };
    const draft = draftFrom(input, NOW);
    expect(draft.source).toBe('any');
    expect(draftToInput({ ...draft, delay: '30' }, NOW)).toMatchObject({ ok: true, input });
    expect(draftToInput({ ...draft, delay: '0.5' }, NOW)).toMatchObject({ ok: true, input });
    expect(draftToInput({ ...draft, coalesceSeconds: '9' }, NOW).ok).toBe(false);
    const specific = draftToInput({ ...draft, source: 'agent:a' }, NOW);
    expect(specific.ok && specific.input.trigger).toEqual({ kind: 'event', event: 'agent.turn_ended', source: { kind: 'agent', agentId: 'a' }, coalesceSeconds: 15 });
  });

  it('round-trips seconds, general coalescing, throttle and message delivery without changing legacy defaults', () => {
    const steps = [{ kind: 'message', agentId: 'a', text: 'Check', delivery: 'steer', latestOnly: true, maxWaitMinutes: 5 }] as import('../../../shared/actions').ActionStep[];
    const input = {
      trigger: { kind: 'event', event: 'git.commit', source: { kind: 'project', projectId: 'p' }, delaySeconds: 30, throttle: { maxRuns: 2, perMinutes: 5 } } as const, steps,
    };
    const draft = draftFrom(input, NOW);
    expect(draft).toMatchObject({ timing: 'delay', delay: '30', delayUnit: 'seconds', throttleMaxRuns: '2', throttlePerMinutes: '5' });
    expect(draftToInput(draft, NOW)).toMatchObject({ ok: true, input });
    const coalesced = draftToInput({ ...draft, timing: 'coalesce', coalesceSeconds: '15' }, NOW);
    expect(coalesced.ok && coalesced.input.trigger).toEqual({ kind: 'event', event: 'git.commit', source: { kind: 'project', projectId: 'p' }, coalesceSeconds: 15, throttle: { maxRuns: 2, perMinutes: 5 } });
    expect(draftToInput({ ...draft, throttlePerMinutes: '' }, NOW).ok).toBe(false);
    const noTiming = draftToInput({ ...draft, timing: 'none' }, NOW);
    expect(noTiming.ok && noTiming.input.trigger).not.toHaveProperty('delaySeconds');
  });

  it('round-trips generic time filters and omits them after switching to a schedule', () => {
    const input = {
      trigger: { kind: 'event', event: 'app.returned', source: { kind: 'app' }, afterLocalTime: '08:00', oncePerDay: true } as const,
      steps: [{ kind: 'notify', text: 'hi' }] as const,
    };
    const draft = draftFrom({ ...input, steps: [...input.steps] }, NOW);
    expect(draftToInput(draft, NOW)).toMatchObject({ ok: true, input });
    expect(draftToInput({ ...draft, afterLocalTime: '24:00' }, NOW).ok).toBe(false);
    const schedule = draftToInput({ ...draft, when: 'schedule' }, NOW);
    expect(schedule.ok && schedule.input.trigger).not.toHaveProperty('oncePerDay');
    expect(schedule.ok && schedule.input.trigger).not.toHaveProperty('afterLocalTime');
  });

  it('round-trips an app return threshold', () => {
    const input = {
      trigger: { kind: 'event', event: 'app.returned', source: { kind: 'app' }, absenceMinutes: 15 } as const,
      steps: [{ kind: 'notify', text: 'hi' }] as const,
    };
    const draft = draftFrom({ ...input, steps: [...input.steps] }, NOW);
    expect(draftToInput(draft, NOW)).toMatchObject({ ok: true, input });
    expect(draftToInput({ ...draft, absenceMinutes: '4' }, NOW).ok).toBe(false);
  });

  it('round-trips recurring limits and omits them when changed to once', () => {
    const input = {
      trigger: { kind: 'event', event: 'app.started', source: { kind: 'app' } } as const,
      steps: [{ kind: 'notify', text: 'hi' }] as const,
      endsAt: NOW + 60 * 60_000, maxRuns: 5,
    };
    const draft = draftFrom({ ...input, steps: [...input.steps] }, NOW);
    expect(draftToInput(draft, NOW)).toMatchObject({ ok: true, input });
    expect(draftToInput({ ...draft, maxRuns: '1.5' }, NOW).ok).toBe(false);
    expect(draftToInput(draft, input.endsAt + 1).ok).toBe(false);
    const once = draftToInput({ ...draft, when: 'once' }, NOW);
    expect(once.ok && once.input.endsAt).toBeUndefined();
    expect(once.ok && once.input.maxRuns).toBeUndefined();
  });

  it.each(['2027-01-05T14:15:32.123Z', '2027-11-07T06:30:00.000Z'])(
    'preserves an unchanged absolute end time through edits: %s',
    (timestamp) => {
      const endsAt = Date.parse(timestamp);
      const draft = draftFrom({
        trigger: { kind: 'event', event: 'app.started', source: { kind: 'app' } },
        steps: [{ kind: 'notify', text: 'hi' }],
        endsAt,
      }, NOW);
      expect(draft.endsAt).toBe(toLocalInput(endsAt));
      expect(draftToInput({ ...draft, name: 'Renamed' }, NOW)).toMatchObject({ ok: true, input: { endsAt } });
      const changed = draftToInput({ ...draft, endsAt: '2027-12-01T10:15' }, NOW);
      expect(changed).toMatchObject({ ok: true, input: { endsAt: new Date(2027, 11, 1, 10, 15).getTime() } });
      const cleared = draftToInput({ ...draft, endsAt: '' }, NOW);
      expect(cleared.ok && cleared.input.endsAt).toBeUndefined();
    },
  );

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
    expect(draftToInput({ ...newDraft(NOW), when: 'event', source: 'agent:a', timing: 'delay', delay: 'x', steps })).toMatchObject({ ok: false, error: expect.stringMatching(/whole number/) });
  });
});
