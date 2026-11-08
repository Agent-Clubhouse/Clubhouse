import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));

import { appLog } from '../services/log-service';
import { abortPending } from './facade';
import { setProducingRuntime } from './__test-utils__/producing-runtime';
import {
  ACTIONS_TELEMETRY_MAX_EVENTS_PER_HOUR,
  _resetActionsTelemetryForTests,
  chainDepthBucket,
  installActionsTelemetry,
  missedBucket,
  recordActionObservation,
} from './actions-telemetry';
import { EVENTS, getAttributeSpec } from '../../shared/telemetry/attributes';
import type { EngineObservation } from '../services/actions/engine';
import type { TelemetryLevel } from '../../shared/telemetry/attributes';
import type { TelemetryRuntime } from './types';

const events: Array<{ name: string; attrs: Record<string, unknown>; kinds: Record<string, string> }> = [];

function runtime(level: TelemetryLevel = 'standard'): TelemetryRuntime {
  return {
    level,
    event: (name: string, attrs: Array<{ key: string; kind: string; value: unknown }> = []) =>
      events.push({
        name,
        attrs: Object.fromEntries(attrs.map((a) => [a.key, a.value])),
        kinds: Object.fromEntries(attrs.map((a) => [a.key, a.kind])),
      }),
    flow: vi.fn(), step: vi.fn(), count: vi.fn(), exception: vi.fn(), replaySpan: vi.fn(), replayTree: vi.fn(),
    preview: () => [], recentExports: () => [], forceFlush: async () => {}, shutdown: async () => {},
  } as unknown as TelemetryRuntime;
}

// Free text an action can hold. None of it may reach telemetry.
const SECRET_NAME = 'Nightly secret-project release';
const SECRET_REASON = 'Couldn’t run: release-lead in /Users/alice/secret-project is busy';
const AGENT_ID = 'agent_secret_42';
const ACTION_ID = 'act_secret_7';

const user = { actionId: ACTION_ID, owner: { kind: 'user' } } as const;
const agentOwned = { actionId: ACTION_ID, owner: { kind: 'agent', agentId: AGENT_ID } } as const;

function run(over: Partial<Extract<EngineObservation, { type: 'run' }>> = {}): EngineObservation {
  return {
    ...user,
    type: 'run',
    outcome: 'done',
    trigger: 'schedule',
    steps: 2,
    stepResults: [{ kind: 'wake', outcome: 'done' }, { kind: 'message', outcome: 'done' }],
    chainDepth: 0,
    durationMs: 1234,
    ...over,
  } as EngineObservation;
}

beforeEach(() => {
  _resetActionsTelemetryForTests(() => 0);
});

afterEach(() => {
  events.length = 0;
  setProducingRuntime(null);
  abortPending();
  _resetActionsTelemetryForTests();
  vi.mocked(appLog).mockClear();
});

describe('actions telemetry', () => {
  it('records nothing while telemetry is off', () => {
    recordActionObservation({ ...user, type: 'trigger', trigger: 'schedule' });
    recordActionObservation(run());
    expect(events).toEqual([]);
  });

  it('maps each trigger kind, with the event kind and delay for event triggers', () => {
    setProducingRuntime(runtime());
    for (const trigger of ['schedule', 'once', 'catch_up', 'manual'] as const) {
      recordActionObservation({ ...user, type: 'trigger', trigger });
    }
    recordActionObservation({ ...user, type: 'trigger', trigger: 'event', event: 'agent.idle', delayed: true });
    expect(events.map((e) => [e.name, e.attrs])).toEqual([
      ['clubhouse.action.triggered', { 'clubhouse.action.owner': 'user', 'clubhouse.action.trigger': 'schedule' }],
      ['clubhouse.action.triggered', { 'clubhouse.action.owner': 'user', 'clubhouse.action.trigger': 'once' }],
      ['clubhouse.action.triggered', { 'clubhouse.action.owner': 'user', 'clubhouse.action.trigger': 'catch_up' }],
      ['clubhouse.action.triggered', { 'clubhouse.action.owner': 'user', 'clubhouse.action.trigger': 'manual' }],
      ['clubhouse.action.triggered', {
        'clubhouse.action.owner': 'user', 'clubhouse.action.trigger': 'event',
        'clubhouse.action.event': 'agent.idle', 'clubhouse.action.delayed': true,
      }],
    ]);
  });

  it('maps waits, overlap, limits and catch-up to their codes', () => {
    setProducingRuntime(runtime());
    for (const what of ['started', 'restarted', 'cancelled', 'fired', 'dropped'] as const) {
      recordActionObservation({ ...user, type: 'wait', what, event: 'agent.slept' });
    }
    recordActionObservation({ ...user, type: 'overlap', what: 'skipped', trigger: 'event' });
    recordActionObservation({ ...user, type: 'overlap', what: 'queued', trigger: 'catch_up' });
    recordActionObservation({ ...user, type: 'limit', what: 'chain', chainDepth: 3 });
    recordActionObservation({ ...user, type: 'limit', what: 'self', chainDepth: 1 });
    recordActionObservation({ ...user, type: 'limit', what: 'hourly', chainDepth: 0 });
    recordActionObservation({ ...user, type: 'catch_up', missed: 10, rule: 'each' });
    recordActionObservation({ ...user, type: 'catch_up', missed: 3, rule: 'skip' });

    expect(events.slice(0, 5).map((e) => [e.name, e.attrs['clubhouse.action.wait'], e.attrs['clubhouse.action.event']])).toEqual([
      ['clubhouse.action.wait', 'started', 'agent.slept'],
      ['clubhouse.action.wait', 'restarted', 'agent.slept'],
      ['clubhouse.action.wait', 'cancelled', 'agent.slept'],
      ['clubhouse.action.wait', 'fired', 'agent.slept'],
      ['clubhouse.action.wait', 'dropped', 'agent.slept'],
    ]);
    expect(events.slice(5).map((e) => [e.name, e.attrs])).toEqual([
      ['clubhouse.action.overlap', { 'clubhouse.action.owner': 'user', 'clubhouse.action.overlap': 'skipped', 'clubhouse.action.trigger': 'event' }],
      ['clubhouse.action.overlap', { 'clubhouse.action.owner': 'user', 'clubhouse.action.overlap': 'queued', 'clubhouse.action.trigger': 'catch_up' }],
      ['clubhouse.action.limit_hit', { 'clubhouse.action.owner': 'user', 'clubhouse.action.limit': 'chain', 'clubhouse.action.chain_depth': '3+' }],
      ['clubhouse.action.limit_hit', { 'clubhouse.action.owner': 'user', 'clubhouse.action.limit': 'self', 'clubhouse.action.chain_depth': '1' }],
      ['clubhouse.action.limit_hit', { 'clubhouse.action.owner': 'user', 'clubhouse.action.limit': 'hourly', 'clubhouse.action.chain_depth': '0' }],
      ['clubhouse.action.catch_up', { 'clubhouse.action.owner': 'user', 'clubhouse.action.missed_bucket': '10+', 'clubhouse.action.missed_rule': 'each' }],
      ['clubhouse.action.catch_up', { 'clubhouse.action.owner': 'user', 'clubhouse.action.missed_bucket': '2-4', 'clubhouse.action.missed_rule': 'skip' }],
    ]);
  });

  it('records a run and each of its steps', () => {
    setProducingRuntime(runtime());
    recordActionObservation(run({
      outcome: 'failed',
      trigger: 'event',
      steps: 2,
      stepResults: [{ kind: 'wake', outcome: 'done' }, { kind: 'quick', outcome: 'failed' }],
      chainDepth: 1,
      reason: SECRET_REASON,
      reasonCode: 'step_failed',
    }));
    expect(events.map((e) => [e.name, e.attrs])).toEqual([
      ['clubhouse.action.run', {
        'clubhouse.action.owner': 'user',
        'clubhouse.action.run.outcome': 'failed',
        'clubhouse.action.run.reason': 'step_failed',
        'clubhouse.action.trigger': 'event',
        'clubhouse.action.run.steps': 2,
        'clubhouse.action.run.failed_step': 'quick',
        'clubhouse.action.chain_depth': '1',
        'clubhouse.action.run.duration_ms': 1234,
      }],
      ['clubhouse.action.step', { 'clubhouse.action.owner': 'user', 'clubhouse.action.step.kind': 'wake', 'clubhouse.action.step.outcome': 'done', 'clubhouse.action.step.index': 1 }],
      ['clubhouse.action.step', { 'clubhouse.action.owner': 'user', 'clubhouse.action.step.kind': 'quick', 'clubhouse.action.step.outcome': 'failed', 'clubhouse.action.step.index': 2 }],
    ]);
  });

  it('records a run that never started with its reason code and no steps', () => {
    setProducingRuntime(runtime());
    recordActionObservation(run({ outcome: 'skipped', steps: 0, stepResults: [], durationMs: 0, reason: 'The last run was still going', reasonCode: 'overlap' }));
    expect(events).toHaveLength(1);
    expect(events[0].attrs).toMatchObject({
      'clubhouse.action.run.outcome': 'skipped', 'clubhouse.action.run.reason': 'overlap',
      'clubhouse.action.run.steps': 0, 'clubhouse.action.run.failed_step': 'none',
    });
  });

  it('uses reason none for a successful run, and ignores a run still going', () => {
    setProducingRuntime(runtime());
    recordActionObservation(run({ outcome: 'running' }));
    recordActionObservation(run());
    expect(events.filter((e) => e.name === 'clubhouse.action.run').map((e) => e.attrs['clubhouse.action.run.reason'])).toEqual(['none']);
  });

  it('marks owners by kind: user, dispatcher, agent and Clubhouse itself', () => {
    setProducingRuntime(runtime());
    for (const owner of [{ kind: 'user' }, { kind: 'dispatcher' }, { kind: 'agent', agentId: AGENT_ID, helper: true }, { kind: 'app' }] as const) {
      recordActionObservation({ actionId: ACTION_ID, owner, type: 'trigger', trigger: 'schedule' });
    }
    expect(events.map((e) => e.attrs['clubhouse.action.owner'])).toEqual(['user', 'dispatcher', 'agent', 'app']);
  });

  it('never sends names, prompts, reasons or ids at the standard level', () => {
    setProducingRuntime(runtime('standard'));
    const all: EngineObservation[] = [
      { ...agentOwned, type: 'trigger', trigger: 'event', event: 'git.commit', delayed: false },
      { ...agentOwned, type: 'wait', what: 'started', event: 'agent.idle' },
      { ...agentOwned, type: 'overlap', what: 'skipped', trigger: 'schedule' },
      { ...agentOwned, type: 'limit', what: 'hourly', chainDepth: 2 },
      { ...agentOwned, type: 'catch_up', missed: 1, rule: 'once' },
      run({ ...agentOwned, outcome: 'failed', reason: `${SECRET_NAME}: ${SECRET_REASON}`, reasonCode: 'rights_refused' }),
    ];
    for (const o of all) recordActionObservation(o);
    expect(events.length).toBeGreaterThan(all.length);
    expect(events.some((e) => e.name === 'clubhouse.action.run_detail')).toBe(false);
    const sent = JSON.stringify(events);
    for (const secret of [SECRET_NAME, SECRET_REASON, AGENT_ID, ACTION_ID, 'secret', 'alice']) expect(sent).not.toContain(secret);
    for (const e of events) {
      expect(EVENTS[e.name as keyof typeof EVENTS]?.level, e.name).toBe('standard');
      for (const key of Object.keys(e.attrs)) {
        const spec = getAttributeSpec(key);
        expect(spec, key).toBeDefined();
        expect(spec?.kind, key).not.toBe('hash');
        if (spec?.kind === 'enum') expect(spec.values, key).toContain(e.attrs[key]);
      }
    }
  });

  it('adds the hashed action and owning agent ids at the detailed level only, never the reason text', () => {
    setProducingRuntime(runtime('detailed'));
    recordActionObservation(run({ ...agentOwned, outcome: 'failed', reason: SECRET_REASON, reasonCode: 'step_threw' }));
    const detail = events.find((e) => e.name === 'clubhouse.action.run_detail');
    expect(EVENTS['clubhouse.action.run_detail'].level).toBe('detailed');
    expect(detail?.attrs).toMatchObject({
      'clubhouse.action.owner': 'agent',
      'clubhouse.action.run.outcome': 'failed',
      'clubhouse.action.run.reason': 'step_threw',
      'clubhouse.action.id_hash': ACTION_ID,
      'clubhouse.agent.id_hash': AGENT_ID,
    });
    // Raw here; the facade replaces hash attributes with the salted HMAC before export.
    expect(detail?.kinds['clubhouse.action.id_hash']).toBe('hash');
    expect(detail?.kinds['clubhouse.agent.id_hash']).toBe('hash');
    expect(JSON.stringify(events)).not.toContain(SECRET_REASON);
  });

  it('turns unknown values into other instead of passing them through', () => {
    setProducingRuntime(runtime());
    recordActionObservation({ ...user, type: 'trigger', trigger: 'event', event: SECRET_NAME as 'git.commit' });
    expect(events[0].attrs['clubhouse.action.event']).toBe('other');
  });

  it('caps each chatty event per hour on its own, and logs the drops when the hour ends', () => {
    let now = 1_000;
    _resetActionsTelemetryForTests(() => now);
    setProducingRuntime(runtime());
    for (let i = 0; i < ACTIONS_TELEMETRY_MAX_EVENTS_PER_HOUR + 5; i++) {
      recordActionObservation({ ...user, type: 'wait', what: 'restarted', event: 'agent.idle' });
    }
    // Another capped event has its own budget.
    recordActionObservation({ ...user, type: 'trigger', trigger: 'event', event: 'agent.idle', delayed: true });
    const count = (name: string) => events.filter((e) => e.name === name).length;
    expect(count('clubhouse.action.wait')).toBe(ACTIONS_TELEMETRY_MAX_EVENTS_PER_HOUR);
    expect(count('clubhouse.action.triggered')).toBe(1);
    expect(appLog).not.toHaveBeenCalled();

    now += 60 * 60_000;
    recordActionObservation({ ...user, type: 'wait', what: 'started', event: 'agent.idle' });
    expect(count('clubhouse.action.wait')).toBe(ACTIONS_TELEMETRY_MAX_EVENTS_PER_HOUR + 1);
    expect(appLog).toHaveBeenCalledTimes(1);
    expect(appLog).toHaveBeenCalledWith('core:actions', 'info', expect.any(String), {
      meta: { dropped: { 'clubhouse.action.wait': 5 } },
    });
  });

  it('never caps runs, limit hits or catch-up, so a busy trigger can’t push out outcomes', () => {
    _resetActionsTelemetryForTests(() => 0);
    setProducingRuntime(runtime());
    for (let i = 0; i < ACTIONS_TELEMETRY_MAX_EVENTS_PER_HOUR; i++) {
      recordActionObservation({ ...user, type: 'trigger', trigger: 'event', event: 'agent.idle' });
      recordActionObservation({ ...user, type: 'overlap', what: 'skipped', trigger: 'event' });
    }
    // The steps' budget runs out partway; the run events keep coming.
    for (let i = 0; i < ACTIONS_TELEMETRY_MAX_EVENTS_PER_HOUR; i++) recordActionObservation(run({ outcome: 'failed', reasonCode: 'step_failed' }));
    recordActionObservation({ ...user, type: 'limit', what: 'hourly', chainDepth: 0 });
    recordActionObservation({ ...user, type: 'catch_up', missed: 2, rule: 'once' });
    const count = (name: string) => events.filter((e) => e.name === name).length;
    expect(count('clubhouse.action.run')).toBe(ACTIONS_TELEMETRY_MAX_EVENTS_PER_HOUR);
    expect(count('clubhouse.action.step')).toBe(ACTIONS_TELEMETRY_MAX_EVENTS_PER_HOUR);
    expect(count('clubhouse.action.limit_hit')).toBe(1);
    expect(count('clubhouse.action.catch_up')).toBe(1);
  });

  it('starts a new hour if the clock goes backwards', () => {
    let now = 5 * 60 * 60_000;
    _resetActionsTelemetryForTests(() => now);
    setProducingRuntime(runtime());
    for (let i = 0; i < ACTIONS_TELEMETRY_MAX_EVENTS_PER_HOUR + 1; i++) recordActionObservation({ ...user, type: 'trigger', trigger: 'schedule' });
    expect(events).toHaveLength(ACTIONS_TELEMETRY_MAX_EVENTS_PER_HOUR);
    now -= 1;
    recordActionObservation({ ...user, type: 'trigger', trigger: 'schedule' });
    expect(events).toHaveLength(ACTIONS_TELEMETRY_MAX_EVENTS_PER_HOUR + 1);
  });

  it('records the deleted reason code', () => {
    setProducingRuntime(runtime());
    recordActionObservation(run({ outcome: 'cancelled', steps: 0, stepResults: [], durationMs: 0, reasonCode: 'deleted' }));
    expect(events[0].attrs).toMatchObject({ 'clubhouse.action.run.outcome': 'cancelled', 'clubhouse.action.run.reason': 'deleted' });
  });

  it('never throws, even on a malformed observation', () => {
    setProducingRuntime(runtime());
    expect(() => recordActionObservation({ type: 'run' } as unknown as EngineObservation)).not.toThrow();
  });

  it('subscribes through the observer it is given and unsubscribes', () => {
    const unsubscribe = vi.fn();
    const observe = vi.fn(() => unsubscribe);
    const stop = installActionsTelemetry(observe);
    expect(observe).toHaveBeenCalledWith(recordActionObservation);
    stop();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('buckets chain depth and missed counts', () => {
    expect([0, 1, 2, 3, 7].map(chainDepthBucket)).toEqual(['0', '1', '2', '3+', '3+']);
    expect([0, 1, 2, 4, 5, 9, 10, 40].map(missedBucket)).toEqual(['0', '1', '2-4', '2-4', '5-9', '5-9', '10+', '10+']);
  });
});
