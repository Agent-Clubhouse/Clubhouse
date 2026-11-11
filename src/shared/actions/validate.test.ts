import { describe, expect, it } from 'vitest';
import { ActionError, assertActionInput, trimHistory, validateActionInput } from './validate';
import { HISTORY_MAX_AGE_MS, type ActionRun } from './types';

const schedule = { kind: 'schedule', preset: 'daily', cron: '0  9 * * *', missed: 'once' };

describe('validateActionInput', () => {
  it('validates a return threshold and keeps the optional default absent', () => {
    const trigger = { kind: 'event', event: 'app.returned', source: { kind: 'app' } };
    const input = { trigger, steps: [{ kind: 'notify', text: 'hi' }] };
    expect(validateActionInput(input)).toMatchObject({ ok: true, value: { trigger } });
    expect(validateActionInput({ ...input, trigger: { ...trigger, absenceMinutes: 5 } })).toMatchObject({ ok: true, value: { trigger: { absenceMinutes: 5 } } });
    for (const absenceMinutes of [0, 4, 5.5, '30', null, NaN]) {
      expect(validateActionInput({ ...input, trigger: { ...trigger, absenceMinutes } }).ok).toBe(false);
    }
    expect(validateActionInput({ ...input, trigger: { ...trigger, event: 'app.started', absenceMinutes: 30 } }).ok).toBe(false);
  });

  it('accepts optional recurring limits and rejects invalid limits with invalid_input', () => {
    const input = { trigger: schedule, steps: [{ kind: 'notify', text: 'hi' }] };
    const now = 100_000;
    expect(validateActionInput({ ...input, endsAt: now + 1, maxRuns: 5 }, { now })).toMatchObject({ ok: true, value: { endsAt: now + 1, maxRuns: 5 } });
    for (const limits of [{ endsAt: now - 1 }, { endsAt: NaN }, { maxRuns: 0 }, { maxRuns: -1 }, { maxRuns: 1.5 }, { maxRuns: Infinity }]) {
      try { assertActionInput({ ...input, ...limits }, now); expect.fail('Expected a refusal'); }
      catch (err) { expect(err).toMatchObject({ code: 'invalid_input' }); }
    }
    for (const limits of [{ endsAt: now + 1 }, { maxRuns: 1 }]) {
      expect(validateActionInput({ ...input, trigger: { kind: 'once', at: now + 1 }, ...limits }, { now }).ok).toBe(false);
    }
  });

  it('normalizes a valid action and drops unknown fields', () => {
    const r = validateActionInput({ name: '  Morning  ', trigger: schedule, steps: [{ kind: 'wake', agentId: 'a1', prompt: '', extra: 1 }], junk: true });
    expect(r).toEqual({
      ok: true,
      value: {
        name: 'Morning',
        trigger: { kind: 'schedule', preset: 'daily', cron: '0 9 * * *', missed: 'once' },
        steps: [{ kind: 'wake', agentId: 'a1' }],
        overlap: 'skip',
        enabled: true,
      },
    });
  });

  it('labels a preset whose line doesn’t match it as custom', () => {
    const r = validateActionInput({ trigger: { kind: 'schedule', preset: 'daily', cron: '* * * * *' }, steps: [{ kind: 'notify', text: 'hi' }] });
    expect(r.ok && r.value.trigger).toMatchObject({ preset: 'cron', cron: '* * * * *' });
    const weekly = validateActionInput({ trigger: { kind: 'schedule', preset: 'weekly', cron: '15 8 * * 2' }, steps: [{ kind: 'notify', text: 'hi' }] });
    expect(weekly.ok && weekly.value.trigger).toMatchObject({ preset: 'weekly' });
  });

  it('defaults an unknown missed-run rule to skip and an unknown preset to custom', () => {
    const r = validateActionInput({ trigger: { kind: 'schedule', preset: 'x', cron: '0 9 * * *', missed: 'x' }, steps: [{ kind: 'notify', text: 'hi' }] });
    expect(r.ok && r.value.trigger).toEqual({ kind: 'schedule', preset: 'cron', cron: '0 9 * * *', missed: 'skip' });
  });

  it.each([
    [{ trigger: schedule, steps: [] }, /at least one step/],
    [{ trigger: schedule, steps: [1, 2, 3, 4].map(() => ({ kind: 'notify', text: 'x' })) }, /at most 3 steps/],
    [{ trigger: { ...schedule, cron: 'bad' }, steps: [{ kind: 'notify', text: 'x' }] }, /5 parts/],
    [{ trigger: schedule, steps: [{ kind: 'message', agentId: 'a1', text: ' ' }] }, /message is required/],
    [{ trigger: schedule, steps: [{ kind: 'quick', prompt: 'x' }] }, /needs a project/],
    [{ trigger: schedule, steps: [{ kind: 'wake' }] }, /needs an agent/],
    [{ trigger: { kind: 'event', event: 'agent.idle', source: { kind: 'agent', agentId: 'a' } }, steps: [{ kind: 'notify', text: 'x' }] }, /idle time/],
    [{ trigger: { kind: 'event', event: 'agent.woke' }, steps: [{ kind: 'notify', text: 'x' }] }, /agent or a project/],
    [{ trigger: { kind: 'event', event: 'agent.woke', source: { kind: 'agent', agentId: 'a' }, delayMinutes: 1.5 }, steps: [{ kind: 'notify', text: 'x' }] }, /whole number/],
    [{ trigger: { kind: 'once' }, steps: [{ kind: 'notify', text: 'x' }] }, /date and time/],
    [{ trigger: { kind: 'never' }, steps: [{ kind: 'notify', text: 'x' }] }, /schedule, an event, or once/],
  ])('refuses %j', (input, message) => {
    const r = validateActionInput(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it('gives app events no source and keeps a git branch filter', () => {
    const app = validateActionInput({ trigger: { kind: 'event', event: 'app.started', source: { kind: 'agent', agentId: 'x' } }, steps: [{ kind: 'notify', text: 'x' }] });
    expect(app.ok && app.value.trigger).toEqual({ kind: 'event', event: 'app.started', source: { kind: 'app' } });
    const git = validateActionInput({ trigger: { kind: 'event', event: 'git.commit', source: { kind: 'project', projectId: 'p' }, branch: ' main ' }, steps: [{ kind: 'notify', text: 'x' }] });
    expect(git.ok && git.value.trigger).toEqual({ kind: 'event', event: 'git.commit', source: { kind: 'project', projectId: 'p' }, branch: 'main' });
  });

  it('throws a typed error', () => {
    expect(() => assertActionInput({})).toThrow(ActionError);
    try { assertActionInput({}); } catch (err) { expect((err as ActionError).code).toBe('invalid_input'); }
  });
});

describe('trimHistory', () => {
  const now = 1_000_000_000_000;
  const run = (i: number, ageMs: number, outcome: ActionRun['outcome'] = 'done'): ActionRun => ({
    id: `r${i}`, actionId: 'a', trigger: { kind: 'schedule', at: now - ageMs }, chain: [], startedAt: now - ageMs, outcome, steps: [],
  });

  it('keeps at most 10 runs', () => {
    const runs = Array.from({ length: 15 }, (_, i) => run(i, i * 1000));
    expect(trimHistory(runs, now).map((r) => r.id)).toEqual(Array.from({ length: 10 }, (_, i) => `r${i}`));
  });

  it('drops runs older than 72 hours', () => {
    const runs = [run(1, 1000), run(2, HISTORY_MAX_AGE_MS + 1)];
    expect(trimHistory(runs, now).map((r) => r.id)).toEqual(['r1']);
  });

  it('keeps a run that is still going', () => {
    expect(trimHistory([run(1, HISTORY_MAX_AGE_MS + 5, 'running')], now)).toHaveLength(1);
  });
});
