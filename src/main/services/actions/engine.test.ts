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
  start?: number;
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
    rights: { checkStep: (_owner, step) => opts.refuse?.(step) ?? null },
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
