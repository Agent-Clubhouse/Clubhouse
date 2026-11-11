/**
 * The New / edit action form's state (#2953), and the conversion to and from
 * the shared action model. Kept apart from the form so it is tested alone.
 */

import {
  DEFAULT_PRESET_FIELDS,
  DEFAULT_COALESCE_SECONDS,
  cronToPresetFields,
  presetToCron,
  validateActionInput,
  type ActionEventKind,
  type ActionInput,
  type ActionStep,
  type ActionStepKind,
  type MissedRunRule,
  type OverlapRule,
  type SchedulePreset,
} from '../../../shared/actions';
import type { HelperDifficulty } from '../../../shared/helper-routing';

export type WhenKind = 'schedule' | 'event' | 'once';

export interface StepDraft {
  kind: ActionStepKind;
  agentId: string;
  /** Prompt (wake, quick), message text, or notice text. */
  text: string;
  projectId: string;
  /** Quick agents: run in this agent's worktree; empty for the project root. */
  worktreeAgentId: string;
  /** Quick agents: empty for the project's provider. */
  orchestrator: string;
  /** Quick agents: a model override (set over MCP; cleared when the provider changes). */
  model: string;
  difficulty: HelperDifficulty;
  delivery: '' | 'queue' | 'steer';
  latestOnly?: boolean;
  maxWaitMinutes: string;
}

export interface ActionDraft {
  name: string;
  when: WhenKind;
  preset: SchedulePreset;
  /** "HH:MM", 24-hour, local. */
  time: string;
  weekday: number;
  /** Hourly: minutes past the hour. */
  minute: number;
  cron: string;
  missed: MissedRunRule;
  event: ActionEventKind;
  /** 'agent:<id>', 'project:<id>', 'any', or '' for app events. */
  source: string;
  timing: 'none' | 'delay' | 'coalesce';
  delayUnit: 'minutes' | 'seconds';
  /** Delay in the selected unit, as typed. */
  delay: string;
  branch: string;
  /** datetime-local value. */
  onceAt: string;
  endsAt: string;
  originalEndsAt?: number;
  maxRuns: string;
  absenceMinutes: string;
  afterLocalTime: string;
  oncePerDay: boolean;
  coalesceSeconds: string;
  throttleMaxRuns: string;
  throttlePerMinutes: string;
  steps: StepDraft[];
  overlap: OverlapRule;
}

export function emptyStep(kind: ActionStepKind = 'wake'): StepDraft {
  return { kind, agentId: '', text: '', projectId: '', worktreeAgentId: '', orchestrator: '', model: '', difficulty: 'medium', delivery: '', maxWaitMinutes: '' };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A datetime-local value for an epoch time, in local time. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function newDraft(now = Date.now()): ActionDraft {
  return {
    name: '',
    when: 'schedule',
    preset: 'weekdays',
    time: `${pad(DEFAULT_PRESET_FIELDS.hour)}:${pad(DEFAULT_PRESET_FIELDS.minute)}`,
    weekday: DEFAULT_PRESET_FIELDS.weekday,
    minute: 0,
    cron: '0 9 * * 1-5',
    missed: 'skip',
    event: 'agent.slept',
    source: '',
    timing: 'none',
    delayUnit: 'minutes',
    delay: '',
    branch: '',
    onceAt: toLocalInput(now + 60 * 60 * 1000),
    endsAt: '',
    maxRuns: '',
    absenceMinutes: '',
    afterLocalTime: '',
    oncePerDay: false,
    coalesceSeconds: '',
    throttleMaxRuns: '',
    throttlePerMinutes: '',
    steps: [emptyStep()],
    overlap: 'skip',
  };
}

function stepToDraft(s: ActionStep): StepDraft {
  const d = emptyStep(s.kind);
  switch (s.kind) {
    case 'wake': return { ...d, agentId: s.agentId, text: s.prompt ?? '' };
    case 'message': return {
      ...d, agentId: s.agentId, text: s.text, delivery: s.delivery ?? '',
      ...(s.latestOnly !== undefined && { latestOnly: s.latestOnly }),
      maxWaitMinutes: s.maxWaitMinutes !== undefined ? String(s.maxWaitMinutes) : '',
    };
    case 'sleep': return { ...d, agentId: s.agentId };
    case 'notify': return { ...d, text: s.text };
    case 'quick': return {
      ...d, projectId: s.projectId, worktreeAgentId: s.worktreeAgentId ?? '', text: s.prompt, orchestrator: s.orchestrator ?? '', model: s.model ?? '', difficulty: s.difficulty ?? 'medium',
    };
  }
}

/** A draft from an action, or from part of one (a starter pattern). */
export function draftFrom(input: Partial<ActionInput>, now = Date.now()): ActionDraft {
  const d = newDraft(now);
  if (input.name) d.name = input.name;
  if (input.overlap) d.overlap = input.overlap;
  if (input.endsAt !== undefined) {
    d.endsAt = toLocalInput(input.endsAt);
    d.originalEndsAt = input.endsAt;
  }
  if (input.maxRuns !== undefined) d.maxRuns = String(input.maxRuns);
  if (input.steps?.length) d.steps = input.steps.map(stepToDraft);
  const t = input.trigger;
  if (t?.kind === 'schedule') {
    const f = cronToPresetFields(t.preset, t.cron);
    Object.assign(d, { when: 'schedule', preset: t.preset, cron: t.cron, missed: t.missed, time: `${pad(f.hour)}:${pad(f.minute)}`, weekday: f.weekday, minute: f.minute });
  } else if (t?.kind === 'once') {
    Object.assign(d, { when: 'once', onceAt: toLocalInput(t.at) });
  } else if (t?.kind === 'event') {
    d.when = 'event';
    d.event = t.event;
    d.source = t.source.kind === 'agent' ? `agent:${t.source.agentId}` : t.source.kind === 'project' ? `project:${t.source.projectId}` : t.source.kind === 'any' ? 'any' : '';
    d.timing = t.source.kind === 'any' || t.coalesceSeconds !== undefined ? 'coalesce'
      : t.delaySeconds || t.delayMinutes || t.event === 'agent.idle' ? 'delay' : 'none';
    d.delayUnit = t.delaySeconds !== undefined ? 'seconds' : 'minutes';
    d.delay = t.delaySeconds !== undefined ? String(t.delaySeconds) : t.delayMinutes ? String(t.delayMinutes) : '';
    d.branch = t.branch ?? '';
    d.absenceMinutes = t.absenceMinutes !== undefined ? String(t.absenceMinutes) : '';
    d.afterLocalTime = t.afterLocalTime ?? '';
    d.oncePerDay = t.oncePerDay ?? false;
    d.coalesceSeconds = t.coalesceSeconds !== undefined ? String(t.coalesceSeconds) : '';
    d.throttleMaxRuns = t.throttle ? String(t.throttle.maxRuns) : '';
    d.throttlePerMinutes = t.throttle ? String(t.throttle.perMinutes) : '';
  }
  return d;
}

/** The cron line the schedule part of a draft stands for. */
export function draftCron(d: ActionDraft): string {
  if (d.preset === 'cron') return d.cron.trim();
  const [h, m] = (/^\d{1,2}:\d{2}$/.test(d.time) ? d.time : '').split(':').map(Number);
  return presetToCron(d.preset, {
    hour: Number.isFinite(h) ? h : DEFAULT_PRESET_FIELDS.hour,
    minute: d.preset === 'hourly' ? d.minute : (Number.isFinite(m) ? m : 0),
    weekday: d.weekday,
  }) as string;
}

function stepFromDraft(s: StepDraft): Record<string, unknown> {
  switch (s.kind) {
    case 'wake': return { kind: 'wake', agentId: s.agentId, ...(s.text.trim() && { prompt: s.text }) };
    case 'message': return {
      kind: 'message', agentId: s.agentId, text: s.text,
      ...(s.delivery && { delivery: s.delivery }),
      ...(s.latestOnly !== undefined && { latestOnly: s.latestOnly }),
      ...(s.maxWaitMinutes.trim() && { maxWaitMinutes: Number(s.maxWaitMinutes) }),
    };
    case 'sleep': return { kind: 'sleep', agentId: s.agentId };
    case 'notify': return { kind: 'notify', text: s.text };
    case 'quick': return {
      kind: 'quick', projectId: s.projectId, prompt: s.text,
      ...(s.worktreeAgentId && { worktreeAgentId: s.worktreeAgentId }),
      ...(s.orchestrator && { orchestrator: s.orchestrator }),
      ...(s.model && { model: s.model }),
      ...(s.orchestrator === 'auto' && { difficulty: s.difficulty }),
    };
  }
}

function sourceFromDraft(source: string): Record<string, unknown> {
  if (source === 'any') return { kind: 'any' };
  if (source.startsWith('agent:')) return { kind: 'agent', agentId: source.slice(6) };
  if (source.startsWith('project:')) return { kind: 'project', projectId: source.slice(8) };
  return { kind: 'app' };
}

/** The draft as action input, or the first problem with it in plain words. */
export function draftToInput(d: ActionDraft, now = Date.now()): { ok: true; input: ActionInput; error?: undefined } | { ok: false; error: string; input?: undefined } {
  let trigger: Record<string, unknown>;
  if (d.when === 'schedule') {
    if (d.preset !== 'cron' && d.preset !== 'hourly' && !/^\d{1,2}:\d{2}$/.test(d.time)) return { ok: false, error: 'Pick a time.' };
    trigger = { kind: 'schedule', preset: d.preset, cron: draftCron(d), missed: d.missed };
  } else if (d.when === 'once') {
    const at = new Date(d.onceAt).getTime();
    if (!Number.isFinite(at)) return { ok: false, error: 'Pick a date and time.' };
    if (at <= now) return { ok: false, error: 'Pick a time in the future.' };
    trigger = { kind: 'once', at };
  } else {
    const timing = d.source === 'any' ? 'coalesce' : d.event === 'agent.idle' ? 'delay' : d.timing;
    const delay = timing === 'delay' && d.delay.trim() !== '' ? Number(d.delay) : undefined;
    if (timing === 'delay' && (delay === undefined || !Number.isInteger(delay) || delay <= 0)) return { ok: false, error: `The wait must be a positive whole number of ${d.delayUnit}.` };
    trigger = {
      kind: 'event', event: d.event, source: sourceFromDraft(d.source),
      ...(delay && (d.delayUnit === 'seconds' ? { delaySeconds: delay } : { delayMinutes: delay })),
      ...(d.branch.trim() && { branch: d.branch.trim() }),
      ...(d.event === 'app.returned' && d.absenceMinutes.trim() && { absenceMinutes: Number(d.absenceMinutes) }),
      ...(d.afterLocalTime && { afterLocalTime: d.afterLocalTime }),
      ...(d.oncePerDay && { oncePerDay: true }),
      ...(timing === 'coalesce' && (d.coalesceSeconds.trim() || d.source !== 'any') && { coalesceSeconds: Number(d.coalesceSeconds.trim() || DEFAULT_COALESCE_SECONDS) }),
      ...((d.throttleMaxRuns.trim() || d.throttlePerMinutes.trim()) && { throttle: { maxRuns: Number(d.throttleMaxRuns), perMinutes: Number(d.throttlePerMinutes) } }),
    };
  }
  // Keep the exact instant when unchanged, including seconds and the repeated DST hour.
  const endsAt = d.originalEndsAt !== undefined && d.endsAt === toLocalInput(d.originalEndsAt)
    ? d.originalEndsAt : new Date(d.endsAt).getTime();
  const raw = {
    ...(d.name.trim() && { name: d.name.trim() }), trigger, steps: d.steps.map(stepFromDraft), overlap: d.overlap,
    ...(d.when !== 'once' && d.endsAt && { endsAt }),
    ...(d.when !== 'once' && d.maxRuns.trim() && { maxRuns: Number(d.maxRuns) }),
  };
  const valid = validateActionInput(raw, { now });
  if (!valid.ok) return { ok: false, error: valid.error };
  // No on/off state: a new action starts on, and an edit keeps what the action has now.
  const { enabled: _enabled, name, ...rest } = valid.value;
  return { ok: true, input: { ...rest, ...(name && { name }) } };
}
