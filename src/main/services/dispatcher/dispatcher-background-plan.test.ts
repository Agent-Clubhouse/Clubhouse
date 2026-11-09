import { describe, expect, it } from 'vitest';
import { nextCronTime, parseCron, validateActionInput, validateTrigger } from '../../../shared/actions';
import { DISPATCHER_BEHAVIORS, DISPATCHER_BEHAVIOR_PLANS, dispatcherBehaviorPlan } from '../../../shared/dispatcher-behavior';
import {
  CHECK_IN_ACTION,
  CHECK_IN_CRON,
  IDLE_UPKEEP_MINUTES,
  NIGHTLY_UPKEEP_CRON,
  UPKEEP_IDLE_ACTION,
  UPKEEP_NIGHTLY_ACTION,
  backgroundActionSpecs,
  backgroundWorkOf,
} from './dispatcher-background-plan';

const DISPATCHER = 'disp-1';

function byName(level: string) {
  return Object.fromEntries(backgroundActionSpecs(dispatcherBehaviorPlan(level), DISPATCHER).map((s) => [s.name, s]));
}

describe('backgroundActionSpecs: each Behavior level yields its triggers', () => {
  it('Light: nightly upkeep only, no check-ins and no idle upkeep', () => {
    const specs = byName('light');
    expect(Object.keys(specs)).toEqual([UPKEEP_NIGHTLY_ACTION]);
    const nightly = specs[UPKEEP_NIGHTLY_ACTION];
    expect(nightly.kind).toBe('action');
    expect(nightly.input.trigger).toEqual({ kind: 'schedule', preset: 'daily', cron: NIGHTLY_UPKEEP_CRON, missed: 'once' });
  });

  it('Standard: nightly upkeep, upkeep after a long idle stretch, occasional check-ins', () => {
    const specs = byName('standard');
    expect(Object.keys(specs).sort()).toEqual([CHECK_IN_ACTION, UPKEEP_IDLE_ACTION, UPKEEP_NIGHTLY_ACTION].sort());
    expect(specs[UPKEEP_IDLE_ACTION]).toMatchObject({
      kind: 'subscription',
      work: 'upkeep',
      input: { trigger: { kind: 'event', event: 'agent.idle', source: { kind: 'agent', agentId: DISPATCHER }, delayMinutes: 120 } },
    });
    expect(specs[CHECK_IN_ACTION]).toMatchObject({
      kind: 'action',
      work: 'check_in',
      input: { trigger: { kind: 'schedule', cron: CHECK_IN_CRON.occasionally, missed: 'skip' }, steps: [{ kind: 'message', agentId: DISPATCHER }] },
    });
  });

  it('Thorough: upkeep after each idle stretch and frequent check-ins', () => {
    const specs = byName('thorough');
    expect(Object.keys(specs).sort()).toEqual([CHECK_IN_ACTION, UPKEEP_IDLE_ACTION, UPKEEP_NIGHTLY_ACTION].sort());
    const idle = specs[UPKEEP_IDLE_ACTION].input.trigger;
    expect(idle.kind === 'event' && idle.delayMinutes).toBe(IDLE_UPKEEP_MINUTES.nightly_and_each_idle);
    expect(specs[CHECK_IN_ACTION].input.trigger).toMatchObject({ cron: CHECK_IN_CRON.frequently });
  });

  it('Thorough checks in more often and idles less before upkeep than Standard', () => {
    const day = (cron: string) => {
      const parsed = parseCron(cron);
      if (!parsed.ok) throw new Error(parsed.error);
      let t = new Date(2026, 10, 9, 0, 0).getTime();
      const end = t + 24 * 60 * 60 * 1000;
      let n = 0;
      for (;;) {
        const next = nextCronTime(parsed.spec, t)?.getTime();
        if (next === undefined || next >= end) return n;
        n++;
        t = next;
      }
    };
    expect(day(CHECK_IN_CRON.frequently!)).toBeGreaterThan(day(CHECK_IN_CRON.occasionally!));
    expect(day(CHECK_IN_CRON.occasionally!)).toBeGreaterThan(0);
    expect(IDLE_UPKEEP_MINUTES.nightly_and_each_idle!).toBeLessThan(IDLE_UPKEEP_MINUTES.nightly_and_long_idle!);
  });

  it('every bucket of every level maps to a trigger the Actions validator accepts', () => {
    for (const level of DISPATCHER_BEHAVIORS) {
      for (const spec of backgroundActionSpecs(DISPATCHER_BEHAVIOR_PLANS[level], DISPATCHER)) {
        if (spec.kind === 'action') {
          const valid = validateActionInput({ ...spec.input, name: spec.name });
          expect(valid.ok, `${level} ${spec.name}: ${valid.error}`).toBe(true);
          // The preset label never claims a time its line doesn't use.
          expect(valid.value?.trigger).toEqual(spec.input.trigger);
        } else {
          expect(validateTrigger(spec.input.trigger)).toEqual({ ok: true, value: spec.input.trigger });
        }
      }
    }
  });

  it('only messages the Dispatcher: no quick agents (D140), no other agent', () => {
    for (const level of DISPATCHER_BEHAVIORS) {
      for (const spec of backgroundActionSpecs(DISPATCHER_BEHAVIOR_PLANS[level], DISPATCHER)) {
        if (spec.kind === 'action') expect(spec.input.steps).toEqual([expect.objectContaining({ kind: 'message', agentId: DISPATCHER })]);
        else expect(spec.input.note).toBeTruthy();
      }
    }
  });

  it('makes nothing without a Dispatcher agent to tell', () => {
    expect(backgroundActionSpecs(DISPATCHER_BEHAVIOR_PLANS.thorough, null)).toEqual([]);
    expect(backgroundActionSpecs(DISPATCHER_BEHAVIOR_PLANS.thorough, undefined)).toEqual([]);
  });

  it('names each action’s work', () => {
    expect(backgroundWorkOf(UPKEEP_NIGHTLY_ACTION)).toBe('upkeep');
    expect(backgroundWorkOf(UPKEEP_IDLE_ACTION)).toBe('upkeep');
    expect(backgroundWorkOf(CHECK_IN_ACTION)).toBe('check_in');
    expect(backgroundWorkOf('Weekdays at 9:00 AM, notify you')).toBeUndefined();
  });
});
