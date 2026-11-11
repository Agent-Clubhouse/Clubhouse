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
  DEFAULT_COALESCE_SECONDS,
  MAX_CHAIN_DEPTH,
  MAX_MISSED_RUNS,
  MAX_RUNS_PER_HOUR,
  assertActionInput,
  cronTimesBetween,
  eventPhrase,
  nextCronTime,
  parseCron,
  isSubscriptionShape,
  subscriptionStep,
  suggestActionName,
  suggestSubscriptionName,
  validateTrigger,
  type Action,
  type ActionEventKind,
  type ActionNames,
  type ActionOwner,
  type ActionRun,
  type ActionRunEvent,
  type ActionRunTrigger,
  type ActionStep,
  type ActionStepKind,
  type ActionStepResult,
  type ActionTrigger,
  type EventTrigger,
  type MissedRunRule,
} from '../../../shared/actions';
import type { AppEvent } from '../app-event-bus';
import type { ActionQueueSettlement } from '../../../shared/chat';

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
  /** Keep quick-source read checks after its in-memory identity expires. */
  sourceAgentId?: string;
  device?: NonNullable<ActionRunTrigger['device']>;
  startedAt: number;
  dueAt: number;
  chain: string[];
  detail: string;
}

export interface EngineState {
  /** The next schedule time per schedule action. */
  nextAt: Record<string, number>;
  waits: PersistedWait[];
  /** Last observed app use. A relaunch never replays a return. */
  lastUse?: number;
  /** Local-date high-water mark per action, consumed only by started event-action runs. */
  lastFiredDate?: Record<string, string>;
  /** Started runs retained independently of the short run history, for per-action throttles. */
  throttleStarts?: Record<string, number[]>;
}

export interface EngineStorage {
  load(): { actions: Action[]; state: EngineState };
  saveActions(actions: Action[]): void;
  saveState(state: EngineState): void;
}

export interface RunHistory {
  /** Record a new run, or replace one with the same id. */
  put(run: ActionRun): void;
  /** Omit the id for all retained history, including deleted and one-time actions. */
  list(actionId?: string): ActionRun[];
}

/** What the engine needs to know about agents and projects. Synchronous: answered from caches. */
export interface EngineFacts {
  /** Undefined during startup or while this computer is away. */
  deviceOnline?(deviceId: string): boolean | undefined;
  agentExists(agentId: string): boolean;
  isRunning(agentId: string): boolean;
  agentName(agentId: string): string | undefined;
  /** An agent's project, including quick agents. */
  agentProjectId(agentId: string): string | undefined;
  isQuickAgent?(agentId: string): boolean;
  projectName(projectId: string): string | undefined;
  projectIdForPath(projectPath: string): string | undefined;
  /** Which project and agent worktree a repo path belongs to. */
  repoOwner(repoPath: string): { projectId?: string; agentId?: string };
  /**
   * The Dispatcher's agent id: who the Dispatcher's subscriptions, and
   * Clubhouse's own (#3040), tell. Unset when there is no Dispatcher.
   */
  dispatcherAgentId?(): string | undefined;
  /** Both Dispatcher identities and their owned helpers, never watched by an any-agent source. */
  isDispatcherOwnedAgent?(agentId: string): boolean;
}

export interface StepContext {
  action: Action;
  runId: string;
  /** The chain this run's steps pass on: the run's chain plus this action. */
  chain: string[];
  /** What set the run off. An event's detail ("web is pushed (main)") goes into messages. */
  trigger?: ActionRunTrigger;
  deliveryChanged?: (delivery: ActionQueueSettlement) => void;
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

/**
 * Why a run was skipped, cancelled or failed, as a closed code. The words
 * stay in history; telemetry takes only the code.
 */
export type RunReasonCode =
  | 'self_trigger'
  | 'chain_limit'
  | 'overlap'
  | 'hourly_limit'
  | 'throttled'
  | 'lifetime_limit'
  | 'event_filter'
  | 'missed'
  | 'condition_changed'
  | 'turned_off'
  | 'edited'
  | 'deleted'
  | 'rights_refused'
  | 'step_failed'
  | 'step_threw'
  | 'delivery_expired'
  | 'delivery_replaced'
  | 'delivery_dropped';

/** Every observation names the action and its owner. */
interface ObservedAction {
  actionId: string;
  owner: ActionOwner;
}

export type EngineObservation = ObservedAction & (
  | { type: 'trigger'; trigger: ActionRunTrigger['kind']; event?: ActionEventKind; delayed?: boolean }
  | { type: 'wait'; what: 'started' | 'restarted' | 'cancelled' | 'fired' | 'dropped'; event?: ActionEventKind }
  | { type: 'overlap'; what: 'skipped' | 'queued'; trigger: ActionRunTrigger['kind'] }
  | { type: 'limit'; what: 'chain' | 'self' | 'hourly'; chainDepth: number }
  | { type: 'catch_up'; missed: number; rule: MissedRunRule }
  | {
    type: 'run';
    outcome: ActionRun['outcome'];
    trigger: ActionRunTrigger['kind'];
    steps: number;
    stepResults: Array<{ kind: ActionStepKind; outcome: ActionStepResult['outcome'] }>;
    chainDepth: number;
    durationMs: number;
    reason?: string;
    reasonCode?: RunReasonCode;
  }
);

/** An observation without the fields every one carries, filled in from the action. */
type WithoutAction<O> = O extends unknown ? Omit<O, keyof ObservedAction> : never;
type ObservationBody = WithoutAction<EngineObservation>;

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
  device?: NonNullable<ActionRunTrigger['device']>;
  projectId?: string;
  branch?: string;
  /** For the history line: "release-lead goes to sleep". */
  subject: string;
  actionIds?: string[];
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

interface EventBatch {
  actionId: string;
  device?: NonNullable<ActionRunTrigger['device']>;
  startedAt: number;
  dueAt: number;
  /** Keep each member's causes so revoking its read access also removes its causes. */
  members: Map<string, { event: ActionRunEvent; causes: Set<string> }>;
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
  /** Live-only fixed windows. Ordinary events are never replayed after relaunch. */
  private turnBatches = new Map<string, EventBatch>();
  private idCounter = 0;

  constructor(private readonly deps: EngineDeps) {}

  private now(): number { return this.deps.clock.now(); }

  /** Tell the observer (telemetry). It never affects a run. */
  private observe(action: Action, body: ObservationBody): void {
    const observe = this.deps.hooks?.observe;
    if (!observe) return;
    try {
      observe({ ...body, actionId: action.id, owner: action.owner } as EngineObservation);
    } catch {
      // telemetry-exempt: an observer can't break the engine
    }
  }

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
    this.state = {
      ...loaded.state, nextAt: { ...loaded.state.nextAt }, waits: [...loaded.state.waits],
      ...(loaded.state.lastFiredDate && { lastFiredDate: { ...loaded.state.lastFiredDate } }),
      ...(loaded.state.throttleStarts && { throttleStarts: Object.fromEntries(Object.entries(loaded.state.throttleStarts).map(([id, times]) => [id, [...times]])) }),
    };
    const dates = this.state.lastFiredDate;
    for (const id of Object.keys(dates ?? {})) {
      if (dates && !this.actions.has(id)) delete dates[id];
    }
    for (const id of Object.keys(this.state.throttleStarts ?? {})) {
      if (!this.actions.has(id)) delete this.state.throttleStarts![id];
    }
    // Waits for actions that are gone or off are dropped.
    this.state.waits = this.state.waits.filter((w) => this.actions.get(w.actionId)?.enabled);
    for (const id of Object.keys(this.state.nextAt)) {
      const a = this.actions.get(id);
      if (!a || a.trigger.kind !== 'schedule' || !a.enabled) delete this.state.nextAt[id];
    }
    for (const a of this.actions.values()) {
      if (a.enabled && this.enforceLifetime(a)) continue;
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
    this.turnBatches.clear();
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

  canWatchAgentActivity(reader: ActionOwner): boolean {
    return this.deps.rights.checkSource(reader, { kind: 'event', event: 'agent.turn_ended', source: { kind: 'any' } }) === null;
  }

  canReadDevices(reader: ActionOwner): boolean {
    return this.deps.rights.checkSource(reader, { kind: 'event', event: 'device.online', source: { kind: 'device' } }) === null;
  }

  history(id?: string, reader?: ActionOwner): ActionRun[] {
    const runs = this.deps.history.list(id);
    if (!reader) return runs;
    return runs.flatMap((run) => {
      if (run.trigger.sourceAgentId && this.deps.rights.checkSource(reader, {
        kind: 'event', event: 'agent.quick_finished', source: { kind: 'agent', agentId: run.trigger.sourceAgentId },
      })) return [];
      if (run.trigger.device !== undefined && !this.canReadDevices(reader)) return [];
      if (run.trigger.events !== undefined) {
        const events = run.trigger.events.filter((event) => this.readableEvent(reader, event));
        if (!events.length) return [];
        if (events.length === run.trigger.events.length) return [run];
        const { reason: _reason, ...rest } = run;
        const steps = run.steps.filter((step) => !step.agentId || this.readableEvent(reader, {
          at: run.startedAt, event: 'agent.turn_ended', source: { kind: 'agent', agentId: step.agentId }, detail: '',
        }));
        return [{ ...rest, steps, chain: [], trigger: { ...run.trigger, at: run.startedAt, events, detail: this.eventDetail(events) } }];
      }
      if (run.trigger.agentIds === undefined) return [run];
      if (!this.canWatchAgentActivity(reader)) return [];
      const canRead = (agentId: string) => this.deps.facts.agentExists(agentId)
        && !this.deps.rights.checkSource(reader, { kind: 'event', event: 'agent.turn_ended', source: { kind: 'agent', agentId } });
      const agentIds = run.trigger.agentIds.filter(canRead);
      if (!agentIds.length) return [];
      const partial = agentIds.length !== run.trigger.agentIds.length;
      const steps = partial ? run.steps.filter((step) => !step.agentId || canRead(step.agentId)) : run.steps;
      const { reason, ...rest } = run;
      return [{
        ...rest, steps, chain: partial ? [] : run.chain,
        ...(steps.length === run.steps.length && reason !== undefined && { reason }),
        trigger: {
          ...run.trigger, agentIds, ...(partial && { at: run.startedAt }),
          detail: this.turnDetail(agentIds, run.trigger.detail?.startsWith('Failed turns:'), run.trigger.detail?.startsWith('Finished quick runs:')),
        },
      }];
    });
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

  lastUse(): number | undefined { return this.state.lastUse; }

  recordUse(at: number): void {
    this.state.lastUse = at;
    this.saveState();
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

  create(input: unknown, owner: ActionOwner, opts: { subscription?: boolean } = {}): Action {
    const valid = assertActionInput(input, this.now());
    this.checkRights(owner, valid.trigger, valid.steps);
    this.checkTargets(valid.trigger, valid.steps);
    this.checkCount(owner);
    if (opts.subscription && !isSubscriptionShape(valid, this.subscriberOf(owner))) {
      throw new ActionError('invalid_input', 'A subscription waits for an event and messages its owner.');
    }
    const now = this.now();
    const action: Action = {
      id: this.newId('act'),
      name: valid.name ?? suggestActionName(valid, this.names()),
      trigger: valid.trigger,
      steps: valid.steps,
      overlap: valid.overlap,
      owner,
      enabled: valid.enabled,
      ...(valid.endsAt !== undefined && { endsAt: valid.endsAt }),
      ...(valid.maxRuns !== undefined && { maxRuns: valid.maxRuns }),
      ...(opts.subscription && { subscription: true as const }),
      createdAt: now,
      updatedAt: now,
    };
    this.actions.set(action.id, action);
    if (action.enabled && action.trigger.kind === 'schedule') this.armSchedule(action);
    this.persist();
    return action;
  }

  /**
   * Who an owner's subscriptions tell (#3042): an agent tells itself; the
   * Dispatcher, and Clubhouse's own upkeep (#3040), tell the Dispatcher. A
   * person has no inbox, so people use a notify step instead.
   */
  subscriberOf(owner: ActionOwner): string | undefined {
    if (owner.kind === 'agent') return owner.agentId;
    if (owner.kind === 'dispatcher' || owner.kind === 'app') return this.deps.facts.dispatcherAgentId?.();
    return undefined;
  }

  /**
   * Create a subscription (#3042): the owner is told when the event in
   * `trigger` happens, with its note. It is an ordinary action with one
   * message step to the owner, checked and counted like any other. Several
   * events in a row each tell the owner: runs queue, never skip.
   */
  subscribe(input: unknown, owner: ActionOwner): Action {
    const raw = (typeof input === 'object' && input !== null ? input : {}) as { trigger?: unknown; note?: unknown; name?: unknown; enabled?: unknown };
    const recipient = this.subscriberOf(owner);
    if (!recipient) throw new ActionError('not_allowed', 'Only agents and the Dispatcher can subscribe. Use a notify step to be told yourself.');
    const trigger = validateTrigger(raw.trigger);
    if (!trigger.ok) throw new ActionError('invalid_input', trigger.error);
    if (trigger.value.kind !== 'event') throw new ActionError('invalid_input', 'A subscription waits for something to happen, so it needs an event trigger. Use create_action for schedules.');
    if (raw.note !== undefined && raw.note !== null && typeof raw.note !== 'string') throw new ActionError('invalid_input', 'note must be text.');
    const names = this.names();
    const name = typeof raw.name === 'string' && raw.name.trim()
      ? raw.name
      : suggestSubscriptionName(trigger.value, names.agent(recipient) ?? 'you', names);
    return this.create({
      name,
      trigger: trigger.value,
      steps: [subscriptionStep(recipient, raw.note as string | undefined)],
      overlap: 'queue',
      ...(typeof raw.enabled === 'boolean' && { enabled: raw.enabled }),
    }, owner, { subscription: true });
  }

  /** Replace an action's definition. The owner stays; rights are checked against it. */
  update(id: string, input: unknown): Action {
    const current = this.require(id);
    const valid = assertActionInput(input, this.now());
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
      endsAt: valid.endsAt,
      maxRuns: valid.maxRuns,
      enabled: saysEnabled ? valid.enabled : current.enabled,
      updatedAt: this.now(),
    };
    // A subscription stays one while it still waits for an event and tells its owner.
    if (current.subscription && !isSubscriptionShape(next, this.subscriberOf(current.owner))) delete next.subscription;
    // Edited: the old failure and the reason it was turned off no longer apply.
    delete next.problem;
    if (next.enabled) delete next.offReason;
    this.actions.set(id, next);
    if (next.enabled && this.enforceLifetime(next)) return this.require(id);
    this.dropWaits(id);
    this.cancelQueued(id, 'edited', 'The action was edited before this run started');
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
    if (enabled && this.enforceLifetime(next)) return this.require(id);
    if (!enabled) {
      this.dropWaits(id);
      this.cancelQueued(id, 'turned_off', 'The action was turned off before this run started');
      delete this.state.nextAt[id];
    } else if (next.trigger.kind === 'schedule') {
      // Turning it back on doesn't run the times it was off for.
      this.armSchedule(next);
    }
    this.persist();
    return next;
  }

  remove(id: string): void {
    const action = this.require(id);
    this.actions.delete(id);
    if (this.state.lastFiredDate) delete this.state.lastFiredDate[id];
    if (this.state.throttleStarts) delete this.state.throttleStarts[id];
    this.dropWaits(id);
    delete this.state.nextAt[id];
    // A run going now finishes; nothing queued behind it starts. The action is
    // gone, so these are observed as cancelled but not written to history.
    const queue = this.running.get(id);
    for (const q of queue?.splice(0) ?? []) {
      this.observe(action, {
        type: 'run', outcome: 'cancelled', trigger: q.trigger.kind, steps: 0, stepResults: [],
        chainDepth: q.chain.length, durationMs: 0, reasonCode: 'deleted',
      });
    }
    this.persist();
  }

  /** Drop runs waiting behind a running one, recording them as cancelled. */
  private cancelQueued(id: string, reasonCode: RunReasonCode, reason: string): void {
    const queue = this.running.get(id);
    const action = this.actions.get(id);
    if (!queue?.length || !action) return;
    for (const q of queue.splice(0)) this.recordOnly(action, q.trigger, q.chain, 'cancelled', reasonCode, reason);
  }

  /** Run now, as a normal run. Works on an action that is off. Returns the run id. */
  runNow(id: string): string {
    const action = this.require(id);
    this.observe(action, { type: 'trigger', trigger: 'manual' });
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
    this.cancelQueued(action.id, 'turned_off', reason);
    delete this.state.nextAt[action.id];
    this.persist();
    if (action.enabled && action.owner.kind !== 'app') this.deps.hooks?.turnedOff?.(next, reason);
  }

  private lifetimeReason(action: Action): string | null {
    if (action.trigger.kind === 'once') return null;
    if (action.endsAt !== undefined && this.now() >= action.endsAt) return 'Ended at the set time';
    if (action.maxRuns !== undefined && (action.runsUsed ?? 0) >= action.maxRuns) return `Reached its ${action.maxRuns}-run limit`;
    return null;
  }

  private enforceLifetime(action: Action): string | null {
    const reason = this.lifetimeReason(action);
    if (reason) this.turnOff(action, reason);
    return reason;
  }

  private localDate(): string {
    const date = new Date(this.now());
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  private eventFilterReason(action: Action, includeDailyLimit = true): string | null {
    const t = action.trigger;
    if (t.kind !== 'event') return null;
    if (t.afterLocalTime) {
      const [hour, minute] = t.afterLocalTime.split(':').map(Number);
      const now = new Date(this.now());
      if (now.getHours() * 60 + now.getMinutes() < hour * 60 + minute) return `Before ${t.afterLocalTime} local time`;
    }
    const lastDate = this.state.lastFiredDate?.[action.id];
    if (includeDailyLimit && t.oncePerDay && lastDate && this.localDate() <= lastDate) return 'This calendar day or a later one already had a started run';
    return null;
  }

  // ── Persistence ──

  private persist(): void {
    this.deps.storage.saveActions(this.list());
    this.saveState();
    this.deps.hooks?.changed?.();
    if (this.started) this.armTimer();
  }

  private saveState(): void {
    this.deps.storage.saveState({
      ...this.state, nextAt: { ...this.state.nextAt }, waits: [...this.state.waits],
      ...(this.state.lastFiredDate && { lastFiredDate: { ...this.state.lastFiredDate } }),
      ...(this.state.throttleStarts && { throttleStarts: Object.fromEntries(Object.entries(this.state.throttleStarts).map(([id, times]) => [id, [...times]])) }),
    });
  }

  // ── Clock ──

  private armSchedule(action: Action): void {
    if (action.trigger.kind !== 'schedule' || !this.actions.get(action.id)?.enabled) return;
    const parsed = parseCron(action.trigger.cron);
    const next = parsed.ok ? nextCronTime(parsed.spec, this.now()) : null;
    if (next && (action.endsAt === undefined || next.getTime() < action.endsAt)) this.state.nextAt[action.id] = next.getTime();
    else delete this.state.nextAt[action.id];
  }

  private armTimer(): void {
    if (this.timer !== null) this.deps.clock.clearTimeout(this.timer);
    this.timer = null;
    let earliest = Infinity;
    for (const a of this.actions.values()) {
      if (!a.enabled) continue;
      if (a.endsAt !== undefined) earliest = Math.min(earliest, a.endsAt);
      if (a.trigger.kind === 'once') earliest = Math.min(earliest, a.trigger.at);
      const at = this.state.nextAt[a.id];
      if (at !== undefined) earliest = Math.min(earliest, at);
    }
    for (const w of this.state.waits) earliest = Math.min(earliest, w.dueAt);
    for (const batch of this.turnBatches.values()) earliest = Math.min(earliest, batch.dueAt);
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
      if (this.enforceLifetime(action)) continue;
      const t = action.trigger;
      if (t.kind === 'once' && t.at <= now) {
        // One-time actions delete themselves as they fire; the run stays in history.
        this.actions.delete(action.id);
        if (this.state.lastFiredDate) delete this.state.lastFiredDate[action.id];
        this.dropWaits(action.id);
        this.observe(action, { type: 'trigger', trigger: 'once' });
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
    for (const [id, batch] of this.turnBatches) {
      if (batch.dueAt <= now) this.finishTurnBatch(id, batch);
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
      this.observe(action, { type: 'trigger', trigger: 'schedule' });
      this.fire(action, { kind: 'schedule', at: due }, []);
      return;
    }
    // Missed while the app was closed or the machine slept.
    const parsed = parseCron(action.trigger.cron);
    // The most recent missed times, newest last: "once" runs the latest, "each" the last 10.
    const missed = parsed.ok ? latestMissedTimes(parsed.spec, due, now, MAX_MISSED_RUNS) : [due];
    const rule = action.trigger.missed;
    this.observe(action, { type: 'catch_up', missed: missed.length, rule });
    if (rule === 'skip') {
      const n = missed.length;
      this.recordOnly(action, { kind: 'catch_up', at: missed[missed.length - 1] ?? due }, [], 'skipped', 'missed',
        `Skipped ${n === 1 ? 'a scheduled time' : `${n >= MAX_MISSED_RUNS ? `${MAX_MISSED_RUNS} or more` : n} scheduled times`} missed while Clubhouse was closed or asleep`);
      return;
    }
    const times = rule === 'once' ? missed.slice(-1) : missed;
    for (const at of times) {
      this.observe(action, { type: 'trigger', trigger: 'catch_up' });
      this.fire(action, { kind: 'catch_up', at, detail: 'Missed while Clubhouse was closed or asleep' }, [], { forceQueue: true });
    }
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
        if (occ.actionIds && !occ.actionIds.includes(action.id)) continue;
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
      case 'agent.quick_finished':
        return f.agentExists(event.agentId) ? [agentOcc('agent.quick_finished', event.agentId, event.name)] : [];
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
      case 'device.online':
      case 'device.offline':
        return [{ kind: event.type, device: event.device, subject: event.device.name }];
      case 'app.returned':
        return [{ kind: 'app.returned', subject: 'Clubhouse', actionIds: event.actionIds }];
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
    if (src.kind === 'device') return !!occ.device
      && (!src.deviceId || src.deviceId.toLowerCase() === occ.device.id.toLowerCase())
      && (!src.deviceKind || src.deviceKind === occ.device.kind);
    if (src.kind === 'app') return true;
    if (src.kind === 'any') return !!occ.agentId;
    if (src.kind === 'agent') return occ.agentId === src.agentId;
    return occ.projectId === src.projectId;
  }

  private onMatch(action: Action, trigger: EventTrigger, occ: Occurrence, chain: string[]): void {
    if (occ.agentId && this.deps.facts.isQuickAgent?.(occ.agentId) && !this.canReadAgent(action.owner, occ.agentId)) return;
    // A refused device watch must not reveal activity through skipped runs or pending waits.
    if (trigger.source.kind === 'device' && this.deps.rights.checkSource(action.owner, trigger)) return;
    if (this.enforceLifetime(action)) return;
    if (this.eventFilterReason(action, !trigger.throttle)) return;
    if (trigger.source.kind === 'any' || trigger.coalesceSeconds !== undefined) {
      this.collectTurn(action, trigger, occ, chain);
      return;
    }
    const branchText = occ.branch === '*' ? 'many branches' : occ.branch;
    const detail = `${occ.subject} ${eventPhrase(occ.kind)}${branchText ? ` (${branchText})` : ''}`;
    const delayMs = trigger.delaySeconds !== undefined ? trigger.delaySeconds * 1000 : (trigger.delayMinutes ?? 0) * 60_000;
    this.observe(action, { type: 'trigger', trigger: 'event', event: trigger.event, delayed: delayMs > 0 });
    if (!delayMs) {
      this.fire(action, { kind: 'event', at: this.now(), detail,
        ...(occ.agentId && this.deps.facts.isQuickAgent?.(occ.agentId) && { sourceAgentId: occ.agentId }),
        ...(occ.device && { device: occ.device }),
      }, chain);
      return;
    }
    const now = this.now();
    const existing = this.state.waits.find((w) => w.actionId === action.id && w.agentId === occ.agentId && w.device?.id === occ.device?.id);
    const wait: PersistedWait = {
      actionId: action.id,
      ...(occ.agentId && { agentId: occ.agentId }),
      ...(occ.agentId && this.deps.facts.isQuickAgent?.(occ.agentId) && { sourceAgentId: occ.agentId }),
      ...(occ.device && { device: occ.device }),
      startedAt: now,
      dueAt: now + delayMs,
      chain,
      detail,
    };
    this.state.waits = this.state.waits.filter((w) => w !== existing);
    this.state.waits.push(wait);
    this.observe(action, { type: 'wait', what: existing ? 'restarted' : 'started', event: trigger.event });
    this.saveState();
    this.armTimer();
  }

  private readableTurnAgent(action: Action, agentId: string): boolean {
    const facts = this.deps.facts;
    if (!facts.agentExists(agentId) || agentId === this.subscriberOf(action.owner)) return false;
    if (agentId === facts.dispatcherAgentId?.() || facts.isDispatcherOwnedAgent?.(agentId)) return false;
    return this.canReadAgent(action.owner, agentId);
  }

  private canReadAgent(owner: ActionOwner, agentId: string): boolean {
    return this.deps.rights.checkSource(owner, {
      kind: 'event', event: 'agent.turn_ended', source: { kind: 'agent', agentId },
    }) === null;
  }

  private turnDetail(agentIds: string[], failed = false, quick = false): string {
    const names = agentIds.slice(0, 20).map((id) => this.agentSubject(id).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').trim().slice(0, 80));
    const more = agentIds.length > names.length ? ` and ${agentIds.length - names.length} more agents` : '';
    const what = quick ? 'Finished quick runs' : failed ? 'Failed turns' : 'Finished turns';
    return `${what}: ${names.join(', ')}${more}`;
  }

  private eventDetail(events: ActionRunEvent[]): string {
    const details = events.slice(0, 20).map((event) => event.detail.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').trim().slice(0, 80));
    return `Events: ${details.join('; ')}${events.length > details.length ? ` and ${events.length - details.length} more events` : ''}`;
  }

  private readableEvent(owner: ActionOwner, event: ActionRunEvent): boolean {
    if (event.source.kind === 'agent' && event.event !== 'agent.deleted' && !this.deps.facts.agentExists(event.source.agentId)) return false;
    return this.deps.rights.checkSource(owner, { kind: 'event', event: event.event, source: event.source }) === null;
  }

  /** Rebuild details from current rights, including after a queued handoff or an async step. */
  private readableTurnTrigger(action: Action, trigger: ActionRunTrigger): ActionRunTrigger | null {
    if (trigger.sourceAgentId && !this.canReadAgent(action.owner, trigger.sourceAgentId)) return null;
    if (action.trigger.kind === 'event' && action.trigger.source.kind === 'device'
      && this.deps.rights.checkSource(action.owner, action.trigger)) return null;
    if (trigger.events !== undefined) {
      if (this.deps.rights.checkSource(action.owner, action.trigger)) return null;
      const events = trigger.events.filter((event) => this.readableEvent(action.owner, event));
      return events.length ? { ...trigger, events, detail: this.eventDetail(events) } : null;
    }
    if (trigger.kind !== 'event' || action.trigger.kind !== 'event' || action.trigger.source.kind !== 'any') return trigger;
    if (this.deps.rights.checkSource(action.owner, action.trigger)) return null;
    const agentIds = (trigger.agentIds ?? []).filter((id) => this.readableTurnAgent(action, id));
    return agentIds.length ? { ...trigger, agentIds, detail: this.turnDetail(agentIds, action.trigger.event === 'agent.turn_failed', action.trigger.event === 'agent.quick_finished') } : null;
  }

  private collectTurn(action: Action, trigger: EventTrigger, occ: Occurrence, chain: string[]): void {
    const batchKey = JSON.stringify([action.id, occ.device?.id ?? null]);
    const pending = this.turnBatches.get(batchKey);
    if (pending && pending.dueAt <= this.now()) {
      this.finishTurnBatch(batchKey, pending);
      action = this.actions.get(action.id) ?? action;
      if (!action.enabled || this.enforceLifetime(action) || this.eventFilterReason(action, !trigger.throttle)) return;
    }
    const refused = this.deps.rights.checkSource(action.owner, trigger);
    // Without the activity grant, even a per-turn skipped history entry would reveal activity.
    if (refused) return;
    const anyAgent = trigger.source.kind === 'any';
    const branchText = occ.branch === '*' ? 'many branches' : occ.branch;
    const event: ActionRunEvent = {
      at: this.now(), event: occ.kind,
      source: occ.device ? { kind: 'device', deviceId: occ.device.id, deviceKind: occ.device.kind }
        : occ.agentId ? { kind: 'agent', agentId: occ.agentId }
        : occ.projectId ? { kind: 'project', projectId: occ.projectId } : { kind: 'app' },
      detail: `${occ.subject} ${eventPhrase(occ.kind)}${branchText ? ` (${branchText})` : ''}`,
      ...(occ.device && { device: occ.device }),
    };
    if (anyAgent ? !occ.agentId || !this.readableTurnAgent(action, occ.agentId) : !this.readableEvent(action.owner, event)) return;
    if (chain.includes(action.id) || chain.length >= MAX_CHAIN_DEPTH) {
      this.fire(action, {
        kind: 'event', at: this.now(), ...(occ.device && { device: occ.device }),
        ...(anyAgent ? { agentIds: [occ.agentId!] } : { events: [event] }),
      }, chain);
      return;
    }
    let batch = this.turnBatches.get(batchKey);
    if (!batch) {
      batch = {
        actionId: action.id, ...(occ.device && { device: occ.device }),
        startedAt: this.now(), dueAt: this.now() + (trigger.coalesceSeconds ?? DEFAULT_COALESCE_SECONDS) * 1000, members: new Map(),
      };
      this.turnBatches.set(batchKey, batch);
    }
    const key = anyAgent ? occ.agentId! : String(batch.members.size);
    const causes = batch.members.get(key)?.causes ?? new Set<string>();
    for (const id of chain) {
      if (causes.size >= MAX_CHAIN_DEPTH) break;
      causes.add(id);
    }
    batch.members.set(key, { event, causes });
    this.observe(action, { type: 'trigger', trigger: 'event', event: trigger.event, delayed: true });
    this.armTimer();
  }

  private finishTurnBatch(id: string, batch: EventBatch): void {
    this.turnBatches.delete(id);
    const action = this.actions.get(batch.actionId);
    if (!action?.enabled || action.trigger.kind !== 'event') return;
    const anyAgent = action.trigger.source.kind === 'any';
    const members = [...batch.members.values()].filter(({ event }) => anyAgent
      ? event.source.kind === 'agent' && this.readableTurnAgent(action, event.source.agentId)
      : this.readableEvent(action.owner, event));
    const chain = [...new Set(members.flatMap((member) => [...member.causes]))];
    this.fire(action, {
      kind: 'event', at: batch.startedAt,
      ...(batch.device && { device: batch.device }),
      ...(anyAgent ? { agentIds: members.flatMap(({ event }) => event.source.kind === 'agent' ? [event.source.agentId] : []) }
        : { events: members.map((member) => member.event) }),
    }, chain);
  }

  /** Whether a delayed trigger's condition still holds when its wait ends. */
  private conditionHolds(action: Action, wait: PersistedWait): boolean {
    if (action.trigger.kind !== 'event') return false;
    const f = this.deps.facts;
    const agentId = wait.agentId;
    switch (action.trigger.event) {
      case 'device.online': return !!wait.device && f.deviceOnline?.(wait.device.id) === true;
      case 'device.offline': return !!wait.device && f.deviceOnline?.(wait.device.id) === false;
      case 'agent.slept': return !!agentId && !f.isRunning(agentId);
      case 'agent.woke': return !!agentId && f.isRunning(agentId);
      case 'agent.idle': return !!agentId && (this.lastTurnStart.get(agentId) ?? 0) <= wait.startedAt;
      case 'agent.created': return !!agentId && f.agentExists(agentId);
      case 'agent.deleted': return !!agentId && !f.agentExists(agentId);
      default: return true;
    }
  }

  private finishWait(wait: PersistedWait, atLaunch = false): void {
    if (wait.device && this.deps.facts.deviceOnline?.(wait.device.id) === undefined) {
      // Local sleep or reconnect is not evidence that the remote condition changed.
      wait.dueAt = this.now() + MAX_TIMER_MS;
      return;
    }
    this.state.waits = this.state.waits.filter((w) => w !== wait);
    const action = this.actions.get(wait.actionId);
    if (!action?.enabled) return;
    const trigger: ActionRunTrigger = { kind: 'event', at: wait.startedAt, detail: wait.detail,
      ...(wait.sourceAgentId && { sourceAgentId: wait.sourceAgentId }),
      ...(wait.device && { device: wait.device }),
    };
    if (!this.conditionHolds(action, wait)) {
      if (atLaunch) {
        this.observe(action, { type: 'wait', what: 'dropped', ...(action.trigger.kind === 'event' && { event: action.trigger.event }) });
        return;
      }
      this.observe(action, { type: 'wait', what: 'cancelled', ...(action.trigger.kind === 'event' && { event: action.trigger.event }) });
      this.recordOnly(action, trigger, wait.chain, 'cancelled', 'condition_changed',
        'What set it off no longer held when the wait ended');
      return;
    }
    this.observe(action, { type: 'wait', what: 'fired', ...(action.trigger.kind === 'event' && { event: action.trigger.event }) });
    this.fire(action, trigger, wait.chain);
  }

  /** On launch: waits that ended while the app was closed run once if they still hold, else are dropped. */
  private restoreWaits(): void {
    const now = this.now();
    for (const wait of [...this.state.waits]) {
      if (wait.dueAt <= now) this.finishWait(wait, true);
    }
  }

  private dropWaits(actionId: string): void {
    for (const [key, batch] of this.turnBatches) {
      if (batch.actionId === actionId) this.turnBatches.delete(key);
    }
    this.dropWaitsWhere((w) => w.actionId === actionId, false);
  }

  private dropWaitsWhere(pred: (w: PersistedWait) => boolean, observe: boolean): void {
    const before = this.state.waits.length;
    const kept = this.state.waits.filter((w) => {
      if (!pred(w)) return true;
      const action = observe ? this.actions.get(w.actionId) : undefined;
      if (action) this.observe(action, { type: 'wait', what: 'cancelled', ...(action.trigger.kind === 'event' && { event: action.trigger.event }) });
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

  private recordOnly(action: Action, trigger: ActionRunTrigger, chain: string[], outcome: 'skipped' | 'cancelled' | 'throttled', reasonCode: RunReasonCode, reason: string): string {
    trigger = this.readableTurnTrigger(action, trigger) ?? this.redactedTrigger(trigger);
    const now = this.now();
    const run: ActionRun = { id: this.newId('run'), actionId: action.id, owner: action.owner, trigger, chain, startedAt: now, endedAt: now, outcome, reason, steps: [] };
    if (action.owner.kind !== 'app') this.deps.history.put(run);
    this.observe(action, { type: 'run', outcome, trigger: trigger.kind, steps: 0, stepResults: [], chainDepth: chain.length, durationMs: 0, reason, reasonCode });
    this.deps.hooks?.changed?.();
    return run.id;
  }

  private underHourlyLimit(actionId: string): boolean {
    const now = this.now();
    const starts = (this.recentStarts.get(actionId) ?? []).filter((t) => now - t < HOUR_MS);
    this.recentStarts.set(actionId, starts);
    return starts.length < MAX_RUNS_PER_HOUR;
  }

  private redactedTrigger(trigger: ActionRunTrigger): ActionRunTrigger {
    return {
      kind: trigger.kind, at: trigger.at,
      ...(trigger.device !== undefined && { device: null }),
      ...(trigger.events !== undefined ? { events: [] } : trigger.device === undefined ? { agentIds: [] } : {}),
    };
  }

  private throttleReason(action: Action): string | null {
    if (action.trigger.kind !== 'event' || !action.trigger.throttle) return null;
    const { maxRuns, perMinutes } = action.trigger.throttle;
    const starts = this.state.throttleStarts ??= {};
    starts[action.id] = (starts[action.id] ?? []).filter((at) => this.now() - at < perMinutes * 60_000);
    return starts[action.id].length >= maxRuns ? `Throttled: started ${maxRuns} runs in the last ${perMinutes} minutes` : null;
  }

  /** Start a run, or skip or queue it. Returns the run id. */
  private fire(action: Action, trigger: ActionRunTrigger, chain: string[], opts: { forceQueue?: boolean } = {}): string {
    if (action.trigger.kind === 'event' && action.trigger.source.kind === 'device' && trigger.device === undefined) {
      trigger = { ...trigger, device: null };
    }
    action = this.actions.get(action.id) ?? action;
    const readable = this.readableTurnTrigger(action, trigger);
    if (!readable) return this.recordOnly(action, this.redactedTrigger(trigger), [], 'skipped', 'rights_refused', 'The source permission or read access is no longer available');
    trigger = readable;
    if (chain.includes(action.id)) {
      this.observe(action, { type: 'limit', what: 'self', chainDepth: chain.length });
      return this.recordOnly(action, trigger, chain, 'skipped', 'self_trigger', 'It can’t set itself off');
    }
    if (chain.length >= MAX_CHAIN_DEPTH) {
      this.observe(action, { type: 'limit', what: 'chain', chainDepth: chain.length });
      return this.recordOnly(action, trigger, chain, 'skipped', 'chain_limit', `Stopped a chain of ${MAX_CHAIN_DEPTH} actions setting each other off`);
    }
    const throttled = this.throttleReason(action);
    if (throttled) return this.recordOnly(action, trigger, chain, 'throttled', 'throttled', throttled);
    const ended = this.enforceLifetime(action);
    if (ended) return this.recordOnly(action, trigger, chain, 'skipped', 'lifetime_limit', ended);
    const filtered = this.eventFilterReason(action);
    if (filtered) return this.recordOnly(action, trigger, chain, 'skipped', 'event_filter', filtered);
    const runId = this.newId('run');
    const queue = this.running.get(action.id);
    if (queue) {
      if ((action.overlap === 'queue' || opts.forceQueue) && queue.length < MAX_QUEUED_RUNS) {
        queue.push({ trigger, chain, runId });
        this.observe(action, { type: 'overlap', what: 'queued', trigger: trigger.kind });
        return runId;
      }
      this.observe(action, { type: 'overlap', what: 'skipped', trigger: trigger.kind });
      return this.recordOnly(action, trigger, chain, 'skipped', 'overlap', 'The last run was still going');
    }
    if (!this.underHourlyLimit(action.id)) {
      this.observe(action, { type: 'limit', what: 'hourly', chainDepth: chain.length });
      return this.recordOnly(action, trigger, chain, 'skipped', 'hourly_limit', `Ran ${MAX_RUNS_PER_HOUR} times in the last hour`);
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
    action = this.actions.get(actionId) ?? action;
    const readable = this.readableTurnTrigger(action, trigger);
    if (!readable) {
      const reason = 'The source permission or read access is no longer available';
      this.recordOnly(action, this.redactedTrigger(trigger), [], 'cancelled', 'rights_refused', reason);
      return this.nextQueued(actionId);
    }
    trigger = readable;
    if (action.trigger.kind !== 'once' && this.actions.has(actionId)) {
      // A queued handoff crosses an await: edits and expiry can happen before it starts.
      action = this.require(actionId);
      const throttled = this.throttleReason(action);
      if (throttled) {
        this.recordOnly(action, trigger, chain, 'throttled', 'throttled', throttled);
        return this.nextQueued(actionId);
      }
      const ended = this.enforceLifetime(action);
      if (ended) {
        this.recordOnly(action, trigger, chain, 'cancelled', 'lifetime_limit', ended);
        return null;
      }
      const filtered = this.eventFilterReason(action);
      if (filtered) {
        this.recordOnly(action, trigger, chain, 'cancelled', 'event_filter', filtered);
        this.cancelQueued(actionId, 'event_filter', filtered);
        return null;
      }
      if (action.trigger.kind === 'event') {
        const date = this.localDate();
        const dates = this.state.lastFiredDate ??= {};
        if (!dates[actionId] || date > dates[actionId]) dates[actionId] = date;
        if (action.trigger.throttle) (this.state.throttleStarts![actionId] ??= []).push(this.now());
      }
      action = { ...action, runsUsed: (action.runsUsed ?? 0) + 1 };
      this.actions.set(actionId, action);
      if (!this.enforceLifetime(action)) this.persist();
    }
    const starts = this.recentStarts.get(actionId) ?? [];
    starts.push(this.now());
    this.recentStarts.set(actionId, starts);
    const hidden = action.owner.kind === 'app';
    const run: ActionRun = { id: runId, actionId, owner: action.owner, trigger, chain, startedAt: this.now(), outcome: 'running', steps: [] };
    if (!hidden) this.deps.history.put(run);
    this.deps.hooks?.changed?.();

    let failure: string | undefined;
    let failureCode: RunReasonCode | undefined;
    let deliveryLoss: { outcome: 'expired' | 'cancelled'; reason: string; code: RunReasonCode } | undefined;
    // What it watches is checked again on every run too: a mechanical failure, like a step.
    const sourceRefused = this.deps.rights.checkSource(action.owner, action.trigger);
    if (sourceRefused) {
      failure = `Couldn’t run: ${sourceRefused}`;
      failureCode = 'rights_refused';
    }
    for (const step of sourceRefused ? [] : action.steps) {
      const currentTrigger = this.readableTurnTrigger(action, trigger);
      if (!currentTrigger) {
        run.trigger = this.redactedTrigger(trigger);
        failure = 'The source permission or read access is no longer available';
        failureCode = 'rights_refused';
        break;
      }
      trigger = currentTrigger;
      run.trigger = trigger;
      // Rights are checked again on every run: what was allowed may not be now.
      const refused = this.deps.rights.checkStep(action.owner, step);
      if (refused) {
        failure = `Couldn’t run: ${refused}`;
        failureCode = 'rights_refused';
        run.steps.push({ kind: step.kind, outcome: 'failed', detail: refused });
        break;
      }
      let result: ActionStepResult;
      let threw = false;
      const stepIndex = run.steps.length;
      let settlement: ActionQueueSettlement | undefined;
      const deliveryChanged = (delivery: ActionQueueSettlement) => {
        settlement = delivery;
        const receipt = run.steps[stepIndex];
        if (!receipt) return;
        receipt.delivery = delivery;
        receipt.detail = delivery === 'delivered' ? 'Delivered the queued message'
          : delivery === 'expired' ? 'Queued message expired before delivery'
            : delivery === 'replaced' ? 'Queued message replaced by a newer message from this action'
              : 'Queued message dropped before delivery';
        run.deliveryUpdatedAt = this.now();
        if (delivery !== 'delivered') {
          deliveryLoss = deliveryLoss?.outcome === 'expired' ? deliveryLoss : {
            outcome: delivery === 'expired' ? 'expired' : 'cancelled',
            reason: receipt.detail,
            code: delivery === 'expired' ? 'delivery_expired' : delivery === 'replaced' ? 'delivery_replaced' : 'delivery_dropped',
          };
          if (run.outcome !== 'running' && run.outcome !== 'failed') {
            run.outcome = deliveryLoss.outcome;
            run.reason = deliveryLoss.reason;
            this.observe(action, {
              type: 'run', outcome: run.outcome, trigger: trigger.kind, steps: run.steps.length,
              stepResults: run.steps.map((s) => ({ kind: s.kind, outcome: s.outcome })),
              chainDepth: chain.length, durationMs: this.now() - run.startedAt, reasonCode: deliveryLoss.code,
            });
          }
        }
        if (!hidden) this.deps.history.put({ ...run, steps: [...run.steps] });
        this.deps.hooks?.changed?.();
      };
      try {
        result = await this.deps.steps.run(step, { action, runId, chain: [...chain, actionId], trigger, deliveryChanged });
      } catch (err) {
        // telemetry-exempt: recorded on the run and reported as a mechanical failure below
        threw = true;
        result = { kind: step.kind, outcome: 'failed', detail: err instanceof Error ? err.message : String(err) };
      }
      run.steps.push(result);
      if (settlement) deliveryChanged(settlement);
      if (!hidden) this.deps.history.put({ ...run, steps: [...run.steps] });
      if (result.outcome === 'failed') {
        failure = result.detail;
        failureCode = threw ? 'step_threw' : 'step_failed';
        break;
      }
    }

    run.endedAt = this.now();
    run.outcome = failure ? 'failed' : deliveryLoss?.outcome ?? 'done';
    if (failure) run.reason = failure;
    else if (deliveryLoss) run.reason = deliveryLoss.reason;
    if (!hidden) this.deps.history.put({ ...run, steps: [...run.steps] });
    this.observe(action, {
      type: 'run',
      outcome: run.outcome,
      trigger: trigger.kind,
      steps: run.steps.length,
      stepResults: run.steps.map((s) => ({ kind: s.kind, outcome: s.outcome })),
      chainDepth: chain.length,
      durationMs: run.endedAt - run.startedAt,
      ...(failure && { reason: failure }),
      ...((failureCode ?? deliveryLoss?.code) && { reasonCode: failureCode ?? deliveryLoss?.code }),
    });

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

    return this.nextQueued(actionId);
  }

  private nextQueued(actionId: string): { action: Action; run: QueuedRun } | null {
    const queue = this.running.get(actionId);
    const nextRun = queue?.shift();
    const latest = this.actions.get(actionId);
    if (!nextRun || !latest) return null;
    const throttled = this.throttleReason(latest);
    if (throttled) {
      this.recordOnly(latest, nextRun.trigger, nextRun.chain, 'throttled', 'throttled', throttled);
      return this.nextQueued(actionId);
    }
    const ended = this.enforceLifetime(latest);
    if (ended) {
      this.recordOnly(latest, nextRun.trigger, nextRun.chain, 'cancelled', 'lifetime_limit', ended);
      return null;
    }
    if (!latest.enabled && nextRun.trigger.kind !== 'manual') {
      this.recordOnly(latest, nextRun.trigger, nextRun.chain, 'cancelled', 'turned_off', 'The action was turned off before this run started');
      for (const rest of queue?.splice(0) ?? []) this.recordOnly(latest, rest.trigger, rest.chain, 'cancelled', 'turned_off', 'The action was turned off before this run started');
      return null;
    }
    if (!this.underHourlyLimit(actionId)) {
      const reason = `Ran ${MAX_RUNS_PER_HOUR} times in the last hour`;
      for (const dropped of [nextRun, ...(queue?.splice(0) ?? [])]) {
        this.observe(latest, { type: 'limit', what: 'hourly', chainDepth: dropped.chain.length });
        this.recordOnly(latest, dropped.trigger, dropped.chain, 'skipped', 'hourly_limit', reason);
      }
      return null;
    }
    return { action: latest, run: nextRun };
  }
}
