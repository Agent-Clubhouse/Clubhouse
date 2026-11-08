/**
 * Actions in plain words (#2918): schedule presets, trigger and step lines for
 * the list ("Weekdays at 9:00 AM → Wake pm with a prompt"), and the suggested
 * name. Copy avoids "automation", "cron job" and "hook", except the
 * "Custom (cron)" option.
 */

import { describeCron, formatClock, parseCron } from './cron';
import type {
  ActionEventKind,
  ActionEventSource,
  ActionOwner,
  ActionStep,
  ActionTrigger,
  MissedRunRule,
  OverlapRule,
  SchedulePreset,
} from './types';

// ── Presets ─────────────────────────────────────────────────────────────────

export interface PresetFields {
  /** 0–23. Unused by hourly. */
  hour: number;
  minute: number;
  /** 0 (Sunday) to 6. Weekly only. */
  weekday: number;
}

export const DEFAULT_PRESET_FIELDS: PresetFields = { hour: 9, minute: 0, weekday: 1 };

/** The cron line a preset is stored as. Custom returns null: the person types it. */
export function presetToCron(preset: SchedulePreset, f: PresetFields): string | null {
  switch (preset) {
    case 'daily': return `${f.minute} ${f.hour} * * *`;
    case 'weekdays': return `${f.minute} ${f.hour} * * 1-5`;
    case 'weekly': return `${f.minute} ${f.hour} * * ${f.weekday}`;
    case 'hourly': return `${f.minute} * * * *`;
    case 'cron': return null;
  }
}

/** Read a preset's fields back from its cron line, for the edit form. */
export function cronToPresetFields(preset: SchedulePreset, cron: string): PresetFields {
  const parts = cron.trim().split(/\s+/);
  const num = (s: string | undefined, fallback: number) => (s && /^\d+$/.test(s) ? Number(s) : fallback);
  if (preset === 'cron' || parts.length !== 5) return { ...DEFAULT_PRESET_FIELDS };
  return {
    minute: num(parts[0], DEFAULT_PRESET_FIELDS.minute),
    hour: num(parts[1], DEFAULT_PRESET_FIELDS.hour),
    weekday: num(parts[4], DEFAULT_PRESET_FIELDS.weekday),
  };
}

export const PRESET_LABELS: Record<SchedulePreset, string> = {
  daily: 'Every day',
  weekdays: 'Weekdays',
  weekly: 'Every week',
  hourly: 'Every hour',
  cron: 'Custom (cron)',
};

export const MISSED_RUN_LABELS: Record<MissedRunRule, string> = {
  skip: 'Skip missed times',
  once: 'Run once when Clubhouse opens',
  each: 'Run each missed time, up to 10',
};

export const OVERLAP_LABELS: Record<OverlapRule, string> = {
  skip: 'Skip this run',
  queue: 'Run it after the current run',
};

// ── Names for things ────────────────────────────────────────────────────────

/** Looks up display names. Unknown ids fall back to a generic word. */
export interface ActionNames {
  agent(agentId: string): string | undefined;
  project(projectId: string): string | undefined;
}

const NO_NAMES: ActionNames = { agent: () => undefined, project: () => undefined };

function agentName(names: ActionNames, id: string): string {
  return names.agent(id) ?? 'an agent';
}

function sourceText(source: ActionEventSource, names: ActionNames): string {
  if (source.kind === 'agent') return agentName(names, source.agentId);
  if (source.kind === 'project') return `any agent in ${names.project(source.projectId) ?? 'a project'}`;
  return 'Clubhouse';
}

/** "release-lead", "any agent in web" — what the event is about, for the sentence. */
const EVENT_PHRASES: Record<ActionEventKind, string> = {
  'agent.woke': 'wakes',
  'agent.slept': 'goes to sleep',
  'agent.created': 'is created',
  'agent.deleted': 'is deleted',
  'agent.turn_ended': 'finishes a turn',
  'agent.turn_failed': 'has a turn fail',
  'agent.idle': 'goes idle',
  'agent.waiting': 'waits on you',
  'agent.error': 'hits an error',
  'agent.compacted': 'compacts its context',
  'helper.finished': 'has a helper finish',
  'git.commit': 'gets a new commit',
  'git.branch_switched': 'switches branch',
  'git.remote_updated': 'is pushed, pulled or fetched',
  'app.started': 'starts',
  'project.added': 'is added',
  'project.removed': 'is removed',
};

/** "goes to sleep", "gets a new commit": the event as the end of a sentence about its subject. */
export function eventPhrase(kind: ActionEventKind): string {
  return EVENT_PHRASES[kind];
}

/** Labels for the grouped event menu. */
export const EVENT_LABELS: Record<ActionEventKind, string> = {
  'agent.woke': 'Wakes',
  'agent.slept': 'Goes to sleep',
  'agent.created': 'Is created',
  'agent.deleted': 'Is deleted',
  'agent.turn_ended': 'Finishes a turn',
  'agent.turn_failed': 'Has a turn fail',
  'agent.idle': 'Goes idle for a while',
  'agent.waiting': 'Waits on you',
  'agent.error': 'Hits an error',
  'agent.compacted': 'Compacts its context',
  'helper.finished': 'A helper finishes',
  'git.commit': 'New commit',
  'git.branch_switched': 'Branch switched',
  'git.remote_updated': 'Pushed, pulled or fetched',
  'app.started': 'Clubhouse starts',
  'project.added': 'A project is added',
  'project.removed': 'A project is removed',
};

export function formatMinutes(minutes: number): string {
  if (minutes % (24 * 60) === 0) {
    const d = minutes / (24 * 60);
    return d === 1 ? '1 day' : `${d} days`;
  }
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? '1 hour' : `${h} hours`;
  }
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

function formatDateTime(at: number): string {
  const d = new Date(at);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${formatClock(d.getHours(), d.getMinutes())}`;
}

/** The trigger in plain words, e.g. "Weekdays at 9:00 AM", "30 minutes after release-lead goes to sleep". */
export function describeTrigger(trigger: ActionTrigger, names: ActionNames = NO_NAMES): string {
  if (trigger.kind === 'schedule') {
    return parseCron(trigger.cron).ok ? describeCron(trigger.cron) : `Custom (cron): ${trigger.cron}`;
  }
  if (trigger.kind === 'once') return `Once, ${formatDateTime(trigger.at)}`;
  const src = trigger.source;
  let subject: string;
  if (trigger.event.startsWith('app.')) subject = 'Clubhouse';
  else if (trigger.event.startsWith('project.')) subject = src.kind === 'project' ? names.project(src.projectId) ?? 'a project' : 'a project';
  else if (trigger.event.startsWith('git.')) {
    subject = src.kind === 'agent' ? `${agentName(names, src.agentId)}’s worktree`
      : src.kind === 'project' ? names.project(src.projectId) ?? 'a project' : 'a project';
  } else subject = sourceText(src, names);
  const branch = trigger.branch && trigger.event.startsWith('git.') ? ` (${trigger.branch})` : '';
  const what = `${subject} ${EVENT_PHRASES[trigger.event]}${branch}`;
  if (trigger.event === 'agent.idle') {
    return `${subject} goes idle for ${formatMinutes(trigger.delayMinutes ?? 0)}`;
  }
  if (trigger.delayMinutes) return `${formatMinutes(trigger.delayMinutes)} after ${what}`;
  return `When ${what}`;
}

/** One step in plain words, e.g. "Wake pm with a prompt". */
export function describeStep(step: ActionStep, names: ActionNames = NO_NAMES): string {
  switch (step.kind) {
    case 'wake': return `Wake ${agentName(names, step.agentId)}${step.prompt ? ' with a prompt' : ''}`;
    case 'message': return `Message ${agentName(names, step.agentId)}`;
    case 'sleep': return `Put ${agentName(names, step.agentId)} to sleep`;
    case 'notify': return 'Notify you';
    case 'quick': {
      const where = step.worktreeAgentId
        ? `in ${agentName(names, step.worktreeAgentId)}’s worktree`
        : `in ${names.project(step.projectId) ?? 'a project'}`;
      return `Start a quick agent ${where}`;
    }
  }
}

export function describeSteps(steps: ActionStep[], names: ActionNames = NO_NAMES): string {
  return steps.map((s, i) => {
    const text = describeStep(s, names);
    return i === 0 ? text : text.charAt(0).toLowerCase() + text.slice(1);
  }).join(', then ');
}

/** The list line: "Weekdays at 9:00 AM → Wake pm with a prompt". A subscription (#3042) reads "→ Tell pm". */
export function describeAction(a: { trigger: ActionTrigger; steps: ActionStep[]; subscription?: true; owner?: ActionOwner }, names: ActionNames = NO_NAMES): string {
  const step = a.steps[0];
  if (a.subscription && a.steps.length === 1 && step?.kind === 'message') {
    const who = names.agent(step.agentId) ?? (a.owner?.kind === 'dispatcher' || a.owner?.kind === 'app' ? 'the Dispatcher' : 'an agent');
    return `${describeTrigger(a.trigger, names)} → Tell ${who}`;
  }
  return `${describeTrigger(a.trigger, names)} → ${describeSteps(a.steps, names)}`;
}

/** A suggested name, e.g. "After release-lead sleeps, start a quick agent". Editable. */
export function suggestActionName(a: { trigger: ActionTrigger; steps: ActionStep[] }, names: ActionNames = NO_NAMES): string {
  const first = a.steps[0] ? describeStep(a.steps[0], names) : 'Do something';
  const firstLower = first.charAt(0).toLowerCase() + first.slice(1);
  const t = a.trigger;
  let lead: string;
  if (t.kind === 'schedule') lead = describeTrigger(t, names);
  else if (t.kind === 'once') lead = 'Once';
  else if (t.event === 'agent.idle') lead = `When ${sourceText(t.source, names)} goes idle`;
  else lead = `After ${describeTrigger({ ...t, delayMinutes: undefined }, names).replace(/^When /, '')}`;
  const name = `${lead}, ${firstLower}`;
  return name.length > 80 ? `${name.slice(0, 79)}…` : name;
}
