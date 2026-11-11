/**
 * The New / edit action form's state (#2953), and the conversion to and from
 * the shared action model. Kept apart from the form so it is tested alone.
 */

import {
  DEFAULT_PRESET_FIELDS,
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
  /** 'agent:<id>', 'project:<id>', or '' for app events. */
  source: string;
  /** Minutes, as typed. */
  delay: string;
  branch: string;
  /** datetime-local value. */
  onceAt: string;
  endsAt: string;
  originalEndsAt?: number;
  maxRuns: string;
  absenceMinutes: string;
  steps: StepDraft[];
  overlap: OverlapRule;
}

export function emptyStep(kind: ActionStepKind = 'wake'): StepDraft {
  return { kind, agentId: '', text: '', projectId: '', worktreeAgentId: '', orchestrator: '', model: '' };
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
    delay: '',
    branch: '',
    onceAt: toLocalInput(now + 60 * 60 * 1000),
    endsAt: '',
    maxRuns: '',
    absenceMinutes: '',
    steps: [emptyStep()],
    overlap: 'skip',
  };
}

function stepToDraft(s: ActionStep): StepDraft {
  const d = emptyStep(s.kind);
  switch (s.kind) {
    case 'wake': return { ...d, agentId: s.agentId, text: s.prompt ?? '' };
    case 'message': return { ...d, agentId: s.agentId, text: s.text };
    case 'sleep': return { ...d, agentId: s.agentId };
    case 'notify': return { ...d, text: s.text };
    case 'quick': return {
      ...d, projectId: s.projectId, worktreeAgentId: s.worktreeAgentId ?? '', text: s.prompt, orchestrator: s.orchestrator ?? '', model: s.model ?? '',
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
    d.source = t.source.kind === 'agent' ? `agent:${t.source.agentId}` : t.source.kind === 'project' ? `project:${t.source.projectId}` : '';
    d.delay = t.delayMinutes ? String(t.delayMinutes) : '';
    d.branch = t.branch ?? '';
    d.absenceMinutes = t.absenceMinutes !== undefined ? String(t.absenceMinutes) : '';
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
    case 'message': return { kind: 'message', agentId: s.agentId, text: s.text };
    case 'sleep': return { kind: 'sleep', agentId: s.agentId };
    case 'notify': return { kind: 'notify', text: s.text };
    case 'quick': return {
      kind: 'quick', projectId: s.projectId, prompt: s.text,
      ...(s.worktreeAgentId && { worktreeAgentId: s.worktreeAgentId }),
      ...(s.orchestrator && { orchestrator: s.orchestrator }),
      ...(s.model && { model: s.model }),
    };
  }
}

function sourceFromDraft(source: string): Record<string, unknown> {
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
    const delay = d.delay.trim() === '' ? undefined : Number(d.delay);
    if (delay !== undefined && !(Number.isInteger(delay) && delay >= 0)) return { ok: false, error: 'The wait must be a whole number of minutes.' };
    trigger = {
      kind: 'event', event: d.event, source: sourceFromDraft(d.source), ...(delay && { delayMinutes: delay }), ...(d.branch.trim() && { branch: d.branch.trim() }),
      ...(d.event === 'app.returned' && d.absenceMinutes.trim() && { absenceMinutes: Number(d.absenceMinutes) }),
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
