import { describe, expect, it } from 'vitest';
import { ActionError, assertActionInput, trimHistory, validateActionInput } from './validate';
import { HISTORY_MAX_AGE_MS, type ActionRun } from './types';

const schedule = { kind: 'schedule', preset: 'daily', cron: '0  9 * * *', missed: 'once' };

describe('validateActionInput', () => {
  it('keeps message delivery optional and validates its queue controls', () => {
    const step = { kind: 'message', agentId: 'a', text: 'hi' };
    const input = { trigger: schedule, steps: [step] };
    expect(assertActionInput(input).steps).toEqual([step]);
    expect(assertActionInput({ ...input, steps: [{ ...step, delivery: 'steer', latestOnly: true, maxWaitMinutes: 5 }] }).steps[0])
      .toEqual({ ...step, delivery: 'steer', latestOnly: true, maxWaitMinutes: 5 });
    for (const changes of [{ delivery: 'auto' }, { delivery: null }, { latestOnly: 'true' }, { latestOnly: null }, { maxWaitMinutes: 0 }, { maxWaitMinutes: 1.5 }, { maxWaitMinutes: 10081 }, { maxWaitMinutes: null }]) {
      expect(() => assertActionInput({ ...input, steps: [{ ...step, ...changes }] })).toThrow(ActionError);
    }
  });
  it('accepts seconds debounce with idle re-checks and rejects ambiguous or invalid timing', () => {
    const trigger = { kind: 'event', event: 'agent.idle', source: { kind: 'agent', agentId: 'a' }, delaySeconds: 30 };
    const input = { trigger, steps: [{ kind: 'notify', text: 'hi' }] };
    expect(assertActionInput(input).trigger).toEqual(trigger);
    for (const changes of [
      { delaySeconds: 0 }, { delaySeconds: -1 }, { delaySeconds: 0.5 }, { delaySeconds: 604801 },
      { delaySeconds: null }, { delaySeconds: '30' }, { delayMinutes: 1 }, { coalesceSeconds: 10 },
      { event: 'agent.turn_ended', source: { kind: 'any' } },
    ]) expect(() => assertActionInput({ ...input, trigger: { ...trigger, ...changes } })).toThrow(ActionError);
  });
  it('accepts optional event throttles and refuses invalid windows or run counts', () => {
    const trigger = { kind: 'event', event: 'app.started', source: { kind: 'app' } };
    const input = { trigger, steps: [{ kind: 'notify', text: 'hi' }] };
    expect(assertActionInput({ ...input, trigger: { ...trigger, throttle: { maxRuns: 2, perMinutes: 5 } } }).trigger).toMatchObject({ throttle: { maxRuns: 2, perMinutes: 5 } });
    for (const throttle of [null, {}, { maxRuns: 0, perMinutes: 5 }, { maxRuns: 1.5, perMinutes: 5 }, { maxRuns: 2, perMinutes: 0 }, { maxRuns: 2, perMinutes: 10_081 }]) {
      expect(() => assertActionInput({ ...input, trigger: { ...trigger, throttle } })).toThrow(ActionError);
    }
  });
  it('validates device events and filters without changing delay defaults or retaining private fields', () => {
    const trigger = { kind: 'event', event: 'device.online', source: { kind: 'device', deviceId: ' AA ', deviceKind: 'phone', address: 'secret', port: 123, certificate: 'secret' } };
    const input = { trigger, steps: [{ kind: 'notify', text: 'hi' }] };
    expect(validateActionInput(input)).toMatchObject({ ok: true, value: { trigger: {
      kind: 'event', event: 'device.online', source: { kind: 'device', deviceId: 'aa', deviceKind: 'phone' },
    } } });
    const valid = validateActionInput(input);
    expect(valid.ok && valid.value.trigger).not.toHaveProperty('delayMinutes');
    expect(valid.ok && valid.value.trigger).not.toHaveProperty('source.address');
    for (const source of [{ kind: 'app' }, { kind: 'device', deviceId: '' }, { kind: 'device', deviceKind: 'desktop' }, { kind: 'device', deviceId: 7 }]) {
      expect(validateActionInput({ ...input, trigger: { ...trigger, source } }).ok).toBe(false);
    }
    expect(validateActionInput({ ...input, trigger: { ...trigger, event: 'agent.slept' } }).ok).toBe(false);
    expect(validateActionInput({ ...input, trigger: { ...trigger, event: 'device.offline', source: { kind: 'device' }, delayMinutes: 2 } }).ok).toBe(true);
  });

  it('retains Auto difficulty and refuses incompatible quick-step overrides', () => {
    const step = { kind: 'quick', projectId: 'p1', prompt: 'Review', orchestrator: 'auto', difficulty: 'hard' };
    expect(validateActionInput({ trigger: schedule, steps: [step] })).toMatchObject({ ok: true, value: { steps: [step] } });
    for (const changes of [{ difficulty: 'maximum' }, { difficulty: null }, { orchestrator: 'claude-code' }, { model: 'opus' }]) {
      expect(validateActionInput({ trigger: schedule, steps: [{ ...step, ...changes }] }).ok).toBe(false);
    }
  });

  it('accepts any readable agent for turn and quick-finish events with bounded grouping and no delay', () => {
    const trigger = { kind: 'event', event: 'agent.turn_ended', source: { kind: 'any' } };
    const input = { trigger, steps: [{ kind: 'notify', text: 'hi' }] };
    expect(validateActionInput(input)).toMatchObject({ ok: true, value: { trigger } });
    expect(validateActionInput({ ...input, trigger: { ...trigger, event: 'agent.quick_finished' } })).toMatchObject({
      ok: true, value: { trigger: { event: 'agent.quick_finished', source: { kind: 'any' } } },
    });
    for (const coalesceSeconds of [10, 60, 600]) {
      expect(validateActionInput({ ...input, trigger: { ...trigger, event: 'agent.turn_failed', coalesceSeconds } })).toMatchObject({ ok: true, value: { trigger: { coalesceSeconds } } });
    }
    for (const changes of [
      ...[9, 601, 10.5, '60', null, NaN].map((coalesceSeconds) => ({ coalesceSeconds })),
      ...['agent.idle', 'agent.slept', 'git.commit', 'app.started'].map((event) => ({ event })),
      { delayMinutes: 1 }, { delayMinutes: 0 }, { delayMinutes: null },
    ]) {
      expect(() => assertActionInput({ ...input, trigger: { ...trigger, ...changes } })).toThrow(ActionError);
    }
  });

  it('validates generic event time filters as strict local HH:MM and a boolean', () => {
    const trigger = { kind: 'event', event: 'agent.turn_ended', source: { kind: 'agent', agentId: 'a' }, afterLocalTime: '08:00', oncePerDay: true };
    const input = { trigger, steps: [{ kind: 'notify', text: 'hi' }] };
    expect(validateActionInput(input)).toMatchObject({ ok: true, value: { trigger } });
    for (const afterLocalTime of ['8:00', '24:00', '12:60', '', '08:00Z', 800, null]) {
      expect(validateActionInput({ ...input, trigger: { ...trigger, afterLocalTime } }).ok).toBe(false);
    }
    for (const oncePerDay of [0, 'true', null]) expect(validateActionInput({ ...input, trigger: { ...trigger, oncePerDay } }).ok).toBe(false);
  });

  it('accepts fixed coalescing on agent, git and app sources but not alongside a delay', () => {
    for (const trigger of [
      { kind: 'event', event: 'agent.turn_ended', source: { kind: 'project', projectId: 'p' } },
      { kind: 'event', event: 'git.commit', source: { kind: 'agent', agentId: 'a' } },
      { kind: 'event', event: 'app.started', source: { kind: 'app' } },
    ]) {
      const input = { trigger: { ...trigger, coalesceSeconds: 10 }, steps: [{ kind: 'notify', text: 'hi' }] };
      expect(assertActionInput(input).trigger).toEqual(input.trigger);
      expect(() => assertActionInput({ ...input, trigger: { ...input.trigger, delayMinutes: 1 } })).toThrow(/either a delay/);
    }
  });

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

  it('keeps a fresh expiry receipt even when the queued handoff was more than 72 hours ago', () => {
    const expired = { ...run(1, HISTORY_MAX_AGE_MS + 1, 'expired'), deliveryUpdatedAt: now };
    expect(trimHistory([expired, run(2, 1)], now).map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('keeps a run that is still going', () => {
    expect(trimHistory([run(1, HISTORY_MAX_AGE_MS + 5, 'running')], now)).toHaveLength(1);
  });
});
