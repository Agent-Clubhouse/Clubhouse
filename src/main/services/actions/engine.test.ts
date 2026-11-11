import { describe, expect, it, vi } from 'vitest';
import type { Action, ActionRun, ActionStep, ActionStepResult } from '../../../shared/actions';
import type { AppEvent, AppEventInput } from '../app-event-bus';
import {
  ActionsEngine,
  MAX_QUEUED_RUNS,
  type EngineFacts,
  type EngineHooks,
  type EngineState,
  type StepContext,
} from './engine';

// ── Fakes ───────────────────────────────────────────────────────────────────

class FakeClock {
  t: number;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private seq = 0;
  constructor(start: number) { this.t = start; }
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => { const id = ++this.seq; this.timers.push({ at: this.t + ms, fn, id }); return id; };
  clearTimeout = (h: unknown) => { this.timers = this.timers.filter((x) => x.id !== h); };
  /** Move time forward, running timers as they come due. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

/** 2026-11-09 (a Monday) 08:00 local. */
const START = new Date(2026, 10, 9, 8, 0).getTime();
const MIN = 60_000;

interface Setup {
  actions?: Action[];
  state?: EngineState;
  agents?: Record<string, { name: string; projectId: string; worktree?: string }>;
  running?: Set<string>;
  stepImpl?: (step: ActionStep, ctx: StepContext) => Promise<ActionStepResult>;
  refuse?: (step: ActionStep) => string | null;
  refuseSource?: (trigger: Action['trigger']) => string | null;
  maxActions?: number;
  start?: number;
  /** The Dispatcher's agent id, for subscriptions that tell it. */
  dispatcher?: string;
}

function setup(opts: Setup = {}) {
  const clock = new FakeClock(opts.start ?? START);
  const agents = opts.agents ?? {
    lead: { name: 'release-lead', projectId: 'p1', worktree: '/p1/.wt/lead' },
    pm: { name: 'pm', projectId: 'p1' },
    other: { name: 'other', projectId: 'p2' },
  };
  const running = opts.running ?? new Set<string>();
  const saved: { actions: Action[]; state: EngineState } = { actions: opts.actions ?? [], state: opts.state ?? { nextAt: {}, waits: [] } };
  const runs = new Map<string, ActionRun>();
  const facts: EngineFacts = {
    agentExists: (id) => !!agents[id],
    isRunning: (id) => running.has(id),
    agentName: (id) => agents[id]?.name,
    agentProjectId: (id) => agents[id]?.projectId,
    projectName: (id) => ({ p1: 'web', p2: 'api' } as Record<string, string>)[id],
    projectIdForPath: (p) => ({ '/p1': 'p1', '/p2': 'p2' } as Record<string, string>)[p],
    repoOwner: (repo) => {
      for (const [id, a] of Object.entries(agents)) if (a.worktree === repo) return { agentId: id, projectId: a.projectId };
      return { projectId: ({ '/p1': 'p1', '/p2': 'p2' } as Record<string, string>)[repo] };
    },
    dispatcherAgentId: () => opts.dispatcher,
  };
  const stepCalls: Array<{ step: ActionStep; ctx: StepContext }> = [];
  const hooks: Required<Pick<EngineHooks, 'failed' | 'turnedOff' | 'changed' | 'observe'>> = {
    failed: vi.fn(), turnedOff: vi.fn(), changed: vi.fn(), observe: vi.fn(),
  };
  let n = 0;
  const engine = new ActionsEngine({
    clock,
    storage: {
      load: () => ({ actions: saved.actions, state: saved.state }),
      saveActions: (a) => { saved.actions = a; },
      saveState: (s) => { saved.state = s; },
    },
    history: {
      put: (run) => { runs.set(run.id, JSON.parse(JSON.stringify(run))); },
      list: (id) => [...runs.values()].filter((r) => r.actionId === id).sort((a, b) => a.startedAt - b.startedAt),
    },
    facts,
    steps: {
      run: async (step, ctx) => {
        stepCalls.push({ step, ctx });
        if (opts.stepImpl) return opts.stepImpl(step, ctx);
        return { kind: step.kind, outcome: 'done', detail: 'ok' };
      },
    },
    rights: {
      checkStep: (_owner, step) => opts.refuse?.(step) ?? null,
      checkSource: (_owner, trigger) => opts.refuseSource?.(trigger) ?? null,
      maxActions: (owner) => (owner.kind === 'user' ? null : opts.maxActions ?? null),
    },
    hooks,
    newId: () => String(++n),
  });
  const history = (id: string) => engine.history(id);
  const event = (e: AppEventInput) => engine.handleEvent({ at: clock.t, ...e } as AppEvent);
  return { clock, engine, saved, history, stepCalls, hooks, running, event };
}

const notify: ActionStep = { kind: 'notify', text: 'hi' };
const weekdays9 = { kind: 'schedule', preset: 'weekdays', cron: '0 9 * * 1-5', missed: 'skip' } as const;
const user = { kind: 'user' } as const;

describe('event time filters', () => {
  const trigger = { kind: 'event', event: 'app.started', source: { kind: 'app' } } as const;

  it('ignores early events and consumes the day only when a run starts, including failed Run now', async () => {
    const h = setup({ start: START - MIN, stepImpl: async () => ({ kind: 'notify', outcome: 'failed', detail: 'Unavailable' }) });
    h.engine.start();
    const a = h.engine.create({ trigger: { ...trigger, afterLocalTime: '08:00', oncePerDay: true }, steps: [notify] }, user);
    h.event({ type: 'app.started' });
    h.engine.runNow(a.id);
    expect(h.stepCalls).toHaveLength(0);
    expect(h.saved.state.lastFiredDate?.[a.id]).toBeUndefined();
    h.clock.t = START;
    h.engine.runNow(a.id);
    await flush();
    expect(h.history(a.id).at(-1)?.outcome).toBe('failed');
    expect(h.saved.state.lastFiredDate?.[a.id]).toBe('2026-11-09');
    h.event({ type: 'app.started' });
    h.engine.runNow(a.id);
    expect(h.engine.get(a.id)?.runsUsed).toBe(1);
    expect(h.stepCalls).toHaveLength(1);
  });

  it('persists the used date across restart and history loss, allowing the next local date', async () => {
    const first = setup();
    first.engine.start();
    const a = first.engine.create({ trigger: { ...trigger, oncePerDay: true }, steps: [notify] }, user);
    first.event({ type: 'app.started' });
    await flush();
    first.engine.stop();
    const second = setup({ actions: first.saved.actions, state: first.saved.state, start: START + 60 * MIN });
    second.engine.start();
    second.event({ type: 'app.started' });
    expect(second.stepCalls).toHaveLength(0);
    second.clock.t = new Date(2026, 10, 10, 8).getTime();
    second.event({ type: 'app.started' });
    await flush();
    expect(second.stepCalls).toHaveLength(1);
    expect(second.saved.state.lastFiredDate?.[a.id]).toBe('2026-11-10');
  });

  it('does not consume a new date on an overlap skip', async () => {
    let finish!: (result: ActionStepResult) => void;
    const h = setup({ stepImpl: () => new Promise((resolve) => { finish = resolve; }) });
    h.engine.start();
    const a = h.engine.create({ trigger: { ...trigger, oncePerDay: true }, steps: [notify] }, user);
    h.event({ type: 'app.started' });
    h.clock.t = new Date(2026, 10, 10, 8).getTime();
    h.event({ type: 'app.started' });
    expect(h.saved.state.lastFiredDate?.[a.id]).toBe('2026-11-09');
    expect(h.history(a.id).at(-1)).toMatchObject({ outcome: 'skipped', reason: 'The last run was still going' });
    finish({ kind: 'notify', outcome: 'done', detail: 'ok' });
    await flush();
    h.event({ type: 'app.started' });
    expect(h.saved.state.lastFiredDate?.[a.id]).toBe('2026-11-10');
    expect(h.engine.get(a.id)?.runsUsed).toBe(2);
    finish({ kind: 'notify', outcome: 'done', detail: 'ok' });
    await flush();
  });

  it('consumes the date at a queued start, cancelling other queued runs without counting them', async () => {
    let finish!: (result: ActionStepResult) => void;
    const h = setup({ stepImpl: () => new Promise((resolve) => { finish = resolve; }) });
    h.engine.start();
    const a = h.engine.create({ trigger: { ...trigger, oncePerDay: true }, steps: [notify], overlap: 'queue' }, user);
    h.event({ type: 'app.started' });
    h.clock.t = new Date(2026, 10, 10, 8).getTime();
    h.event({ type: 'app.started' });
    h.event({ type: 'app.started' });
    expect(h.saved.state.lastFiredDate?.[a.id]).toBe('2026-11-09');
    finish({ kind: 'notify', outcome: 'done', detail: 'ok' });
    await flush();
    expect(h.saved.state.lastFiredDate?.[a.id]).toBe('2026-11-10');
    finish({ kind: 'notify', outcome: 'done', detail: 'ok' });
    await flush();
    expect(h.stepCalls).toHaveLength(2);
    expect(h.engine.get(a.id)?.runsUsed).toBe(2);
    expect(h.history(a.id).at(-1)?.outcome).toBe('cancelled');
    expect(h.engine.isRunning(a.id)).toBe(false);
  });

  it('does not consume a new date on an hourly-limit skip', async () => {
    const h = setup({ start: new Date(2026, 10, 9, 23, 30).getTime() });
    h.engine.start();
    const a = h.engine.create({ trigger, steps: [notify] }, user);
    for (let i = 0; i < 60; i++) { h.engine.runNow(a.id); await flush(); }
    h.clock.t = new Date(2026, 10, 10, 0, 1).getTime();
    h.engine.update(a.id, { trigger: { ...trigger, oncePerDay: true }, steps: [notify] });
    h.event({ type: 'app.started' });
    expect(h.saved.state.lastFiredDate?.[a.id]).toBe('2026-11-09');
    expect(h.history(a.id).at(-1)).toMatchObject({ outcome: 'skipped', reason: 'Ran 60 times in the last hour' });
    h.clock.t = new Date(2026, 10, 10, 0, 31).getTime();
    h.event({ type: 'app.started' });
    await flush();
    expect(h.saved.state.lastFiredDate?.[a.id]).toBe('2026-11-10');
    expect(h.engine.get(a.id)?.runsUsed).toBe(61);
  });

  it('rechecks the local cutoff before a queued start after the clock moves back', async () => {
    let finish!: (result: ActionStepResult) => void;
    const h = setup({ stepImpl: () => new Promise((resolve) => { finish = resolve; }) });
    h.engine.start();
    const a = h.engine.create({ trigger: { ...trigger, afterLocalTime: '08:00', oncePerDay: true }, steps: [notify], overlap: 'queue' }, user);
    h.event({ type: 'app.started' });
    h.clock.t = new Date(2026, 10, 10, 8).getTime();
    h.event({ type: 'app.started' });
    h.clock.t -= MIN;
    finish({ kind: 'notify', outcome: 'done', detail: 'ok' });
    await flush();
    expect(h.stepCalls).toHaveLength(1);
    expect(h.saved.state.lastFiredDate?.[a.id]).toBe('2026-11-09');
    expect(h.history(a.id).at(-1)).toMatchObject({ outcome: 'cancelled', reason: 'Before 08:00 local time' });
    h.clock.t += MIN;
    h.event({ type: 'app.started' });
    expect(h.engine.get(a.id)?.runsUsed).toBe(2);
    finish({ kind: 'notify', outcome: 'done', detail: 'ok' });
    await flush();
  });

  it('rechecks the wall-clock time when a delayed run crosses midnight', async () => {
    const h = setup({ start: new Date(2026, 10, 9, 23, 55).getTime() });
    h.engine.start();
    const a = h.engine.create({ trigger: { ...trigger, delayMinutes: 20, afterLocalTime: '20:00', oncePerDay: true }, steps: [notify] }, user);
    h.event({ type: 'app.started' });
    await h.clock.advance(20 * MIN);
    expect(h.stepCalls).toHaveLength(0);
    expect(h.saved.state.lastFiredDate?.[a.id]).toBeUndefined();
    expect(h.history(a.id)).toMatchObject([{ outcome: 'skipped', reason: 'Before 20:00 local time' }]);
  });

  async function withLocalZone(zone: string, run: (setZone: (value: string) => void) => Promise<void>): Promise<void> {
    const part = (date: Date, field: 'year' | 'month' | 'day' | 'hour' | 'minute'): number => {
      const value = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(date).find((p) => p.type === field)?.value;
      if (!value) throw new Error(`Missing local ${field}`);
      return Number(value);
    };
    const spies = [
      vi.spyOn(Date.prototype, 'getFullYear').mockImplementation(function (this: Date) { return part(this, 'year'); }),
      vi.spyOn(Date.prototype, 'getMonth').mockImplementation(function (this: Date) { return part(this, 'month') - 1; }),
      vi.spyOn(Date.prototype, 'getDate').mockImplementation(function (this: Date) { return part(this, 'day'); }),
      vi.spyOn(Date.prototype, 'getHours').mockImplementation(function (this: Date) { return part(this, 'hour'); }),
      vi.spyOn(Date.prototype, 'getMinutes').mockImplementation(function (this: Date) { return part(this, 'minute'); }),
    ];
    try { await run((value) => { zone = value; }); }
    finally { for (const spy of spies) spy.mockRestore(); }
  }

  it('does not reuse the calendar day in the repeated DST hour', async () => {
    await withLocalZone('America/New_York', async () => {
      const h = setup({ start: Date.UTC(2026, 10, 1, 5, 30) });
      h.engine.start();
      const a = h.engine.create({ trigger: { ...trigger, afterLocalTime: '01:30', oncePerDay: true }, steps: [notify] }, user);
      h.event({ type: 'app.started' });
      await flush();
      h.clock.t = Date.UTC(2026, 10, 1, 6, 30);
      h.event({ type: 'app.started' });
      expect(h.stepCalls).toHaveLength(1);
      h.clock.t = Date.UTC(2026, 10, 2, 6, 30);
      h.event({ type: 'app.started' });
      await flush();
      expect(h.engine.get(a.id)?.runsUsed).toBe(2);
    });
  });

  it('allows the next event after a spring-forward jump past the cutoff', async () => {
    await withLocalZone('America/New_York', async () => {
      const h = setup({ start: Date.UTC(2026, 2, 8, 6, 59) });
      h.engine.start();
      const a = h.engine.create({ trigger: { ...trigger, afterLocalTime: '02:30', oncePerDay: true }, steps: [notify] }, user);
      h.event({ type: 'app.started' });
      expect(h.stepCalls).toHaveLength(0);
      h.clock.t = Date.UTC(2026, 2, 8, 7);
      h.event({ type: 'app.started' });
      await flush();
      expect(h.saved.state.lastFiredDate?.[a.id]).toBe('2026-03-08');
      expect(h.stepCalls).toHaveLength(1);
    });
  });

  it('keeps a local-date high-water mark across timezone changes and revisited dates', async () => {
    await withLocalZone('Pacific/Kiritimati', async (setZone) => {
      const h = setup({ start: Date.UTC(2026, 10, 9, 10, 30) });
      h.engine.start();
      const a = h.engine.create({ trigger: { ...trigger, afterLocalTime: '00:00', oncePerDay: true }, steps: [notify] }, user);
      h.event({ type: 'app.started' });
      await flush();
      expect(h.saved.state.lastFiredDate?.[a.id]).toBe('2026-11-10');
      setZone('Pacific/Honolulu');
      h.event({ type: 'app.started' });
      h.clock.t += 24 * 60 * MIN;
      h.event({ type: 'app.started' });
      expect(h.stepCalls).toHaveLength(1);
      h.clock.t += 24 * 60 * MIN;
      h.event({ type: 'app.started' });
      await flush();
      expect(h.stepCalls).toHaveLength(2);
      expect(h.saved.state.lastFiredDate?.[a.id]).toBe('2026-11-11');
    });
  });
});

describe('lifetime limits', () => {
  const returned = { kind: 'event', event: 'app.started', source: { kind: 'app' } } as const;

  it('counts event, failed and manual starts, but not overlap skips', async () => {
    let finish!: (result: ActionStepResult) => void;
    const { engine, event, history, saved } = setup({
      stepImpl: () => new Promise((resolve) => { finish = resolve; }),
    });
    engine.start();
    const a = engine.create({ trigger: returned, steps: [notify], maxRuns: 2 }, user);
    event({ type: 'app.started' });
    engine.runNow(a.id);
    expect(engine.get(a.id)?.runsUsed).toBe(1);
    expect(history(a.id).some((r) => r.outcome === 'skipped')).toBe(true);
    finish({ kind: 'notify', outcome: 'failed', detail: 'No notification service' });
    await flush();
    engine.runNow(a.id);
    expect(engine.get(a.id)).toMatchObject({ enabled: false, runsUsed: 2, offReason: 'Reached its 2-run limit' });
    expect(saved.actions[0].runsUsed).toBe(2);
    finish({ kind: 'notify', outcome: 'done', detail: 'ok' });
    await flush();
    engine.runNow(a.id);
    expect(engine.get(a.id)?.runsUsed).toBe(2);
    expect(history(a.id).filter((r) => r.outcome === 'done' || r.outcome === 'failed')).toHaveLength(2);
  });

  it('does not count hourly-limit skips', async () => {
    const { engine, history } = setup();
    engine.start();
    const a = engine.create({ trigger: returned, steps: [notify], maxRuns: 61 }, user);
    for (let i = 0; i < 61; i++) { engine.runNow(a.id); await flush(); }
    expect(engine.get(a.id)).toMatchObject({ enabled: true, runsUsed: 60 });
    expect(history(a.id).at(-1)).toMatchObject({ outcome: 'skipped', reason: 'Ran 60 times in the last hour' });
  });

  it('counts queued event and manual starts once and cancels the rest at the cap', async () => {
    const releases: Array<() => void> = [];
    const { engine, event, stepCalls, history, saved } = setup({
      stepImpl: (step) => new Promise((resolve) => {
        releases.push(() => resolve({ kind: step.kind, outcome: 'done', detail: 'ok' }));
      }),
    });
    engine.start();
    const a = engine.create({ trigger: returned, steps: [notify], maxRuns: 3, overlap: 'queue' }, user);
    for (let i = 0; i < 4; i++) {
      event({ type: 'app.started' });
      engine.runNow(a.id);
    }
    expect(engine.get(a.id)?.runsUsed).toBe(1);
    for (let i = 0; i < 3; i++) {
      releases.shift()?.();
      await flush();
    }
    expect(stepCalls).toHaveLength(3);
    expect(history(a.id).filter((r) => r.outcome === 'done')).toHaveLength(3);
    expect(history(a.id).filter((r) => r.outcome === 'cancelled')).toHaveLength(5);
    expect(saved.actions[0]).toMatchObject({ enabled: false, runsUsed: 3 });
  });

  it('rechecks expiry when a queued run actually starts', async () => {
    let finish!: (result: ActionStepResult) => void;
    const { engine, clock, hooks, stepCalls, history } = setup({
      stepImpl: () => new Promise((resolve) => { finish = resolve; }),
    });
    engine.start();
    const endsAt = START + MIN;
    const a = engine.create({ trigger: returned, steps: [notify], endsAt, overlap: 'queue' }, user);
    engine.runNow(a.id);
    engine.runNow(a.id);
    vi.mocked(hooks.observe).mockImplementation((observation) => {
      if (observation.type === 'run' && observation.outcome === 'done') {
        queueMicrotask(() => { clock.t = endsAt; });
      }
    });
    finish({ kind: 'notify', outcome: 'done', detail: 'ok' });
    await flush();
    expect(stepCalls).toHaveLength(1);
    expect(engine.get(a.id)).toMatchObject({ enabled: false, runsUsed: 1, offReason: 'Ended at the set time' });
    expect(history(a.id).some((r) => r.outcome === 'running')).toBe(false);
  });

  it('honors a lowered run limit during the queued-run handoff', async () => {
    let finish!: (result: ActionStepResult) => void;
    const { engine, hooks, stepCalls } = setup({
      stepImpl: () => new Promise((resolve) => { finish = resolve; }),
    });
    engine.start();
    const input = { trigger: returned, steps: [notify], maxRuns: 3, overlap: 'queue' };
    const a = engine.create(input, user);
    engine.runNow(a.id);
    engine.runNow(a.id);
    vi.mocked(hooks.observe).mockImplementation((observation) => {
      if (observation.type === 'run' && observation.outcome === 'done') {
        queueMicrotask(() => { engine.update(a.id, { ...input, maxRuns: 1 }); });
      }
    });
    finish({ kind: 'notify', outcome: 'done', detail: 'ok' });
    await flush();
    expect(stepCalls).toHaveLength(1);
    expect(engine.get(a.id)).toMatchObject({ enabled: false, maxRuns: 1, runsUsed: 1, offReason: 'Reached its 1-run limit' });
  });

  it('persists starts independently of history and bounds catch-up queues after restart', async () => {
    const first = setup();
    first.engine.start();
    const a = first.engine.create({
      trigger: { ...weekdays9, missed: 'each' }, steps: [notify], maxRuns: 3, overlap: 'queue',
    }, user);
    first.engine.runNow(a.id);
    await flush();
    first.engine.stop();
    const second = setup({ actions: first.saved.actions, state: first.saved.state, start: START + 4 * 24 * 60 * MIN });
    second.engine.start();
    await flush(); await flush();
    expect(second.engine.get(a.id)).toMatchObject({ runsUsed: 3, enabled: false, offReason: 'Reached its 3-run limit' });
    expect(second.stepCalls).toHaveLength(2);
    expect(second.engine.nextRunAt(a.id)).toBeUndefined();
  });

  it('counts scheduled starts and leaves missed-time skips unconsumed', async () => {
    const { engine, clock } = setup();
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify], maxRuns: 2 }, user);
    clock.t += 2 * 24 * 60 * MIN;
    engine.resume();
    await flush();
    expect(engine.get(a.id)?.runsUsed).toBeUndefined();
    await clock.advance(60 * MIN);
    expect(engine.get(a.id)?.runsUsed).toBe(1);
  });

  it('never arms times beyond the end and lets an active run finish at expiry', async () => {
    let finish!: (result: ActionStepResult) => void;
    const { engine, clock, history } = setup({ stepImpl: () => new Promise((resolve) => { finish = resolve; }) });
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify], endsAt: START + 30 * MIN }, user);
    expect(engine.nextRunAt(a.id)).toBeUndefined();
    engine.runNow(a.id);
    await clock.advance(30 * MIN);
    expect(engine.get(a.id)).toMatchObject({ enabled: false, offReason: 'Ended at the set time', runsUsed: 1 });
    expect(history(a.id)[0].outcome).toBe('running');
    finish({ kind: 'notify', outcome: 'done', detail: 'ok' });
    await flush();
    expect(history(a.id)[0].outcome).toBe('done');
    engine.runNow(a.id);
    expect(engine.get(a.id)?.runsUsed).toBe(1);
  });

  it('does not catch up an expired action or restore its delayed wait', async () => {
    const first = setup();
    first.engine.start();
    const a = first.engine.create({ trigger: { ...weekdays9, missed: 'each' }, steps: [notify], endsAt: START + 2 * 60 * MIN }, user);
    const b = first.engine.create({ trigger: { ...returned, delayMinutes: 120 }, steps: [notify], endsAt: START + 60 * MIN }, user);
    first.event({ type: 'app.started' });
    first.engine.stop();
    const second = setup({ actions: first.saved.actions, state: first.saved.state, start: START + 24 * 60 * MIN });
    second.engine.start();
    await flush();
    expect(second.stepCalls).toHaveLength(0);
    for (const id of [a.id, b.id]) expect(second.engine.get(id)).toMatchObject({ enabled: false, offReason: 'Ended at the set time' });
    expect(second.saved.state.waits).toEqual([]);
    expect(second.saved.state.nextAt).toEqual({});
  });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('creating and editing', () => {
  it('validates, suggests a name, and checks rights', () => {
    const { engine } = setup({ refuse: (s) => (s.kind === 'wake' ? 'pm can no longer wake qa.' : null) });
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify] }, user);
    expect(a.name).toBe('Weekdays at 9:00 AM, notify you');
    expect(a.enabled).toBe(true);
    expect(() => engine.create({ trigger: weekdays9, steps: [] }, user)).toThrow(/at least one step/);
    expect(() => engine.create({ trigger: weekdays9, steps: [{ kind: 'wake', agentId: 'pm' }] }, user)).toThrow(/can no longer wake/);
  });

  it('an edit keeps the owner and clears the old failure', () => {
    const { engine } = setup();
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify] }, { kind: 'agent', agentId: 'lead' });
    const edited = engine.update(a.id, { name: 'Morning', trigger: weekdays9, steps: [notify] });
    expect(edited.owner).toEqual({ kind: 'agent', agentId: 'lead' });
    expect(edited.name).toBe('Morning');
  });
});

describe('schedules', () => {
  it('runs at the schedule time and moves to the next', async () => {
    const { engine, clock, history } = setup();
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify] }, user);
    expect(engine.nextRunAt(a.id)).toBe(new Date(2026, 10, 9, 9, 0).getTime());
    await clock.advance(60 * MIN);
    expect(history(a.id)).toMatchObject([{ outcome: 'done', trigger: { kind: 'schedule' } }]);
    expect(engine.nextRunAt(a.id)).toBe(new Date(2026, 10, 10, 9, 0).getTime());
  });

  const missedState = (id: string): EngineState => ({ nextAt: { [id]: new Date(2026, 11 - 1, 2, 9, 0).getTime() }, waits: [] });
  const scheduled = (missed: 'skip' | 'once' | 'each'): Action => ({
    id: 'a1', name: 'Morning', trigger: { ...weekdays9, missed }, steps: [notify], overlap: 'skip',
    owner: user, enabled: true, createdAt: 0, updatedAt: 0,
  });

  it('skips missed times by default, and records that it did', async () => {
    const { engine, history, stepCalls } = setup({ actions: [scheduled('skip')], state: missedState('a1') });
    engine.start();
    await flush();
    expect(stepCalls).toHaveLength(0);
    expect(history('a1')).toMatchObject([{ outcome: 'skipped', reason: expect.stringMatching(/Skipped 5 scheduled times missed/) }]);
    expect(engine.nextRunAt('a1')).toBe(new Date(2026, 10, 9, 9, 0).getTime());
  });

  it('runs once for missed times when asked', async () => {
    const { engine, history } = setup({ actions: [scheduled('once')], state: missedState('a1') });
    engine.start();
    await flush();
    expect(history('a1')).toMatchObject([{ outcome: 'done', trigger: { kind: 'catch_up', at: new Date(2026, 10, 6, 9, 0).getTime() } }]);
  });

  it('runs each missed time, one after another', async () => {
    const { engine, history } = setup({ actions: [scheduled('each')], state: missedState('a1') });
    engine.start();
    await flush(); await flush();
    expect(history('a1').map((r) => new Date(r.trigger.at).getDate())).toEqual([2, 3, 4, 5, 6]);
    expect(history('a1').every((r) => r.outcome === 'done')).toBe(true);
  });

  it('catches up after the machine sleeps', async () => {
    const { engine, clock, history } = setup();
    engine.start();
    const a = engine.create({ trigger: { ...weekdays9, missed: 'once' }, steps: [notify] }, user);
    // Asleep for two days: timers didn't run, the clock moved.
    clock.t += 50 * 60 * MIN;
    engine.resume();
    await flush();
    expect(history(a.id)).toMatchObject([{ trigger: { kind: 'catch_up' } }]);
  });
});

describe('one-time actions', () => {
  it('run at their time and delete themselves, keeping the run', async () => {
    const { engine, clock, history } = setup();
    engine.start();
    const a = engine.create({ trigger: { kind: 'once', at: START + 30 * MIN }, steps: [notify] }, user);
    await clock.advance(31 * MIN);
    expect(engine.get(a.id)).toBeUndefined();
    expect(history(a.id)).toMatchObject([{ outcome: 'done', trigger: { kind: 'once' } }]);
  });

  it('run late at launch when the app was closed at the time', async () => {
    const action: Action = { id: 'o1', name: 'Once', trigger: { kind: 'once', at: START - 60 * MIN }, steps: [notify], overlap: 'skip', owner: user, enabled: true, createdAt: 0, updatedAt: 0 };
    const { engine, history } = setup({ actions: [action] });
    engine.start();
    await flush();
    expect(history('o1')).toMatchObject([{ outcome: 'done', trigger: { detail: expect.stringMatching(/Ran late/) } }]);
    expect(engine.get('o1')).toBeUndefined();
  });
});

describe('events', () => {
  it('delivers returns only to qualifying actions without absence details, persisting last use', async () => {
    const { engine, event, history, saved } = setup({ state: { nextAt: {}, waits: [], lastUse: START - MIN } });
    engine.start();
    const a = engine.create({ trigger: { kind: 'event', event: 'app.returned', source: { kind: 'app' } }, steps: [notify] }, user);
    const b = engine.create({ trigger: { kind: 'event', event: 'app.returned', source: { kind: 'app' }, absenceMinutes: 60 }, steps: [notify] }, user);
    engine.recordUse(START);
    expect(engine.lastUse()).toBe(START);
    expect(saved.state.lastUse).toBe(START);
    event({ type: 'app.returned', actionIds: [a.id] });
    await flush();
    expect(history(a.id)).toMatchObject([{ trigger: { detail: 'Clubhouse returns to use' } }]);
    expect(history(b.id)).toEqual([]);
    expect(JSON.stringify(history(a.id))).not.toContain('absence');
  });

  it('runs on a matching agent event, with a plain history line', async () => {
    const { engine, event, history } = setup();
    engine.start();
    const a = engine.create({ trigger: { kind: 'event', event: 'agent.woke', source: { kind: 'agent', agentId: 'lead' } }, steps: [notify] }, user);
    event({ type: 'agent.awake', agentId: 'pm' });
    event({ type: 'agent.awake', agentId: 'lead' });
    await flush();
    expect(history(a.id)).toMatchObject([{ outcome: 'done', trigger: { kind: 'event', detail: 'release-lead wakes' } }]);
  });

  it('matches any agent in a project, and never quick agents', async () => {
    const { engine, event, history } = setup();
    engine.start();
    const a = engine.create({ trigger: { kind: 'event', event: 'agent.turn_failed', source: { kind: 'project', projectId: 'p1' } }, steps: [notify] }, user);
    event({ type: 'turn.ended', agentId: 'other', via: 'chat', outcome: 'failed' });
    event({ type: 'turn.ended', agentId: 'quick_x', via: 'chat', outcome: 'failed' });
    event({ type: 'turn.ended', agentId: 'pm', via: 'chat', outcome: 'completed' });
    event({ type: 'turn.ended', agentId: 'pm', via: 'hook', outcome: 'failed' });
    await flush();
    expect(history(a.id)).toHaveLength(1);
  });

  it('a helper finishing is about its parent', async () => {
    const { engine, event, history } = setup();
    engine.start();
    const a = engine.create({ trigger: { kind: 'event', event: 'helper.finished', source: { kind: 'agent', agentId: 'lead' } }, steps: [notify] }, user);
    event({ type: 'helper.finished', agentId: 'h1', parentAgentId: 'lead', projectPath: '/p1' });
    await flush();
    expect(history(a.id)).toHaveLength(1);
  });

  it('filters git events by branch and worktree', async () => {
    const { engine, event, history } = setup();
    engine.start();
    const a = engine.create({ trigger: { kind: 'event', event: 'git.remote_updated', source: { kind: 'project', projectId: 'p1' }, branch: 'main' }, steps: [notify] }, user);
    const b = engine.create({ trigger: { kind: 'event', event: 'git.commit', source: { kind: 'agent', agentId: 'lead' } }, steps: [notify] }, user);
    event({ type: 'git.remote_updated', repoPath: '/p1', branch: 'dev', remote: 'origin' });
    event({ type: 'git.remote_updated', repoPath: '/p1', branch: 'main', remote: 'origin' });
    event({ type: 'git.commit', repoPath: '/p1', branch: 'main' });
    event({ type: 'git.commit', repoPath: '/p1/.wt/lead', branch: 'feature' });
    await flush();
    expect(history(a.id)).toHaveLength(1);
    expect(history(b.id)).toMatchObject([{ trigger: { detail: 'release-lead’s worktree gets a new commit (feature)' } }]);
    // A fetch that moved many branches matches no single-branch filter, and reads plainly.
    const c = engine.create({ trigger: { kind: 'event', event: 'git.remote_updated', source: { kind: 'project', projectId: 'p1' } }, steps: [notify] }, user);
    event({ type: 'git.remote_updated', repoPath: '/p1', branch: '*', remote: 'origin' });
    await flush();
    expect(history(a.id)).toHaveLength(1);
    expect(history(c.id)).toMatchObject([{ trigger: { detail: 'web is pushed, pulled or fetched (many branches)' } }]);
  });
});

describe('waits and re-checks', () => {
  it('runs after the wait when the condition still holds', async () => {
    const { engine, event, clock, history } = setup();
    engine.start();
    const a = engine.create({ trigger: { kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: 'lead' }, delayMinutes: 30 }, steps: [notify] }, user);
    event({ type: 'agent.asleep', agentId: 'lead' });
    await clock.advance(29 * MIN);
    expect(history(a.id)).toHaveLength(0);
    await clock.advance(2 * MIN);
    expect(history(a.id)).toMatchObject([{ outcome: 'done', trigger: { kind: 'event', at: START } }]);
  });

  it('cancels when the condition no longer holds, and records it', async () => {
    const { engine, event, clock, history, running } = setup();
    engine.start();
    const a = engine.create({ trigger: { kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: 'lead' }, delayMinutes: 30 }, steps: [notify] }, user);
    event({ type: 'agent.asleep', agentId: 'lead' });
    running.add('lead');
    await clock.advance(31 * MIN);
    expect(history(a.id)).toMatchObject([{ outcome: 'cancelled' }]);
  });

  it('restarts the wait on the next matching event', async () => {
    const { engine, event, clock, history } = setup();
    engine.start();
    const a = engine.create({ trigger: { kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: 'lead' }, delayMinutes: 30 }, steps: [notify] }, user);
    event({ type: 'agent.asleep', agentId: 'lead' });
    await clock.advance(20 * MIN);
    event({ type: 'agent.asleep', agentId: 'lead' });
    await clock.advance(20 * MIN);
    expect(history(a.id)).toHaveLength(0);
    await clock.advance(11 * MIN);
    expect(history(a.id)).toHaveLength(1);
  });

  it('keeps a wait per agent for "any agent in a project"', async () => {
    const { engine, event, clock, history } = setup();
    engine.start();
    const a = engine.create({ trigger: { kind: 'event', event: 'agent.slept', source: { kind: 'project', projectId: 'p1' }, delayMinutes: 10 }, steps: [notify] }, user);
    event({ type: 'agent.asleep', agentId: 'lead' });
    event({ type: 'agent.asleep', agentId: 'pm' });
    await clock.advance(11 * MIN);
    await flush();
    // Two runs, but the second overlapped the first and was skipped (default rule).
    expect(history(a.id).map((r) => r.outcome).sort()).toEqual(['done', 'skipped']);
  });

  it('goes idle: a new turn cancels quietly, and the next turn end starts again', async () => {
    const { engine, event, clock, history } = setup();
    engine.start();
    const a = engine.create({ trigger: { kind: 'event', event: 'agent.idle', source: { kind: 'agent', agentId: 'lead' }, delayMinutes: 30 }, steps: [notify] }, user);
    event({ type: 'turn.ended', agentId: 'lead', via: 'chat', outcome: 'completed' });
    await clock.advance(10 * MIN);
    event({ type: 'turn.started', agentId: 'lead', via: 'chat' });
    await clock.advance(25 * MIN);
    expect(history(a.id)).toEqual([]);
    event({ type: 'turn.ended', agentId: 'lead', via: 'chat', outcome: 'completed' });
    await clock.advance(31 * MIN);
    expect(history(a.id)).toMatchObject([{ outcome: 'done' }]);
    // Once per idle stretch.
    await clock.advance(120 * MIN);
    expect(history(a.id)).toHaveLength(1);
  });

  it('on launch, runs a wait that ended while closed if it still holds, else drops it', async () => {
    const actions: Action[] = ['s1', 'w1'].map((id) => ({
      id, name: id, steps: [notify], overlap: 'skip', owner: user, enabled: true, createdAt: 0, updatedAt: 0,
      trigger: { kind: 'event', event: id === 's1' ? 'agent.slept' : 'agent.woke', source: { kind: 'agent', agentId: 'lead' }, delayMinutes: 30 },
    }));
    const state: EngineState = { nextAt: {}, waits: [
      { actionId: 's1', agentId: 'lead', startedAt: START - 60 * MIN, dueAt: START - 30 * MIN, chain: [], detail: 'x' },
      { actionId: 'w1', agentId: 'lead', startedAt: START - 60 * MIN, dueAt: START - 30 * MIN, chain: [], detail: 'x' },
    ] };
    const { engine, history, saved } = setup({ actions, state });
    engine.start();
    await flush();
    expect(history('s1')).toMatchObject([{ outcome: 'done' }]);
    expect(history('w1')).toEqual([]);
    expect(saved.state.waits).toEqual([]);
  });
});

describe('overlap, chains and limits', () => {
  function slowSteps() {
    const releases: Array<() => void> = [];
    const stepImpl = (step: ActionStep) => new Promise<ActionStepResult>((resolve) => {
      releases.push(() => resolve({ kind: step.kind, outcome: 'done', detail: 'ok' }));
    });
    return { releases, stepImpl };
  }

  it('skips a run while the last is going (default)', async () => {
    const { releases, stepImpl } = slowSteps();
    const { engine, history } = setup({ stepImpl });
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify] }, user);
    engine.runNow(a.id);
    engine.runNow(a.id);
    await flush();
    releases.forEach((r) => r());
    await flush();
    expect(history(a.id).map((r) => r.outcome).sort()).toEqual(['done', 'skipped']);
  });

  it('queues behind it when asked, up to a cap', async () => {
    const { releases, stepImpl } = slowSteps();
    const { engine, history } = setup({ stepImpl });
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify], overlap: 'queue' }, user);
    for (let i = 0; i < MAX_QUEUED_RUNS + 2; i++) engine.runNow(a.id);
    for (let i = 0; i < MAX_QUEUED_RUNS + 2; i++) { await flush(); releases.shift()?.(); await flush(); }
    const outcomes = history(a.id).map((r) => r.outcome);
    expect(outcomes.filter((o) => o === 'done')).toHaveLength(MAX_QUEUED_RUNS + 1);
    expect(outcomes.filter((o) => o === 'skipped')).toHaveLength(1);
  });

  it('stops chains at depth 3 and an action setting itself off', async () => {
    const { engine, event, history } = setup();
    engine.start();
    const a = engine.create({ trigger: { kind: 'event', event: 'agent.woke', source: { kind: 'agent', agentId: 'lead' } }, steps: [notify] }, user);
    event({ type: 'agent.awake', agentId: 'lead', chain: ['x', 'y'] });
    await flush();
    event({ type: 'agent.awake', agentId: 'lead', chain: ['x', 'y', 'z'] });
    event({ type: 'agent.awake', agentId: 'lead', chain: [a.id] });
    await flush();
    const runs = history(a.id);
    expect(runs.map((r) => r.outcome)).toEqual(['done', 'skipped', 'skipped']);
    expect(runs[1].reason).toMatch(/chain of 3/);
    expect(runs[2].reason).toMatch(/itself/);
  });

  it('passes its chain on to its steps', async () => {
    const { engine, event, stepCalls } = setup();
    engine.start();
    const a = engine.create({ trigger: { kind: 'event', event: 'agent.woke', source: { kind: 'agent', agentId: 'lead' } }, steps: [notify] }, user);
    event({ type: 'agent.awake', agentId: 'lead', chain: ['x'] });
    await flush();
    expect(stepCalls[0].ctx.chain).toEqual(['x', a.id]);
  });

  it('runs at most 60 times an hour', async () => {
    const { engine, history } = setup();
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify] }, user);
    for (let i = 0; i < 61; i++) { engine.runNow(a.id); await flush(); }
    const runs = history(a.id);
    expect(runs.filter((r) => r.outcome === 'done')).toHaveLength(60);
    expect(runs.find((r) => r.outcome === 'skipped')?.reason).toMatch(/60 times/);
  });
});

describe('steps and failures', () => {
  it('stops at the first step that couldn’t run, marks the action and notifies', async () => {
    const { engine, history, stepCalls, hooks } = setup({
      stepImpl: async (step) => (step.kind === 'wake' ? { kind: 'wake', outcome: 'failed', detail: 'Couldn’t wake pm: not installed' } : { kind: step.kind, outcome: 'done', detail: 'ok' }),
    });
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify, { kind: 'wake', agentId: 'pm' }, notify] }, user);
    engine.runNow(a.id);
    await flush();
    expect(stepCalls).toHaveLength(2);
    expect(history(a.id)).toMatchObject([{ outcome: 'failed', reason: 'Couldn’t wake pm: not installed' }]);
    expect(engine.get(a.id)?.problem).toBe('Couldn’t wake pm: not installed');
    expect(hooks.failed).toHaveBeenCalledTimes(1);
  });

  it('a later good run clears the problem', async () => {
    let fail = true;
    const { engine } = setup({ stepImpl: async (s) => ({ kind: s.kind, outcome: fail ? 'failed' : 'done', detail: 'x' }) });
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify] }, user);
    engine.runNow(a.id); await flush();
    fail = false;
    engine.runNow(a.id); await flush();
    expect(engine.get(a.id)?.problem).toBeUndefined();
  });

  it('checks rights again on every run', async () => {
    let allowed = true;
    const { engine, history, stepCalls } = setup({ refuse: () => (allowed ? null : 'release-lead can no longer wake pm.') });
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [{ kind: 'wake', agentId: 'pm' }] }, { kind: 'agent', agentId: 'lead' });
    allowed = false;
    engine.runNow(a.id);
    await flush();
    expect(stepCalls).toHaveLength(0);
    expect(history(a.id)[0].reason).toBe('Couldn’t run: release-lead can no longer wake pm.');
    expect(engine.get(a.id)?.enabled).toBe(true);
  });
});

describe('deleted agents', () => {
  it('turns off actions that target or are owned by it, and deletes a helper’s own', async () => {
    const { engine, event, hooks } = setup();
    engine.start();
    const targets = engine.create({ trigger: weekdays9, steps: [{ kind: 'wake', agentId: 'pm' }] }, user);
    const owned = engine.create({ trigger: weekdays9, steps: [notify] }, { kind: 'agent', agentId: 'pm' });
    const helperOwned = engine.create({ trigger: weekdays9, steps: [notify] }, { kind: 'agent', agentId: 'pm', helper: true });
    const unrelated = engine.create({ trigger: weekdays9, steps: [notify] }, user);
    event({ type: 'agent.deleted', agentId: 'pm', projectPath: '/p1', name: 'pm' });
    expect(engine.get(targets.id)).toMatchObject({ enabled: false, offReason: 'Turned off: pm was deleted' });
    expect(engine.get(owned.id)).toMatchObject({ enabled: false, offReason: 'Turned off: pm was deleted' });
    expect(engine.get(helperOwned.id)).toBeUndefined();
    expect(engine.get(unrelated.id)?.enabled).toBe(true);
    expect(hooks.turnedOff).toHaveBeenCalledTimes(2);
    // Turning it back on clears the reason.
    expect(engine.setEnabled(targets.id, true).offReason).toBeUndefined();
  });
});

describe('Clubhouse’s own actions', () => {
  it('run but leave no history', async () => {
    const { engine, history, stepCalls } = setup();
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify] }, { kind: 'app' });
    engine.runNow(a.id);
    await flush();
    expect(stepCalls).toHaveLength(1);
    expect(history(a.id)).toEqual([]);
  });
});

describe('review fixes', () => {
  it('cancels queued runs when the action is turned off', async () => {
    const releases: Array<() => void> = [];
    const { engine, history, stepCalls } = setup({
      stepImpl: (step) => new Promise((resolve) => releases.push(() => resolve({ kind: step.kind, outcome: 'done', detail: 'ok' }))),
    });
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify], overlap: 'queue' }, user);
    engine.runNow(a.id);
    engine.runNow(a.id);
    engine.runNow(a.id);
    await flush();
    engine.setEnabled(a.id, false);
    releases.shift()?.();
    await flush();
    expect(stepCalls).toHaveLength(1);
    expect(history(a.id).map((r) => r.outcome).sort()).toEqual(['cancelled', 'cancelled', 'done']);
    expect(engine.isRunning(a.id)).toBe(false);
  });

  it('never stays marked as running when something throws mid-run', async () => {
    const { engine, hooks, stepCalls } = setup({ stepImpl: async (s) => ({ kind: s.kind, outcome: 'failed', detail: 'x' }) });
    hooks.failed.mockImplementation(() => { throw new Error('toast failed'); });
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify] }, user);
    engine.runNow(a.id);
    await flush();
    expect(engine.isRunning(a.id)).toBe(false);
    engine.runNow(a.id);
    await flush();
    expect(stepCalls).toHaveLength(2);
  });

  it('an edit that doesn’t say keeps an action off', () => {
    const { engine } = setup();
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify], enabled: false }, user);
    expect(engine.update(a.id, { trigger: weekdays9, steps: [notify] }).enabled).toBe(false);
    expect(engine.update(a.id, { trigger: weekdays9, steps: [notify], enabled: true }).enabled).toBe(true);
  });

  it('refuses agents and projects that aren’t in Clubhouse', () => {
    const { engine } = setup();
    engine.start();
    expect(() => engine.create({ trigger: weekdays9, steps: [{ kind: 'wake', agentId: 'nobody' }] }, user)).toThrow(/agents it names/);
    expect(() => engine.create({ trigger: weekdays9, steps: [{ kind: 'quick', projectId: 'p9', prompt: 'x' }] }, user)).toThrow(/projects it names/);
  });

  it('a delayed "is deleted" trigger still fires for the agent it watched', async () => {
    const { engine, event, clock, history } = setup();
    engine.start();
    const a = engine.create({ trigger: { kind: 'event', event: 'agent.deleted', source: { kind: 'agent', agentId: 'pm' }, delayMinutes: 5 }, steps: [notify] }, user);
    event({ type: 'agent.deleted', agentId: 'pm', projectPath: '/p1', name: 'pm' });
    expect(engine.get(a.id)?.enabled).toBe(true);
    await clock.advance(6 * MIN);
    // pm still exists in this fake, so the re-check cancels; what matters is the wait survived.
    expect(history(a.id)).toHaveLength(1);
  });

  it('catch-up "once" runs the latest missed time after a long closure', async () => {
    const hourly: Action = { id: 'h', name: 'Hourly', trigger: { kind: 'schedule', preset: 'hourly', cron: '0 * * * *', missed: 'once' }, steps: [notify], overlap: 'skip', owner: user, enabled: true, createdAt: 0, updatedAt: 0 };
    const { engine, history } = setup({ actions: [hourly], state: { nextAt: { h: START - 48 * 60 * MIN }, waits: [] } });
    engine.start();
    await flush();
    expect(history('h')).toMatchObject([{ trigger: { kind: 'catch_up', at: START } }]);
  });
});

describe('rights on sources, counts and turning on (#2952)', () => {
  const lead = { kind: 'agent', agentId: 'lead' } as const;
  const whenPmSleeps = { kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: 'pm' } } as const;

  it('refuses a source the owner may not watch, before checking it exists', () => {
    const { engine } = setup({ refuseSource: (t) => (t.kind === 'event' ? 'release-lead can’t act on that agent.' : null) });
    engine.start();
    expect(() => engine.create({ trigger: whenPmSleeps, steps: [notify] }, lead)).toThrow('release-lead can’t act on that agent.');
    const missing = { ...whenPmSleeps, source: { kind: 'agent', agentId: 'nobody' } };
    expect(() => engine.create({ trigger: missing, steps: [notify] }, lead)).toThrow('release-lead can’t act on that agent.');
    const a = engine.create({ trigger: weekdays9, steps: [notify] }, lead);
    expect(() => engine.update(a.id, { trigger: whenPmSleeps, steps: [notify] })).toThrow('can’t act on that agent');
  });

  it('a source no longer allowed when the trigger fires is a run that couldn’t run', async () => {
    let allowed = true;
    const { engine, event, history, stepCalls, hooks } = setup({ refuseSource: () => (allowed ? null : 'release-lead can’t act on that agent.') });
    engine.start();
    const a = engine.create({ trigger: whenPmSleeps, steps: [notify] }, lead);
    allowed = false;
    event({ type: 'agent.asleep', agentId: 'pm' });
    await flush();
    expect(stepCalls).toHaveLength(0);
    expect(history(a.id)[0]).toMatchObject({ outcome: 'failed', reason: 'Couldn’t run: release-lead can’t act on that agent.' });
    expect(hooks.failed).toHaveBeenCalled();
  });

  it('caps the actions one owner may have', () => {
    const { engine } = setup({ maxActions: 2 });
    engine.start();
    engine.create({ trigger: weekdays9, steps: [notify] }, lead);
    engine.create({ trigger: weekdays9, steps: [notify] }, { kind: 'agent', agentId: 'lead', helper: false });
    expect(() => engine.create({ trigger: weekdays9, steps: [notify] }, lead)).toThrow(/2 actions already/);
    expect(() => engine.create({ trigger: weekdays9, steps: [notify] }, { kind: 'agent', agentId: 'pm' })).not.toThrow();
    for (let i = 0; i < 3; i++) engine.create({ trigger: weekdays9, steps: [notify] }, user);
  });

  it('checks rights again when an action is turned on', () => {
    let allowed = true;
    const { engine } = setup({ refuse: () => (allowed ? null : 'release-lead can’t act on that agent.') });
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [{ kind: 'wake', agentId: 'pm' }] }, lead);
    engine.setEnabled(a.id, false);
    allowed = false;
    expect(() => engine.setEnabled(a.id, true)).toThrow('can’t act on that agent');
    expect(engine.setEnabled(a.id, false).enabled).toBe(false);
  });

  it('keeps the owner on each run, so a one-time action’s history says whose it was', async () => {
    const { engine, clock, history } = setup();
    engine.start();
    const a = engine.create({ trigger: { kind: 'once', at: START + MIN }, steps: [notify] }, lead);
    await clock.advance(2 * MIN);
    await flush();
    expect(engine.get(a.id)).toBeUndefined();
    expect(history(a.id)[0]).toMatchObject({ outcome: 'done', owner: lead });
  });
});

describe('observations (for telemetry)', () => {
  type Obs = Parameters<NonNullable<EngineHooks['observe']>>[0];
  const observed = (hooks: { observe: ReturnType<typeof vi.fn> }): Obs[] => hooks.observe.mock.calls.map((c) => c[0] as Obs);

  it('reports Run now as a manual trigger, and the run with its trigger, owner, steps and duration', async () => {
    const { engine, hooks, clock } = setup({
      stepImpl: async (step) => { clock.t += 500; return { kind: step.kind, outcome: 'done', detail: 'ok' }; },
    });
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify, { kind: 'wake', agentId: 'pm' }] }, { kind: 'dispatcher' });
    engine.runNow(a.id);
    await flush();
    expect(observed(hooks)).toEqual([
      { type: 'trigger', trigger: 'manual', actionId: a.id, owner: { kind: 'dispatcher' } },
      {
        type: 'run', outcome: 'done', trigger: 'manual', steps: 2,
        stepResults: [{ kind: 'notify', outcome: 'done' }, { kind: 'wake', outcome: 'done' }],
        chainDepth: 0, durationMs: 1000, actionId: a.id, owner: { kind: 'dispatcher' },
      },
    ]);
  });

  it('gives a run stopped by the hourly limit a closed reason code', async () => {
    const { engine, hooks } = setup();
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify] }, user);
    for (let i = 0; i < 61; i++) { engine.runNow(a.id); await flush(); }
    const runs = observed(hooks).filter((o) => o.type === 'run');
    expect(runs.at(-1)).toMatchObject({ outcome: 'skipped', reasonCode: 'hourly_limit', steps: 0 });
    expect(observed(hooks)).toContainEqual(expect.objectContaining({ type: 'limit', what: 'hourly', chainDepth: 0 }));
  });

  it('codes a rights refusal and a step that threw', async () => {
    // Created while allowed, refused on the run.
    let blocked = false;
    const refused = setup({ refuse: () => (blocked ? 'pm can no longer put qa to sleep.' : null) });
    refused.engine.start();
    const r = refused.engine.create({ trigger: weekdays9, steps: [{ kind: 'sleep', agentId: 'pm' }] }, user);
    blocked = true;
    refused.engine.runNow(r.id);
    await flush();
    expect(observed(refused.hooks).find((o) => o.type === 'run')).toMatchObject({ outcome: 'failed', reasonCode: 'rights_refused' });

    const threw = setup({
      stepImpl: async (step) => { if (step.kind === 'sleep') throw new Error('boom'); return { kind: step.kind, outcome: 'done', detail: 'ok' }; },
    });
    threw.engine.start();
    const a = threw.engine.create({ trigger: weekdays9, steps: [{ kind: 'sleep', agentId: 'pm' }] }, user);
    threw.engine.runNow(a.id);
    await flush();
    expect(observed(threw.hooks).find((o) => o.type === 'run')).toMatchObject({ outcome: 'failed', reasonCode: 'step_threw', stepResults: [{ kind: 'sleep', outcome: 'failed' }] });
  });

  it('reports catch-up, then a catch_up trigger for each missed time it runs, marked as Clubhouse’s own', async () => {
    const action: Action = {
      id: 'a1', name: 'Morning', trigger: { ...weekdays9, missed: 'each' }, steps: [notify], overlap: 'skip',
      owner: { kind: 'app' }, enabled: true, createdAt: 0, updatedAt: 0,
    };
    const { engine, hooks } = setup({ actions: [action], state: { nextAt: { a1: new Date(2026, 10, 2, 9, 0).getTime() }, waits: [] } });
    engine.start();
    await flush(); await flush();
    const obs = observed(hooks);
    expect(obs[0]).toEqual({ type: 'catch_up', missed: 5, rule: 'each', actionId: 'a1', owner: { kind: 'app' } });
    expect(obs.filter((o) => o.type === 'trigger' && o.trigger === 'catch_up')).toHaveLength(5);
  });

  it('reports a delayed event trigger, its wait and its cancellation with the event kind', async () => {
    const { engine, event, clock, hooks, running } = setup();
    engine.start();
    const a = engine.create({ trigger: { kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: 'lead' }, delayMinutes: 30 }, steps: [notify] }, user);
    event({ type: 'agent.asleep', agentId: 'lead' });
    running.add('lead');
    await clock.advance(31 * MIN);
    const owner = { actionId: a.id, owner: user };
    expect(observed(hooks)).toEqual([
      { type: 'trigger', trigger: 'event', event: 'agent.slept', delayed: true, ...owner },
      { type: 'wait', what: 'started', event: 'agent.slept', ...owner },
      { type: 'wait', what: 'cancelled', event: 'agent.slept', ...owner },
      expect.objectContaining({ type: 'run', outcome: 'cancelled', trigger: 'event', reasonCode: 'condition_changed', ...owner }),
    ]);
  });

  function heldSteps() {
    const state = { hold: false, releases: [] as Array<() => void> };
    const stepImpl = (step: ActionStep) => new Promise<ActionStepResult>((resolve) => {
      const done = () => resolve({ kind: step.kind, outcome: 'done', detail: 'ok' });
      if (state.hold) state.releases.push(done);
      else done();
    });
    return { state, stepImpl };
  }

  it('reports the hourly limit for queued runs dropped when they come up', async () => {
    const { state, stepImpl } = heldSteps();
    const { engine, hooks, history } = setup({ stepImpl });
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify], overlap: 'queue' }, user);
    for (let i = 0; i < 59; i++) { engine.runNow(a.id); await flush(); }
    state.hold = true;
    engine.runNow(a.id); // the 60th run this hour
    await flush();
    engine.runNow(a.id);
    engine.runNow(a.id);
    hooks.observe.mockClear();
    state.releases.forEach((r) => r());
    await flush();
    const obs = observed(hooks);
    expect(obs.filter((o) => o.type === 'limit')).toEqual([
      { type: 'limit', what: 'hourly', chainDepth: 0, actionId: a.id, owner: user },
      { type: 'limit', what: 'hourly', chainDepth: 0, actionId: a.id, owner: user },
    ]);
    expect(obs.filter((o) => o.type === 'run' && o.reasonCode === 'hourly_limit')).toHaveLength(2);
    expect(history(a.id).filter((r) => r.outcome === 'skipped')).toHaveLength(2);
  });

  it('observes queued runs of a deleted action as cancelled, without history', async () => {
    const { state, stepImpl } = heldSteps();
    state.hold = true;
    const { engine, hooks, history } = setup({ stepImpl });
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify], overlap: 'queue' }, user);
    engine.runNow(a.id);
    await flush();
    engine.runNow(a.id);
    engine.runNow(a.id);
    hooks.observe.mockClear();
    engine.remove(a.id);
    expect(observed(hooks)).toEqual([0, 1].map(() => ({
      type: 'run', outcome: 'cancelled', trigger: 'manual', steps: 0, stepResults: [], chainDepth: 0, durationMs: 0,
      reasonCode: 'deleted', actionId: a.id, owner: user,
    })));
    state.releases.forEach((r) => r());
    await flush();
    // Only the run that was going finishes; nothing queued starts or is written.
    expect(history(a.id).map((r) => r.outcome)).toEqual(['done']);
    expect(observed(hooks).filter((o) => o.type === 'run').map((o) => o.type === 'run' && o.outcome)).toEqual(['cancelled', 'cancelled', 'done']);
  });

  it('a throwing observer never breaks a run', async () => {
    const { engine, hooks, history } = setup();
    hooks.observe.mockImplementation(() => { throw new Error('telemetry broke'); });
    engine.start();
    const a = engine.create({ trigger: weekdays9, steps: [notify] }, user);
    engine.runNow(a.id);
    await flush();
    expect(history(a.id)).toMatchObject([{ outcome: 'done' }]);
  });
});

// ── Subscriptions (#3042) ───────────────────────────────────────────────────

describe('subscriptions (#3042)', () => {
  const pushedMain = { kind: 'event', event: 'git.remote_updated', source: { kind: 'project', projectId: 'p1' }, branch: 'main' } as const;
  const leadAgent = { kind: 'agent', agentId: 'lead' } as const;

  it('an agent’s subscription is its own action, with one step that messages it', () => {
    const { engine } = setup();
    engine.start();
    const a = engine.subscribe({ trigger: pushedMain, note: 'Tag the release.' }, leadAgent);
    expect(a).toMatchObject({
      name: 'Tell release-lead when web is pushed, pulled or fetched (main)',
      owner: leadAgent,
      subscription: true,
      overlap: 'queue',
      enabled: true,
      steps: [{ kind: 'message', agentId: 'lead', text: 'Tag the release.' }],
    });
    // It is an ordinary action: listed and counted with the others.
    expect(engine.list().map((x) => x.id)).toContain(a.id);
    expect(engine.subscribe({ trigger: pushedMain }, leadAgent).steps[0]).toMatchObject({ text: 'You asked to be told when this happens.' });
  });

  it('messages its owner when the event fires, saying what happened, and again for the next one', async () => {
    const { engine, event, stepCalls, history } = setup();
    engine.start();
    const a = engine.subscribe({ trigger: pushedMain }, leadAgent);
    event({ type: 'git.remote_updated', repoPath: '/p1', branch: 'dev' });
    await flush();
    expect(stepCalls).toHaveLength(0);
    event({ type: 'git.remote_updated', repoPath: '/p1', branch: 'main' });
    event({ type: 'git.remote_updated', repoPath: '/p1', branch: 'main' });
    await flush();
    expect(stepCalls).toHaveLength(2);
    expect(stepCalls[0].step).toEqual({ kind: 'message', agentId: 'lead', text: 'You asked to be told when this happens.' });
    expect(stepCalls[0].ctx.trigger).toMatchObject({ kind: 'event', detail: 'web is pushed, pulled or fetched (main)' });
    expect(history(a.id).map((r) => r.outcome)).toEqual(['done', 'done']);
  });

  it('follows the owner’s rights, when made and on every run', async () => {
    let refuse = false;
    const { engine, event, stepCalls, history } = setup({ refuseSource: () => (refuse ? 'release-lead can’t act on that project.' : null) });
    engine.start();
    refuse = true;
    expect(() => engine.subscribe({ trigger: pushedMain }, leadAgent)).toThrow(/can’t act on that project/);
    refuse = false;
    const a = engine.subscribe({ trigger: pushedMain }, leadAgent);
    refuse = true;
    event({ type: 'git.remote_updated', repoPath: '/p1', branch: 'main' });
    await flush();
    expect(stepCalls).toHaveLength(0);
    expect(history(a.id)[0]).toMatchObject({ outcome: 'failed', reason: 'Couldn’t run: release-lead can’t act on that project.' });
  });

  it('the Dispatcher subscribes for itself the same way, and so can Clubhouse’s own upkeep', async () => {
    const { engine, event, stepCalls } = setup({
      dispatcher: 'disp',
      agents: { lead: { name: 'release-lead', projectId: 'p1' }, disp: { name: 'Dispatcher', projectId: '' } },
    });
    engine.start();
    const leadSlept = { kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: 'lead' } } as const;
    const mine = engine.subscribe({ trigger: leadSlept, note: 'Check its handoff.' }, { kind: 'dispatcher' });
    expect(mine).toMatchObject({ owner: { kind: 'dispatcher' }, subscription: true, name: 'Tell Dispatcher when release-lead goes to sleep' });
    const upkeep = engine.subscribe({ trigger: leadSlept, name: 'upkeep' }, { kind: 'app' });
    expect(upkeep.steps).toEqual([{ kind: 'message', agentId: 'disp', text: 'You asked to be told when this happens.' }]);
    event({ type: 'agent.asleep', agentId: 'lead' });
    await flush();
    expect(stepCalls.map((c) => [c.ctx.action.id, c.step])).toEqual([
      [mine.id, { kind: 'message', agentId: 'disp', text: 'Check its handoff.' }],
      [upkeep.id, { kind: 'message', agentId: 'disp', text: 'You asked to be told when this happens.' }],
    ]);
    expect(stepCalls[0].ctx.trigger?.detail).toBe('release-lead goes to sleep');
  });

  it('needs an event and someone to tell', () => {
    const { engine } = setup();
    engine.start();
    expect(() => engine.subscribe({ trigger: weekdays9 }, leadAgent)).toThrow(/needs an event trigger/);
    expect(() => engine.subscribe({ trigger: pushedMain }, user)).toThrow(/Only agents and the Dispatcher/);
    // No Dispatcher yet: nobody to tell.
    expect(() => engine.subscribe({ trigger: pushedMain }, { kind: 'dispatcher' })).toThrow(/Only agents and the Dispatcher/);
    expect(() => engine.create({ trigger: pushedMain, steps: [notify] }, leadAgent, { subscription: true })).toThrow(/messages its owner/);
  });

  it('stays a subscription while an edit keeps its shape', () => {
    const { engine } = setup();
    engine.start();
    const a = engine.subscribe({ trigger: pushedMain }, leadAgent);
    const renamed = engine.update(a.id, { name: 'Pushes', trigger: { ...pushedMain, branch: 'release' }, steps: a.steps });
    expect(renamed.subscription).toBe(true);
    const changed = engine.update(a.id, { name: 'Pushes', trigger: pushedMain, steps: [{ kind: 'message', agentId: 'pm', text: 'hi' }] });
    expect(changed.subscription).toBeUndefined();
  });
});
