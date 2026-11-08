/**
 * The Actions engine (#2918, #2958). It owns every action, decides when each
 * one runs, and runs its steps:
 *
 * 1. A trigger fires: a schedule time, a one-time time, an app event, or Run now.
 * 2. Delay and re-check: an event trigger can wait; when the wait ends the
 *    condition is checked again and the run is cancelled if it no longer
 *    holds. A new matching event restarts the wait. Waits survive a restart
 *    of the app and are re-checked on launch.
 * 3. Loop protection and the hourly limit.
 * 4. Overlap rule: skip, or queue behind the running run.
 * 5. Rights check for each step, then the steps in order, stopping at the
 *    first that couldn't run.
 * 6. Recorded in history.
 *
 * Everything outside (storage, clock, agents, steps, rights) is passed in, so
 * the rules here are tested without Electron.
 */

import {
  ActionError,
  MAX_CHAIN_DEPTH,
  MAX_MISSED_RUNS,
  MAX_RUNS_PER_HOUR,
  assertActionInput,
  cronTimesBetween,
  eventPhrase,
  nextCronTime,
  parseCron,
  suggestActionName,
  type Action,
  type ActionEventKind,
  type ActionNames,
  type ActionOwner,
  type ActionRun,
  type ActionRunTrigger,
  type ActionStep,
  type ActionStepResult,
  type ActionTrigger,
  type EventTrigger,
} from '../../../shared/actions';
import type { AppEvent } from '../app-event-bus';

// ── Ports ───────────────────────────────────────────────────────────────────

export interface EngineClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** A wait for a delayed event trigger, kept across restarts. */
export interface PersistedWait {
  actionId: string;
  /** The agent the event was about, when any: each agent has its own wait. */
  agentId?: string;
  startedAt: number;
  dueAt: number;
  chain: string[];
  detail: string;
}

export interface EngineState {
  /** The next schedule time per schedule action. */
  nextAt: Record<string, number>;
  waits: PersistedWait[];
}

export interface EngineStorage {
  load(): { actions: Action[]; state: EngineState };
  saveActions(actions: Action[]): void;
  saveState(state: EngineState): void;
}

export interface RunHistory {
  /** Record a new run, or replace one with the same id. */
  put(run: ActionRun): void;
  list(actionId: string): ActionRun[];
}

/** What the engine needs to know about agents and projects. Synchronous: answered from caches. */
export interface EngineFacts {
  agentExists(agentId: string): boolean;
  isRunning(agentId: string): boolean;
  agentName(agentId: string): string | undefined;
  /** A durable agent's project. */
  agentProjectId(agentId: string): string | undefined;
  projectName(projectId: string): string | undefined;
  projectIdForPath(projectPath: string): string | undefined;
  /** Which project and agent worktree a repo path belongs to. */
  repoOwner(repoPath: string): { projectId?: string; agentId?: string };
}

export interface StepContext {
  action: Action;
  runId: string;
  /** The chain this run's steps pass on: the run's chain plus this action. */
  chain: string[];
}

export interface StepRunner {
  /** Run one step. Never throws: a step that couldn't run comes back failed. */
  run(step: ActionStep, ctx: StepContext): Promise<ActionStepResult>;
}

export interface ActionRights {
  /** Null when the owner may do this step, else the reason in plain words. */
  checkStep(owner: ActionOwner, step: ActionStep): string | null;
  /** Null when the owner may watch what this trigger watches, else the reason in plain words. */
  checkSource(owner: ActionOwner, trigger: ActionTrigger): string | null;
  /** The most actions this owner may have, or null for no limit. */
  maxActions(owner: ActionOwner): number | null;
}

export interface EngineHooks {
  /** The actions or a run changed: the UI refreshes. */
  changed?(): void;
  /** A run couldn't do its job (a mechanical failure): toast. */
  failed?(action: Action, reason: string): void;
  /** Clubhouse turned an action off: toast. */
  turnedOff?(action: Action, reason: string): void;
  /** For telemetry. */
  observe?(event: EngineObservation): void;
}

export type EngineObservation =
  | { type: 'trigger'; actionId: string; trigger: ActionRunTrigger['kind'] }
  | { type: 'wait'; actionId: string; what: 'started' | 'restarted' | 'cancelled' | 'fired' | 'dropped' }
  | { type: 'overlap'; actionId: string; what: 'skipped' | 'queued' }
  | { type: 'limit'; actionId: string; what: 'chain' | 'self' | 'hourly' }
  | { type: 'catch_up'; actionId: string; missed: number; rule: string }
  | { type: 'run'; actionId: string; outcome: ActionRun['outcome']; steps: number; chainDepth: number; reason?: string };

export interface EngineDeps {
  clock: EngineClock;
  storage: EngineStorage;
  history: RunHistory;
  facts: EngineFacts;
  steps: StepRunner;
  rights: ActionRights;
  hooks?: EngineHooks;
  newId?: () => string;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** A schedule time this late still runs as itself, not as a missed time. */
export const SCHEDULE_GRACE_MS = 2 * 60 * 1000;
/** The longest single timer: also how soon a clock change is noticed. */
export const MAX_TIMER_MS = 60 * 1000;
/** Runs waiting behind a running one, at most. */
export const MAX_QUEUED_RUNS = 10;
const HOUR_MS = 60 * 60 * 1000;

// ── Event matching ──────────────────────────────────────────────────────────

/** One app event as the trigger kinds it can match. */
interface Occurrence {
  kind: ActionEventKind;
  /** The agent it is about (for agent sources and per-agent waits). */
  agentId?: string;
  projectId?: string;
  branch?: string;
  /** For the history line: "release-lead goes to sleep". */
  subject: string;
}

/** Whether two owners are the same person, Dispatcher, agent or Clubhouse. */
function sameOwner(a: ActionOwner, b: ActionOwner): boolean {
  if (a.kind === 'agent' || b.kind === 'agent') return a.kind === 'agent' && b.kind === 'agent' && a.agentId === b.agentId;
  return a.kind === b.kind;
}

function hasStepTarget(step: ActionStep, agentId: string): boolean {
  if (step.kind === 'quick') return step.worktreeAgentId === agentId;
  return 'agentId' in step && step.agentId === agentId;
}

/** Whether an action names this agent anywhere: trigger source or a step. */
export function actionReferencesAgent(action: Action, agentId: string): boolean {
  const t = action.trigger;
  // "When X is deleted" is about X going: that isn't a reason to turn it off.
  if (t.kind === 'event' && t.source.kind === 'agent' && t.source.agentId === agentId && t.event !== 'agent.deleted') return true;
  return action.steps.some((s) => hasStepTarget(s, agentId));
}

/**
 * The latest `n` schedule times in [due, now], oldest first. Searches back
 * from now in growing windows, so a long closure doesn't walk every time.
 */
export function latestMissedTimes(spec: Parameters<typeof cronTimesBetween>[0], due: number, now: number, n: number): number[] {
  const WINDOWS = [HOUR_MS, 24 * HOUR_MS, 7 * 24 * HOUR_MS, 31 * 24 * HOUR_MS, 366 * 24 * HOUR_MS, 5 * 366 * 24 * HOUR_MS];
  for (const w of WINDOWS) {
    const from = Math.max(due - 1, now - w);
    const times = cronTimesBetween(spec, from, now, 10_000);
    if (times.length >= n || from === due - 1) return times.slice(-n);
  }
  return cronTimesBetween(spec, due - 1, now, n);
}

// ── Engine ──────────────────────────────────────────────────────────────────

interface QueuedRun {
  trigger: ActionRunTrigger;
  chain: string[];
  runId: string;
}

export class ActionsEngine {
  private actions = new Map<string, Action>();
  private state: EngineState = { nextAt: {}, waits: [] };
  private timer: unknown = null;
  private started = false;
  /** Actions with a run going, and what waits behind it. */
  private running = new Map<string, QueuedRun[]>();
  /** Run start times in the last hour, per action. */
  private recentStarts = new Map<string, number[]>();
  /** When each agent last started a turn, for the idle re-check. */
  private lastTurnStart = new Map<string, number>();
  private idCounter = 0;

  constructor(private readonly deps: EngineDeps) {}

  private now(): number { return this.deps.clock.now(); }

  private newId(prefix: string): string {
    if (this.deps.newId) return `${prefix}_${this.deps.newId()}`;
    this.idCounter++;
    return `${prefix}_${this.now().toString(36)}${this.idCounter.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  private names(): ActionNames {
    return { agent: (id) => this.deps.facts.agentName(id), project: (id) => this.deps.facts.projectName(id) };
  }

  // ── Lifecycle ──

  /** Load actions and waits, catch up on what was missed, and start the clock. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const loaded = this.deps.storage.load();
    for (const a of loaded.actions) this.actions.set(a.id, a);
    this.state = { nextAt: { ...loaded.state.nextAt }, waits: [...loaded.state.waits] };
    // Waits for actions that are gone or off are dropped.
    this.state.waits = this.state.waits.filter((w) => this.actions.get(w.actionId)?.enabled);
    for (const id of Object.keys(this.state.nextAt)) {
      const a = this.actions.get(id);
      if (!a || a.trigger.kind !== 'schedule' || !a.enabled) delete this.state.nextAt[id];
    }
    for (const a of this.actions.values()) {
      if (a.enabled && a.trigger.kind === 'schedule' && this.state.nextAt[a.id] === undefined) this.armSchedule(a);
    }
    this.restoreWaits();
    this.saveState();
    this.tick();
  }

  stop(): void {
    if (this.timer !== null) this.deps.clock.clearTimeout(this.timer);
    this.timer = null;
    this.started = false;
  }

  /** The machine woke from sleep, or the clock jumped: catch up now. */
  resume(): void {
    if (this.started) this.tick();
  }

  // ── Reads ──

  list(): Action[] {
    return [...this.actions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Action | undefined {
    return this.actions.get(id);
  }

  history(id: string): ActionRun[] {
    return this.deps.history.list(id);
  }

  /** The next time a schedule or one-time action runs, for the UI. */
  nextRunAt(id: string): number | undefined {
    const a = this.actions.get(id);
    if (!a?.enabled) return undefined;
    if (a.trigger.kind === 'once') return a.trigger.at;
    return this.state.nextAt[id];
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  // ── Writes ──

  /** The agents and projects an action names must exist when it is saved. */
  private checkTargets(trigger: Action['trigger'], steps: ActionStep[]): void {
    const f = this.deps.facts;
    const agent = (id: string) => {
      if (!f.agentExists(id)) throw new ActionError('invalid_input', 'One of the agents it names isn’t in Clubhouse.');
    };
    const project = (id: string) => {
      if (!f.projectName(id)) throw new ActionError('invalid_input', 'One of the projects it names isn’t in Clubhouse.');
    };
    if (trigger.kind === 'event') {
      // A "when X is deleted" trigger may name an agent that is about to go.
      if (trigger.source.kind === 'agent' && trigger.event !== 'agent.deleted') agent(trigger.source.agentId);
      if (trigger.source.kind === 'project') project(trigger.source.projectId);
    }
    for (const s of steps) {
      if (s.kind === 'quick') {
        project(s.projectId);
        if (s.worktreeAgentId) agent(s.worktreeAgentId);
      } else if (s.kind !== 'notify') agent(s.agentId);
    }
  }

  /** Why the owner may not have this trigger and these steps, or null. */
  private refusal(owner: ActionOwner, trigger: ActionTrigger, steps: ActionStep[]): string | null {
    const source = this.deps.rights.checkSource(owner, trigger);
    if (source) return source;
    for (const step of steps) {
      const reason = this.deps.rights.checkStep(owner, step);
      if (reason) return reason;
    }
    return null;
  }

  /** Checked before the targets exist, so a refusal reads the same either way. */
  private checkRights(owner: ActionOwner, trigger: ActionTrigger, steps: ActionStep[]): void {
    const reason = this.refusal(owner, trigger, steps);
    if (reason) throw new ActionError('not_allowed', reason);
  }

  private checkCount(owner: ActionOwner): void {
    const max = this.deps.rights.maxActions(owner);
    if (max === null) return;
    const count = this.list().filter((a) => sameOwner(a.owner, owner)).length;
    if (count >= max) throw new ActionError('not_allowed', `That’s ${max} actions already, the most this owner can have. Delete one first.`);
  }

  create(input: unknown, owner: ActionOwner): Action {
    const valid = assertActionInput(input);
    this.checkRights(owner, valid.trigger, valid.steps);
    this.checkTargets(valid.trigger, valid.steps);
    this.checkCount(owner);
    const now = this.now();
    const action: Action = {
      id: this.newId('act'),
      name: valid.name ?? suggestActionName(valid, this.names()),
      trigger: valid.trigger,
      steps: valid.steps,
      overlap: valid.overlap,
      owner,
      enabled: valid.enabled,
      createdAt: now,
      updatedAt: now,
    };
    this.actions.set(action.id, action);
    if (action.enabled && action.trigger.kind === 'schedule') this.armSchedule(action);
    this.persist();
    return action;
  }

  /** Replace an action's definition. The owner stays; rights are checked against it. */
  update(id: string, input: unknown): Action {
    const current = this.require(id);
    const valid = assertActionInput(input);
    this.checkRights(current.owner, valid.trigger, valid.steps);
    this.checkTargets(valid.trigger, valid.steps);
    // An edit that doesn't say keeps the on/off state: it never quietly turns back on.
    const saysEnabled = typeof input === 'object' && input !== null && typeof (input as { enabled?: unknown }).enabled === 'boolean';
    const next: Action = {
      ...current,
      name: valid.name ?? suggestActionName(valid, this.names()),
      trigger: valid.trigger,
      steps: valid.steps,
      overlap: valid.overlap,
      enabled: saysEnabled ? valid.enabled : current.enabled,
      updatedAt: this.now(),
    };
    // Edited: the old failure and the reason it was turned off no longer apply.
    delete next.problem;
    if (next.enabled) delete next.offReason;
    this.actions.set(id, next);
    this.dropWaits(id);
    this.cancelQueued(id, 'The action was edited before this run started');
    delete this.state.nextAt[id];
    if (next.enabled && next.trigger.kind === 'schedule') this.armSchedule(next);
    this.persist();
    return next;
  }

  setEnabled(id: string, enabled: boolean): Action {
    const current = this.require(id);
    // Turning it on checks rights again: what was allowed may not be now.
    if (enabled) this.checkRights(current.owner, current.trigger, current.steps);
    const next: Action = { ...current, enabled, updatedAt: this.now() };
    if (enabled) {
      delete next.offReason;
      delete next.problem;
    }
    this.actions.set(id, next);
    if (!enabled) {
      this.dropWaits(id);
      this.cancelQueued(id, 'The action was turned off before this run started');
      delete this.state.nextAt[id];
    } else if (next.trigger.kind === 'schedule') {
      // Turning it back on doesn't run the times it was off for.
      this.armSchedule(next);
    }
    this.persist();
    return next;
  }

  remove(id: string): void {
    this.require(id);
    this.actions.delete(id);
    this.dropWaits(id);
    delete this.state.nextAt[id];
    // A run going now finishes; nothing queued behind it starts.
    const queue = this.running.get(id);
    if (queue) queue.length = 0;
    this.persist();
  }

  /** Drop runs waiting behind a running one, recording them as cancelled. */
  private cancelQueued(id: string, reason: string): void {
    const queue = this.running.get(id);
    const action = this.actions.get(id);
    if (!queue?.length || !action) return;
    for (const q of queue.splice(0)) this.recordOnly(action, q.trigger, q.chain, 'cancelled', reason);
  }

  /** Run now, as a normal run. Works on an action that is off. Returns the run id. */
  runNow(id: string): string {
    const action = this.require(id);
    return this.fire(action, { kind: 'manual', at: this.now(), detail: 'Run now' }, []);
  }

  private require(id: string): Action {
    const a = this.actions.get(id);
    if (!a) throw new ActionError('not_found', 'No action with that id.');
    return a;
  }

  private turnOff(action: Action, reason: string): void {
    if (!action.enabled && action.offReason === reason) return;
    const next: Action = { ...action, enabled: false, offReason: reason, updatedAt: this.now() };
    this.actions.set(action.id, next);
    this.dropWaits(action.id);
    this.cancelQueued(action.id, reason);
    delete this.state.nextAt[action.id];
    this.persist();
    if (action.enabled && action.owner.kind !== 'app') this.deps.hooks?.turnedOff?.(next, reason);
  }

  // ── Persistence ──

  private persist(): void {
    this.deps.storage.saveActions(this.list());
    this.saveState();
    this.deps.hooks?.changed?.();
    if (this.started) this.armTimer();
  }

  private saveState(): void {
    this.deps.storage.saveState({ nextAt: { ...this.state.nextAt }, waits: [...this.state.waits] });
  }

  // ── Clock ──

  private armSchedule(action: Action): void {
    if (action.trigger.kind !== 'schedule') return;
    const parsed = parseCron(action.trigger.cron);
    const next = parsed.ok ? nextCronTime(parsed.spec, this.now()) : null;
    if (next) this.state.nextAt[action.id] = next.getTime();
    else delete this.state.nextAt[action.id];
  }

  private armTimer(): void {
    if (this.timer !== null) this.deps.clock.clearTimeout(this.timer);
    this.timer = null;
    let earliest = Infinity;
    for (const a of this.actions.values()) {
      if (!a.enabled) continue;
      if (a.trigger.kind === 'once') earliest = Math.min(earliest, a.trigger.at);
      const at = this.state.nextAt[a.id];
      if (at !== undefined) earliest = Math.min(earliest, at);
    }
    for (const w of this.state.waits) earliest = Math.min(earliest, w.dueAt);
    if (earliest === Infinity) return;
    const delay = Math.max(0, Math.min(MAX_TIMER_MS, earliest - this.now()));
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
  }

  /** Run whatever is due: schedule times (with catch-up), one-time actions, and waits. */
  tick(): void {
    const now = this.now();
    let dirty = false;
    for (const action of this.list()) {
      if (!action.enabled) continue;
      const t = action.trigger;
      if (t.kind === 'once' && t.at <= now) {
        // One-time actions delete themselves as they fire; the run stays in history.
        this.actions.delete(action.id);
        this.dropWaits(action.id);
        this.deps.hooks?.observe?.({ type: 'trigger', actionId: action.id, trigger: 'once' });
        this.fire(action, { kind: 'once', at: t.at, ...(now - t.at > SCHEDULE_GRACE_MS && { detail: 'Ran late: Clubhouse was closed or asleep at the set time' }) }, []);
        dirty = true;
        continue;
      }
      if (t.kind !== 'schedule') continue;
      const due = this.state.nextAt[action.id];
      if (due === undefined || due > now) continue;
      this.runScheduleTimes(action, due, now);
      this.armSchedule(action);
      dirty = true;
    }
    for (const wait of [...this.state.waits]) {
      if (wait.dueAt <= now) {
        this.finishWait(wait);
        dirty = true;
      }
    }
    if (dirty) {
      this.deps.storage.saveActions(this.list());
      this.saveState();
      this.deps.hooks?.changed?.();
    }
    if (this.started) this.armTimer();
  }

  private runScheduleTimes(action: Action, due: number, now: number): void {
    if (action.trigger.kind !== 'schedule') return;
    if (now - due <= SCHEDULE_GRACE_MS) {
      this.deps.hooks?.observe?.({ type: 'trigger', actionId: action.id, trigger: 'schedule' });
      this.fire(action, { kind: 'schedule', at: due }, []);
      return;
    }
    // Missed while the app was closed or the machine slept.
    const parsed = parseCron(action.trigger.cron);
    // The most recent missed times, newest last: "once" runs the latest, "each" the last 10.
    const missed = parsed.ok ? latestMissedTimes(parsed.spec, due, now, MAX_MISSED_RUNS) : [due];
    const rule = action.trigger.missed;
    this.deps.hooks?.observe?.({ type: 'catch_up', actionId: action.id, missed: missed.length, rule });
    if (rule === 'skip') {
      const n = missed.length;
      this.recordOnly(action, { kind: 'catch_up', at: missed[missed.length - 1] ?? due }, [], 'skipped',
        `Skipped ${n === 1 ? 'a scheduled time' : `${n >= MAX_MISSED_RUNS ? `${MAX_MISSED_RUNS} or more` : n} scheduled times`} missed while Clubhouse was closed or asleep`);
      return;
    }
    const times = rule === 'once' ? missed.slice(-1) : missed;
    for (const at of times) this.fire(action, { kind: 'catch_up', at, detail: 'Missed while Clubhouse was closed or asleep' }, [], { forceQueue: true });
  }

  // ── Events ──

  /** Feed an app event in. Returns nothing; runs start asynchronously. */
  handleEvent(event: AppEvent): void {
    if (!this.started) return;
    if (event.type === 'turn.started') {
      this.lastTurnStart.set(event.agentId, event.at);
      // A new turn cancels an idle wait quietly; the next turn end starts it again.
      this.dropWaitsWhere((w) => w.agentId === event.agentId && this.isIdleAction(w.actionId), true);
    }
    const occurrences = this.occurrencesFor(event);
    const chain = event.chain ?? [];
    for (const occ of occurrences) {
      for (const action of this.list()) {
        if (!action.enabled || action.trigger.kind !== 'event') continue;
        if (action.trigger.event !== occ.kind) continue;
        if (!this.matchesSource(action.trigger, occ)) continue;
        this.onMatch(action, action.trigger, occ, chain);
      }
    }
    if (event.type === 'agent.deleted') this.agentDeleted(event.agentId, event.name);
  }

  private isIdleAction(actionId: string): boolean {
    const a = this.actions.get(actionId);
    return a?.trigger.kind === 'event' && a.trigger.event === 'agent.idle';
  }

  private agentSubject(agentId: string, fallbackName?: string): string {
    return this.deps.facts.agentName(agentId) ?? fallbackName ?? 'An agent';
  }

  private occurrencesFor(event: AppEvent): Occurrence[] {
    const f = this.deps.facts;
    const agentOcc = (kind: ActionEventKind, agentId: string, name?: string): Occurrence => ({
      kind, agentId, projectId: f.agentProjectId(agentId), subject: this.agentSubject(agentId, name),
    });
    switch (event.type) {
      case 'agent.awake':
        return f.agentExists(event.agentId) ? [agentOcc('agent.woke', event.agentId)] : [];
      case 'agent.asleep':
        return f.agentExists(event.agentId) ? [agentOcc('agent.slept', event.agentId)] : [];
      case 'agent.created':
      case 'agent.deleted': {
        const kind = event.type === 'agent.created' ? 'agent.created' : 'agent.deleted';
        return [{ kind, agentId: event.agentId, projectId: f.projectIdForPath(event.projectPath), subject: this.agentSubject(event.agentId, event.name) }];
      }
      case 'turn.ended': {
        if (!f.agentExists(event.agentId)) return [];
        const out = [agentOcc('agent.turn_ended', event.agentId), agentOcc('agent.idle', event.agentId)];
        if (event.outcome === 'failed') out.push(agentOcc('agent.turn_failed', event.agentId));
        return out;
      }
      case 'agent.waiting':
        return f.agentExists(event.agentId) ? [agentOcc('agent.waiting', event.agentId)] : [];
      case 'agent.error':
        return f.agentExists(event.agentId) ? [agentOcc('agent.error', event.agentId)] : [];
      case 'agent.compacted':
        return f.agentExists(event.agentId) ? [agentOcc('agent.compacted', event.agentId)] : [];
      case 'helper.finished':
        // "A helper finishes" is about the parent.
        return f.agentExists(event.parentAgentId) ? [agentOcc('helper.finished', event.parentAgentId)] : [];
      case 'git.commit':
      case 'git.branch_switched':
      case 'git.remote_updated': {
        const owner = f.repoOwner(event.repoPath);
        if (!owner.projectId && !owner.agentId) return [];
        const subject = owner.agentId ? `${this.agentSubject(owner.agentId)}’s worktree` : f.projectName(owner.projectId!) ?? 'A project';
        return [{ kind: event.type, agentId: owner.agentId, projectId: owner.projectId, branch: event.branch, subject }];
      }
      case 'app.started':
        return [{ kind: 'app.started', subject: 'Clubhouse' }];
      case 'project.added':
      case 'project.removed':
        return [{ kind: event.type, projectId: event.projectId, subject: f.projectName(event.projectId) ?? 'A project' }];
      default:
        return [];
    }
  }

  private matchesSource(trigger: EventTrigger, occ: Occurrence): boolean {
    // A fetch that moved many branches arrives as one event with branch `*`
    // (#2955): it can't satisfy a filter for one branch.
    if (trigger.branch && occ.branch !== trigger.branch) return false;
    const src = trigger.source;
    if (src.kind === 'app') return true;
    if (src.kind === 'agent') return occ.agentId === src.agentId;
    return occ.projectId === src.projectId;
  }

  private onMatch(action: Action, trigger: EventTrigger, occ: Occurrence, chain: string[]): void {
    const branchText = occ.branch === '*' ? 'many branches' : occ.branch;
    const detail = `${occ.subject} ${eventPhrase(occ.kind)}${branchText ? ` (${branchText})` : ''}`;
    this.deps.hooks?.observe?.({ type: 'trigger', actionId: action.id, trigger: 'event' });
    if (!trigger.delayMinutes) {
      this.fire(action, { kind: 'event', at: this.now(), detail }, chain);
      return;
    }
    const now = this.now();
    const existing = this.state.waits.find((w) => w.actionId === action.id && w.agentId === occ.agentId);
    const wait: PersistedWait = {
      actionId: action.id,
      ...(occ.agentId && { agentId: occ.agentId }),
      startedAt: now,
      dueAt: now + trigger.delayMinutes * 60_000,
      chain,
      detail,
    };
    this.state.waits = this.state.waits.filter((w) => w !== existing);
    this.state.waits.push(wait);
    this.deps.hooks?.observe?.({ type: 'wait', actionId: action.id, what: existing ? 'restarted' : 'started' });
    this.saveState();
    this.armTimer();
  }

  /** Whether a delayed trigger's condition still holds when its wait ends. */
  private conditionHolds(action: Action, wait: PersistedWait): boolean {
    if (action.trigger.kind !== 'event') return false;
    const f = this.deps.facts;
    const agentId = wait.agentId;
    switch (action.trigger.event) {
      case 'agent.slept': return !!agentId && !f.isRunning(agentId);
      case 'agent.woke': return !!agentId && f.isRunning(agentId);
      case 'agent.idle': return !!agentId && (this.lastTurnStart.get(agentId) ?? 0) <= wait.startedAt;
      case 'agent.created': return !!agentId && f.agentExists(agentId);
      case 'agent.deleted': return !!agentId && !f.agentExists(agentId);
      default: return true;
    }
  }

  private finishWait(wait: PersistedWait, atLaunch = false): void {
    this.state.waits = this.state.waits.filter((w) => w !== wait);
    const action = this.actions.get(wait.actionId);
    if (!action?.enabled) return;
    if (!this.conditionHolds(action, wait)) {
      if (atLaunch) {
        this.deps.hooks?.observe?.({ type: 'wait', actionId: action.id, what: 'dropped' });
        return;
      }
      this.deps.hooks?.observe?.({ type: 'wait', actionId: action.id, what: 'cancelled' });
      this.recordOnly(action, { kind: 'event', at: wait.startedAt, detail: wait.detail }, wait.chain, 'cancelled',
        'What set it off no longer held when the wait ended');
      return;
    }
    this.deps.hooks?.observe?.({ type: 'wait', actionId: action.id, what: 'fired' });
    this.fire(action, { kind: 'event', at: wait.startedAt, detail: wait.detail }, wait.chain);
  }

  /** On launch: waits that ended while the app was closed run once if they still hold, else are dropped. */
  private restoreWaits(): void {
    const now = this.now();
    for (const wait of [...this.state.waits]) {
      if (wait.dueAt <= now) this.finishWait(wait, true);
    }
  }

  private dropWaits(actionId: string): void {
    this.dropWaitsWhere((w) => w.actionId === actionId, false);
  }

  private dropWaitsWhere(pred: (w: PersistedWait) => boolean, observe: boolean): void {
    const before = this.state.waits.length;
    const kept = this.state.waits.filter((w) => {
      if (!pred(w)) return true;
      if (observe) this.deps.hooks?.observe?.({ type: 'wait', actionId: w.actionId, what: 'cancelled' });
      return false;
    });
    if (kept.length === before) return;
    this.state.waits = kept;
    this.saveState();
  }

  // ── Agent lifecycle ──

  private agentDeleted(agentId: string, name?: string): void {
    const label = this.deps.facts.agentName(agentId) ?? name ?? 'An agent';
    for (const action of this.list()) {
      const owner = action.owner;
      if (owner.kind === 'agent' && owner.agentId === agentId) {
        if (owner.helper) {
          // A helper's own actions go with it.
          this.remove(action.id);
          continue;
        }
        this.turnOff(action, `Turned off: ${label} was deleted`);
        continue;
      }
      if (action.enabled && actionReferencesAgent(action, agentId)) this.turnOff(action, `Turned off: ${label} was deleted`);
    }
  }

  // ── Runs ──

  private recordOnly(action: Action, trigger: ActionRunTrigger, chain: string[], outcome: 'skipped' | 'cancelled', reason: string): string {
    const now = this.now();
    const run: ActionRun = { id: this.newId('run'), actionId: action.id, owner: action.owner, trigger, chain, startedAt: now, endedAt: now, outcome, reason, steps: [] };
    if (action.owner.kind !== 'app') this.deps.history.put(run);
    this.deps.hooks?.observe?.({ type: 'run', actionId: action.id, outcome, steps: 0, chainDepth: chain.length, reason });
    this.deps.hooks?.changed?.();
    return run.id;
  }

  private underHourlyLimit(actionId: string): boolean {
    const now = this.now();
    const starts = (this.recentStarts.get(actionId) ?? []).filter((t) => now - t < HOUR_MS);
    this.recentStarts.set(actionId, starts);
    return starts.length < MAX_RUNS_PER_HOUR;
  }

  /** Start a run, or skip or queue it. Returns the run id. */
  private fire(action: Action, trigger: ActionRunTrigger, chain: string[], opts: { forceQueue?: boolean } = {}): string {
    if (chain.includes(action.id)) {
      this.deps.hooks?.observe?.({ type: 'limit', actionId: action.id, what: 'self' });
      return this.recordOnly(action, trigger, chain, 'skipped', 'It can’t set itself off');
    }
    if (chain.length >= MAX_CHAIN_DEPTH) {
      this.deps.hooks?.observe?.({ type: 'limit', actionId: action.id, what: 'chain' });
      return this.recordOnly(action, trigger, chain, 'skipped', `Stopped a chain of ${MAX_CHAIN_DEPTH} actions setting each other off`);
    }
    const runId = this.newId('run');
    const queue = this.running.get(action.id);
    if (queue) {
      if ((action.overlap === 'queue' || opts.forceQueue) && queue.length < MAX_QUEUED_RUNS) {
        queue.push({ trigger, chain, runId });
        this.deps.hooks?.observe?.({ type: 'overlap', actionId: action.id, what: 'queued' });
        return runId;
      }
      this.deps.hooks?.observe?.({ type: 'overlap', actionId: action.id, what: 'skipped' });
      return this.recordOnly(action, trigger, chain, 'skipped', 'The last run was still going');
    }
    if (!this.underHourlyLimit(action.id)) {
      this.deps.hooks?.observe?.({ type: 'limit', actionId: action.id, what: 'hourly' });
      return this.recordOnly(action, trigger, chain, 'skipped', `Ran ${MAX_RUNS_PER_HOUR} times in the last hour`);
    }
    this.running.set(action.id, []);
    this.execute(action, trigger, chain, runId).catch(() => {
      // telemetry-exempt: execute settles its own run; this only keeps a rejection from going unhandled
    });
    return runId;
  }

  /** Run, then the next queued run. Whatever happens, the action never stays marked as running. */
  private async execute(action: Action, trigger: ActionRunTrigger, chain: string[], runId: string): Promise<void> {
    let next: { action: Action; run: QueuedRun } | null = null;
    try {
      next = await this.runOnce(action, trigger, chain, runId);
    } finally {
      if (!next) this.running.delete(action.id);
    }
    if (next) await this.execute(next.action, next.run.trigger, next.run.chain, next.run.runId);
  }

  /** One run. Returns the queued run to start next, if any. */
  private async runOnce(action: Action, trigger: ActionRunTrigger, chain: string[], runId: string): Promise<{ action: Action; run: QueuedRun } | null> {
    const actionId = action.id;
    const starts = this.recentStarts.get(actionId) ?? [];
    starts.push(this.now());
    this.recentStarts.set(actionId, starts);
    const hidden = action.owner.kind === 'app';
    const run: ActionRun = { id: runId, actionId, owner: action.owner, trigger, chain, startedAt: this.now(), outcome: 'running', steps: [] };
    if (!hidden) this.deps.history.put(run);
    this.deps.hooks?.changed?.();

    let failure: string | undefined;
    // What it watches is checked again on every run too: a mechanical failure, like a step.
    const sourceRefused = this.deps.rights.checkSource(action.owner, action.trigger);
    if (sourceRefused) failure = `Couldn’t run: ${sourceRefused}`;
    for (const step of sourceRefused ? [] : action.steps) {
      // Rights are checked again on every run: what was allowed may not be now.
      const refused = this.deps.rights.checkStep(action.owner, step);
      if (refused) {
        failure = `Couldn’t run: ${refused}`;
        run.steps.push({ kind: step.kind, outcome: 'failed', detail: refused });
        break;
      }
      let result: ActionStepResult;
      try {
        result = await this.deps.steps.run(step, { action, runId, chain: [...chain, actionId] });
      } catch (err) {
        // telemetry-exempt: recorded on the run and reported as a mechanical failure below
        result = { kind: step.kind, outcome: 'failed', detail: err instanceof Error ? err.message : String(err) };
      }
      run.steps.push(result);
      if (!hidden) this.deps.history.put({ ...run, steps: [...run.steps] });
      if (result.outcome === 'failed') {
        failure = result.detail;
        break;
      }
    }

    run.endedAt = this.now();
    run.outcome = failure ? 'failed' : 'done';
    if (failure) run.reason = failure;
    if (!hidden) this.deps.history.put({ ...run, steps: [...run.steps] });
    this.deps.hooks?.observe?.({ type: 'run', actionId, outcome: run.outcome, steps: run.steps.length, chainDepth: chain.length, ...(failure && { reason: failure }) });

    const current = this.actions.get(actionId);
    if (!current) {
      // A one-time action, or one deleted during the run.
      if (failure && !hidden) this.deps.hooks?.failed?.(action, failure);
      this.deps.hooks?.changed?.();
    } else if (failure) {
      this.actions.set(actionId, { ...current, problem: failure });
      this.persist();
      if (!hidden) this.deps.hooks?.failed?.(current, failure);
    } else if (current.problem) {
      const next = { ...current };
      delete next.problem;
      this.actions.set(actionId, next);
      this.persist();
    } else {
      this.deps.hooks?.changed?.();
    }

    const queue = this.running.get(actionId);
    const nextRun = queue?.shift();
    const latest = this.actions.get(actionId);
    if (!nextRun || !latest) return null;
    if (!latest.enabled && nextRun.trigger.kind !== 'manual') {
      this.recordOnly(latest, nextRun.trigger, nextRun.chain, 'cancelled', 'The action was turned off before this run started');
      for (const rest of queue?.splice(0) ?? []) this.recordOnly(latest, rest.trigger, rest.chain, 'cancelled', 'The action was turned off before this run started');
      return null;
    }
    if (!this.underHourlyLimit(actionId)) {
      const reason = `Ran ${MAX_RUNS_PER_HOUR} times in the last hour`;
      this.recordOnly(latest, nextRun.trigger, nextRun.chain, 'skipped', reason);
      for (const rest of queue?.splice(0) ?? []) this.recordOnly(latest, rest.trigger, rest.chain, 'skipped', reason);
      return null;
    }
    return { action: latest, run: nextRun };
  }
}
