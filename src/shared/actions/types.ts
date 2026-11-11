/**
 * Actions (#2918): workflows built into Clubhouse that run on a schedule, when
 * something happens, or once. The model here is shared by the main-process
 * engine, the Settings UI and the Clubhouse MCP tools, which all take and
 * return the same shape.
 */

import type { AccessLevel } from '../agent-access';
import type { HelperDifficulty, HelperRouting } from '../helper-routing';

// ── Triggers ────────────────────────────────────────────────────────────────

/** Schedule presets. `cron` (Custom) is offered for power users and is never the default. */
export type SchedulePreset = 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'cron';

export const SCHEDULE_PRESETS: readonly SchedulePreset[] = ['daily', 'weekdays', 'weekly', 'hourly', 'cron'];

/** What to do with schedule times that passed while the app was closed or the machine slept. */
export type MissedRunRule = 'skip' | 'once' | 'each';

export const MISSED_RUN_RULES: readonly MissedRunRule[] = ['skip', 'once', 'each'];

/** The most missed times `each` runs, matching the Automations plugin. */
export const MAX_MISSED_RUNS = 10;

export interface ScheduleTrigger {
  kind: 'schedule';
  preset: SchedulePreset;
  /**
   * The 5-field cron line every preset is stored as, in local time. Presets
   * derive it (see presetToCron); Custom keeps what the person typed.
   */
  cron: string;
  missed: MissedRunRule;
}

export interface OnceTrigger {
  kind: 'once';
  /** Epoch milliseconds. A time that passed while the app was closed runs at the next launch. */
  at: number;
}

/** Events an action can wait for. Grouped in the form as Agent, Git and App. */
export type ActionEventKind =
  // Agent
  | 'agent.woke'
  | 'agent.slept'
  | 'agent.created'
  | 'agent.deleted'
  | 'agent.turn_ended'
  | 'agent.turn_failed'
  | 'agent.idle'
  | 'agent.waiting'
  | 'agent.error'
  | 'agent.compacted'
  | 'helper.finished'
  // Git
  | 'git.commit'
  | 'git.branch_switched'
  | 'git.remote_updated'
  // App
  | 'app.started'
  | 'app.returned'
  | 'project.added'
  | 'project.removed';

export const AGENT_EVENT_KINDS: readonly ActionEventKind[] = [
  'agent.woke', 'agent.slept', 'agent.created', 'agent.deleted', 'agent.turn_ended', 'agent.turn_failed',
  'agent.idle', 'agent.waiting', 'agent.error', 'agent.compacted', 'helper.finished',
];
export const GIT_EVENT_KINDS: readonly ActionEventKind[] = ['git.commit', 'git.branch_switched', 'git.remote_updated'];
export const APP_EVENT_KINDS: readonly ActionEventKind[] = ['app.started', 'app.returned', 'project.added', 'project.removed'];
export const ACTION_EVENT_KINDS: readonly ActionEventKind[] = [...AGENT_EVENT_KINDS, ...GIT_EVENT_KINDS, ...APP_EVENT_KINDS];
export const TURN_EVENT_KINDS: readonly ActionEventKind[] = ['agent.turn_ended', 'agent.turn_failed'];
export const DEFAULT_COALESCE_SECONDS = 60;
export const MIN_COALESCE_SECONDS = 10;
export const MAX_COALESCE_SECONDS = 600;

/**
 * Where an event comes from: one durable agent, a project, or any readable durable agent. Git events
 * use the project (its root and every agent worktree in it) or one agent's
 * worktree. App events take no source; project events may name one project.
 */
export type ActionEventSource =
  | { kind: 'agent'; agentId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'app' }
  /** Turn events from readable durable agents, excluding the subscriber and Dispatcher-owned agents. */
  | { kind: 'any' };

export interface EventTrigger {
  kind: 'event';
  event: ActionEventKind;
  source: ActionEventSource;
  /**
   * Minutes to wait before running. When the wait ends the condition is
   * checked again, and the run is cancelled if it no longer holds. For
   * `agent.idle` this is the idle time and is required.
   */
  delayMinutes?: number;
  /** Git events only: run only for this branch, e.g. "main". */
  branch?: string;
  /** app.returned only: required absence, default 30 minutes, minimum 5. */
  absenceMinutes?: number;
  /** Events only at or after this wall-clock time on this computer, "HH:MM". */
  afterLocalTime?: string;
  /** At most one started run per local calendar day, including Run now and failures. */
  oncePerDay?: boolean;
  /** Any-agent turn events only: fixed window from the first turn, default 60 seconds. */
  coalesceSeconds?: number;
}

export const DEFAULT_ABSENCE_MINUTES = 30;
export const MIN_ABSENCE_MINUTES = 5;

export type ActionTrigger = ScheduleTrigger | OnceTrigger | EventTrigger;

// ── Steps ───────────────────────────────────────────────────────────────────

export interface WakeStep {
  kind: 'wake';
  agentId: string;
  /** Optional first message. Resumes the agent's last session, as waking by hand does. */
  prompt?: string;
}

export interface MessageStep {
  kind: 'message';
  agentId: string;
  text: string;
}

export interface QuickAgentStep {
  kind: 'quick';
  /** Runs in this project's root… */
  projectId: string;
  /** …or in this agent's worktree, when set. */
  worktreeAgentId?: string;
  prompt: string;
  /** Overrides. Unset keeps the project's provider. "auto" uses helper routing. */
  orchestrator?: string;
  model?: string;
  /** Auto only. Unset means medium. */
  difficulty?: HelperDifficulty;
}

/**
 * The Access level every quick agent an action starts runs at, headless, so a
 * scheduled run never stops at a prompt (#3033). Only people and agents that
 * themselves run at this level may have actions that start them.
 */
export const QUICK_STEP_ACCESS: AccessLevel = 'full_access';

export interface SleepStep {
  kind: 'sleep';
  agentId: string;
}

export interface NotifyStep {
  kind: 'notify';
  text: string;
}

export type ActionStep = WakeStep | MessageStep | QuickAgentStep | SleepStep | NotifyStep;
export type ActionStepKind = ActionStep['kind'];

export const ACTION_STEP_KINDS: readonly ActionStepKind[] = ['wake', 'message', 'quick', 'sleep', 'notify'];
export const MAX_ACTION_STEPS = 3;

// ── Action ──────────────────────────────────────────────────────────────────

/** Who made the action. Usage counts toward the owner. */
export type ActionOwner =
  | { kind: 'user' }
  | { kind: 'dispatcher' }
  | { kind: 'agent'; agentId: string; helper?: boolean }
  /** Clubhouse itself: hidden from every list and from history. */
  | { kind: 'app' };

/** What to do when the trigger fires while this action's last run is still going. */
export type OverlapRule = 'skip' | 'queue';

export interface Action {
  id: string;
  name: string;
  trigger: ActionTrigger;
  /** 1 to 3, run in order, stopping at the first one that couldn't run. */
  steps: ActionStep[];
  overlap: OverlapRule;
  owner: ActionOwner;
  enabled: boolean;
  /** Recurring actions only: stop at this absolute time, in epoch milliseconds. */
  endsAt?: number;
  /** Recurring actions only: stop after this many started runs, including Run now and failures. */
  maxRuns?: number;
  /** Lifetime started-run count, independent of trimmed history. */
  runsUsed?: number;
  /** Why Clubhouse turned it off, shown under its name. Cleared when it is turned back on. */
  offReason?: string;
  /** The last mechanical failure, shown under its name until a run succeeds or it is edited. */
  problem?: string;
  /**
   * A subscription (#3042): its owner asked to be told when something
   * happens. An event trigger and one step that messages the owner. It stays
   * one while an edit keeps that shape; see subscription.ts.
   */
  subscription?: true;
  createdAt: number;
  updatedAt: number;
}

/** What a person, an agent or the Dispatcher sends to create or replace an action. */
export interface ActionInput {
  name?: string;
  trigger: ActionTrigger;
  steps: ActionStep[];
  overlap?: OverlapRule;
  enabled?: boolean;
  endsAt?: number;
  maxRuns?: number;
}

/** A successful Dispatcher MCP change, shown in its conversation without raw tool output. */
export interface ActionChatSummary {
  id: string;
  name: string;
  trigger: string;
  steps: string;
  enabled: boolean;
}

// ── Runs and history ────────────────────────────────────────────────────────

export type ActionRunOutcome = 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';

export interface ActionRunTrigger {
  /** schedule, once, event, catch_up (a missed schedule time), or manual (Run now). */
  kind: 'schedule' | 'once' | 'event' | 'catch_up' | 'manual';
  /** When the trigger fired, epoch ms. For catch_up, the missed time. */
  at: number;
  /** One line in plain words, e.g. "release-lead went to sleep". */
  detail?: string;
  /** Readable agents in a coalesced turn event, rechecked before delivery. Empty when redacted. */
  agentIds?: string[];
}

export interface ActionStepResult {
  kind: ActionStepKind;
  outcome: 'done' | 'failed';
  /** One line in plain words. */
  detail: string;
  /** Message handoff at step completion, not a receipt for later queue delivery. */
  delivery?: 'queued' | 'delivered';
  /** Auto's start receipt, using the same shape as helper starts. */
  routing?: HelperRouting;
  /** The agent it woke, messaged, started or put to sleep, for a link. */
  agentId?: string;
  projectId?: string;
}

export interface ActionRun {
  id: string;
  actionId: string;
  /**
   * Who owned the action when it ran. Kept on the run so its owner can still
   * read it after a one-time action deleted itself. Unset on runs from before.
   */
  owner?: ActionOwner;
  trigger: ActionRunTrigger;
  /** Ids of the actions whose runs led to this one, oldest first. */
  chain: string[];
  startedAt: number;
  endedAt?: number;
  outcome: ActionRunOutcome;
  /** One line of reason for failed, cancelled and skipped runs. */
  reason?: string;
  steps: ActionStepResult[];
}

/** History is for debugging: at most this many runs per action… */
export const HISTORY_MAX_RUNS = 10;
/** …within this window, whichever leaves fewer. */
export const HISTORY_MAX_AGE_MS = 72 * 60 * 60 * 1000;

// ── Limits ──────────────────────────────────────────────────────────────────

/** A run caused by another action carries its chain; a chain stops at this depth. */
export const MAX_CHAIN_DEPTH = 3;
/** One action runs at most this many times an hour. */
export const MAX_RUNS_PER_HOUR = 60;
/** The longest wait an event trigger may ask for (one week). */
export const MAX_DELAY_MINUTES = 7 * 24 * 60;
