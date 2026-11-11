/**
 * Checks for action input from the form, IPC and Clubhouse MCP (#2918). The
 * shape is checked here; whether the agents and projects exist, and whether
 * the owner may do each step, is checked by the engine.
 */

import { parseCron } from './cron';
import { isHelperDifficulty } from '../helper-routing';
import { cronToPresetFields, presetToCron } from './describe';
import {
  ACTION_EVENT_KINDS,
  ACTION_STEP_KINDS,
  APP_EVENT_KINDS,
  GIT_EVENT_KINDS,
  HISTORY_MAX_AGE_MS,
  HISTORY_MAX_RUNS,
  MAX_ACTION_STEPS,
  MAX_DELAY_MINUTES,
  MAX_COALESCE_SECONDS,
  MIN_COALESCE_SECONDS,
  MIN_ABSENCE_MINUTES,
  MISSED_RUN_RULES,
  SCHEDULE_PRESETS,
  TURN_EVENT_KINDS,
  type ActionEventKind,
  type ActionEventSource,
  type ActionRun,
  type ActionStep,
  type ActionTrigger,
  type MissedRunRule,
  type OverlapRule,
  type SchedulePreset,
} from './types';

/** Typed errors, so an agent can explain a refusal. */
export type ActionErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'not_allowed'
  | 'hidden'
  | 'rate_limited'
  /** Actions are still starting, so try again in a moment. */
  | 'unavailable';

export class ActionError extends Error {
  constructor(public readonly code: ActionErrorCode, message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

export const MAX_NAME_LENGTH = 120;
export const MAX_TEXT_LENGTH = 20_000;

type Result<T> = { ok: true; value: T; error?: undefined } | { ok: false; error: string; value?: undefined };

/** Pass a failure on with the caller's result type. */
const fail = (r: { error?: string }): { ok: false; error: string } => ({ ok: false, error: r.error ?? 'Invalid input.' });

/** Ids, branch names, provider and model names. */
export const MAX_ID_LENGTH = 200;
const MAX_CRON_LENGTH = 100;
/** Year 3000: far enough for any real plan, and a finite timer target. */
const MAX_ONCE_AT = Date.UTC(3000, 0, 1);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_ID_LENGTH;

function text(v: unknown, field: string, required: boolean): Result<string | undefined> {
  if (v === undefined || v === null || v === '') {
    return required ? { ok: false, error: `${field} is required.` } : { ok: true, value: undefined };
  }
  if (typeof v !== 'string') return { ok: false, error: `${field} must be text.` };
  if (required && !v.trim()) return { ok: false, error: `${field} is required.` };
  if (v.length > MAX_TEXT_LENGTH) return { ok: false, error: `${field} is longer than ${MAX_TEXT_LENGTH} characters.` };
  return { ok: true, value: v };
}

function validateSource(event: ActionEventKind, raw: unknown): Result<ActionEventSource> {
  if (isObject(raw) && raw.kind === 'any') {
    return TURN_EVENT_KINDS.includes(event)
      ? { ok: true, value: { kind: 'any' } }
      : { ok: false, error: 'Any readable agent is only for finished or failed turns.' };
  }
  if (APP_EVENT_KINDS.includes(event)) {
    if (event.startsWith('project.') && isObject(raw) && raw.kind === 'project' && nonEmpty(raw.projectId)) {
      return { ok: true, value: { kind: 'project', projectId: raw.projectId } };
    }
    return { ok: true, value: { kind: 'app' } };
  }
  if (!isObject(raw)) return { ok: false, error: 'The trigger needs an agent or a project to watch.' };
  if (raw.kind === 'agent' && nonEmpty(raw.agentId)) return { ok: true, value: { kind: 'agent', agentId: raw.agentId } };
  if (raw.kind === 'project' && nonEmpty(raw.projectId)) return { ok: true, value: { kind: 'project', projectId: raw.projectId } };
  return { ok: false, error: 'The trigger needs an agent or a project to watch.' };
}

export function validateTrigger(raw: unknown): Result<ActionTrigger> {
  if (!isObject(raw)) return { ok: false, error: 'A trigger is required.' };
  if (raw.kind === 'schedule') {
    const preset: SchedulePreset = SCHEDULE_PRESETS.includes(raw.preset as never) ? raw.preset as SchedulePreset : 'cron';
    if (typeof raw.cron !== 'string') return { ok: false, error: 'A schedule needs a cron line.' };
    if (raw.cron.length > MAX_CRON_LENGTH) return { ok: false, error: `The schedule line is longer than ${MAX_CRON_LENGTH} characters.` };
    const parsed = parseCron(raw.cron);
    if (!parsed.ok) return fail(parsed);
    const cron = raw.cron.trim().split(/\s+/).join(' ');
    // A preset label must match its line, or the form would show a time the schedule doesn't use.
    const presetCron = preset === 'cron' ? null : presetToCron(preset, cronToPresetFields(preset, cron));
    const missed: MissedRunRule = MISSED_RUN_RULES.includes(raw.missed as never) ? raw.missed as MissedRunRule : 'skip';
    return { ok: true, value: { kind: 'schedule', preset: presetCron === cron ? preset : 'cron', cron, missed } };
  }
  if (raw.kind === 'once') {
    if (typeof raw.at !== 'number' || !Number.isFinite(raw.at) || raw.at <= 0 || raw.at > MAX_ONCE_AT) {
      return { ok: false, error: 'A one-time action needs a date and time.' };
    }
    return { ok: true, value: { kind: 'once', at: Math.floor(raw.at) } };
  }
  if (raw.kind === 'event') {
    if (!ACTION_EVENT_KINDS.includes(raw.event as never)) return { ok: false, error: 'Pick what should happen.' };
    const event = raw.event as ActionEventKind;
    const source = validateSource(event, raw.source);
    if (!source.ok) return fail(source);
    let delayMinutes: number | undefined;
    if (raw.delayMinutes !== undefined && raw.delayMinutes !== null && raw.delayMinutes !== 0) {
      if (typeof raw.delayMinutes !== 'number' || !Number.isInteger(raw.delayMinutes) || raw.delayMinutes < 0 || raw.delayMinutes > MAX_DELAY_MINUTES) {
        return { ok: false, error: `The wait must be a whole number of minutes, up to ${MAX_DELAY_MINUTES}.` };
      }
      delayMinutes = raw.delayMinutes;
    }
    if (event === 'agent.idle' && !delayMinutes) return { ok: false, error: 'Say how many minutes of idle time to wait for.' };
    if (source.value.kind === 'any' && raw.delayMinutes !== undefined) {
      return { ok: false, error: 'Any readable agent uses its coalescing window instead of Wait first.' };
    }
    let coalesceSeconds: number | undefined;
    if (raw.coalesceSeconds !== undefined) {
      if (source.value.kind !== 'any') return { ok: false, error: 'A coalescing window is only for any readable agent.' };
      if (typeof raw.coalesceSeconds !== 'number' || !Number.isInteger(raw.coalesceSeconds) || raw.coalesceSeconds < MIN_COALESCE_SECONDS || raw.coalesceSeconds > MAX_COALESCE_SECONDS) {
        return { ok: false, error: `The coalescing window must be whole seconds, from ${MIN_COALESCE_SECONDS} to ${MAX_COALESCE_SECONDS}.` };
      }
      coalesceSeconds = raw.coalesceSeconds;
    }
    let branch: string | undefined;
    if (GIT_EVENT_KINDS.includes(event) && nonEmpty(raw.branch)) branch = raw.branch.trim();
    let absenceMinutes: number | undefined;
    if (raw.absenceMinutes !== undefined) {
      if (event !== 'app.returned') return { ok: false, error: 'An absence threshold is only for Clubhouse returning to use.' };
      if (typeof raw.absenceMinutes !== 'number' || !Number.isSafeInteger(raw.absenceMinutes) || raw.absenceMinutes < MIN_ABSENCE_MINUTES) {
        return { ok: false, error: `The absence must be a whole number of minutes, at least ${MIN_ABSENCE_MINUTES}.` };
      }
      absenceMinutes = raw.absenceMinutes;
    }
    if (raw.afterLocalTime !== undefined && (typeof raw.afterLocalTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.afterLocalTime))) {
      return { ok: false, error: 'The local time must be HH:MM, from 00:00 to 23:59.' };
    }
    if (raw.oncePerDay !== undefined && typeof raw.oncePerDay !== 'boolean') return { ok: false, error: 'Once per calendar day must be true or false.' };
    return {
      ok: true, value: {
        kind: 'event', event, source: source.value, ...(delayMinutes && { delayMinutes }), ...(branch && { branch }),
        ...(absenceMinutes !== undefined && { absenceMinutes }),
        ...(typeof raw.afterLocalTime === 'string' && { afterLocalTime: raw.afterLocalTime }),
        ...(typeof raw.oncePerDay === 'boolean' && { oncePerDay: raw.oncePerDay }),
        ...(coalesceSeconds !== undefined && { coalesceSeconds }),
      },
    };
  }
  return { ok: false, error: 'The trigger must be a schedule, an event, or once.' };
}

export function validateStep(raw: unknown, index: number): Result<ActionStep> {
  const label = `Step ${index + 1}`;
  if (!isObject(raw) || !ACTION_STEP_KINDS.includes(raw.kind as never)) return { ok: false, error: `${label} needs a type.` };
  const needAgent = (): Result<string> => nonEmpty(raw.agentId) ? { ok: true, value: raw.agentId } : { ok: false, error: `${label} needs an agent.` };
  switch (raw.kind) {
    case 'wake': {
      const agentId = needAgent(); if (!agentId.ok) return fail(agentId);
      const prompt = text(raw.prompt, `${label}’s prompt`, false); if (!prompt.ok) return fail(prompt);
      return { ok: true, value: { kind: 'wake', agentId: agentId.value, ...(prompt.value?.trim() && { prompt: prompt.value }) } };
    }
    case 'message': {
      const agentId = needAgent(); if (!agentId.ok) return fail(agentId);
      const t = text(raw.text, `${label}’s message`, true); if (!t.ok) return fail(t);
      return { ok: true, value: { kind: 'message', agentId: agentId.value, text: t.value as string } };
    }
    case 'sleep': {
      const agentId = needAgent(); if (!agentId.ok) return fail(agentId);
      return { ok: true, value: { kind: 'sleep', agentId: agentId.value } };
    }
    case 'notify': {
      const t = text(raw.text, `${label}’s notice text`, true); if (!t.ok) return fail(t);
      return { ok: true, value: { kind: 'notify', text: t.value as string } };
    }
    case 'quick': {
      if (!nonEmpty(raw.projectId)) return { ok: false, error: `${label} needs a project to run in.` };
      const prompt = text(raw.prompt, `${label}’s prompt`, true); if (!prompt.ok) return fail(prompt);
      if (raw.difficulty !== undefined && !isHelperDifficulty(raw.difficulty)) return { ok: false, error: `${label} needs a difficulty of easy, medium or hard.` };
      if (raw.difficulty !== undefined && raw.orchestrator !== 'auto') return { ok: false, error: `${label} uses difficulty only with Auto.` };
      if (raw.orchestrator === 'auto' && nonEmpty(raw.model)) return { ok: false, error: `${label} uses Auto's model mapping, not a model override.` };
      return {
        ok: true,
        value: {
          kind: 'quick',
          projectId: raw.projectId,
          prompt: prompt.value as string,
          ...(nonEmpty(raw.worktreeAgentId) && { worktreeAgentId: raw.worktreeAgentId }),
          ...(nonEmpty(raw.orchestrator) && { orchestrator: raw.orchestrator }),
          ...(nonEmpty(raw.model) && { model: raw.model }),
          ...(isHelperDifficulty(raw.difficulty) && { difficulty: raw.difficulty }),
        },
      };
    }
  }
  return { ok: false, error: `${label} needs a type.` };
}

export interface ValidActionInput {
  name?: string;
  trigger: ActionTrigger;
  steps: ActionStep[];
  overlap: OverlapRule;
  enabled: boolean;
  endsAt?: number;
  maxRuns?: number;
}

/** Check and normalize action input. Unknown fields are dropped. */
export function validateActionInput(raw: unknown, options: { now?: number; allowPastEndsAt?: boolean } = {}): Result<ValidActionInput> {
  if (!isObject(raw)) return { ok: false, error: 'An action is required.' };
  const trigger = validateTrigger(raw.trigger);
  if (!trigger.ok) return fail(trigger);
  const limits: { endsAt?: number; maxRuns?: number } = {};
  if (raw.endsAt !== undefined && raw.endsAt !== null) {
    if (trigger.value.kind === 'once') return { ok: false, error: 'One-time actions cannot have an end time.' };
    if (typeof raw.endsAt !== 'number' || !Number.isFinite(raw.endsAt) || raw.endsAt <= 0 || raw.endsAt > MAX_ONCE_AT) {
      return { ok: false, error: 'The end time must be an absolute timestamp in milliseconds.' };
    }
    if (!options.allowPastEndsAt && raw.endsAt <= (options.now ?? Date.now())) return { ok: false, error: 'Pick an end time in the future.' };
    limits.endsAt = raw.endsAt;
  }
  if (raw.maxRuns !== undefined && raw.maxRuns !== null) {
    if (trigger.value.kind === 'once') return { ok: false, error: 'One-time actions cannot have a run limit.' };
    if (typeof raw.maxRuns !== 'number' || !Number.isSafeInteger(raw.maxRuns) || raw.maxRuns <= 0) {
      return { ok: false, error: 'The run limit must be a positive whole number.' };
    }
    limits.maxRuns = raw.maxRuns;
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return { ok: false, error: 'Add at least one step.' };
  if (raw.steps.length > MAX_ACTION_STEPS) return { ok: false, error: `An action has at most ${MAX_ACTION_STEPS} steps.` };
  const steps: ActionStep[] = [];
  for (let i = 0; i < raw.steps.length; i++) {
    const step = validateStep(raw.steps[i], i);
    if (!step.ok) return fail(step);
    steps.push(step.value);
  }
  let name: string | undefined;
  if (raw.name !== undefined && raw.name !== null) {
    if (typeof raw.name !== 'string') return { ok: false, error: 'The name must be text.' };
    const trimmed = raw.name.trim();
    if (trimmed.length > MAX_NAME_LENGTH) return { ok: false, error: `The name is longer than ${MAX_NAME_LENGTH} characters.` };
    if (trimmed) name = trimmed;
  }
  const overlap: OverlapRule = raw.overlap === 'queue' ? 'queue' : 'skip';
  const enabled = raw.enabled !== false;
  return { ok: true, value: { name, trigger: trigger.value, steps, overlap, enabled, ...limits } };
}

/** Throwing form, for callers that report ActionError. */
export function assertActionInput(raw: unknown, now = Date.now()): ValidActionInput {
  const result = validateActionInput(raw, { now });
  if (!result.ok) throw new ActionError('invalid_input', result.error);
  return result.value;
}

/**
 * Keep the newest runs: at most HISTORY_MAX_RUNS within HISTORY_MAX_AGE_MS,
 * whichever leaves fewer. A run still going is always kept.
 */
export function trimHistory(runs: ActionRun[], now: number): ActionRun[] {
  const newestFirst = [...runs].sort((a, b) => b.startedAt - a.startedAt);
  const kept: ActionRun[] = [];
  for (const run of newestFirst) {
    const fresh = now - run.startedAt <= HISTORY_MAX_AGE_MS;
    if (run.outcome === 'running' || (fresh && kept.length < HISTORY_MAX_RUNS)) kept.push(run);
  }
  return kept;
}
