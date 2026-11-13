/**
 * Actions tools (#2918, #2952): create, list, change, delete, run and read
 * the history of actions over Clubhouse MCP. They take and return the same
 * model as Settings > Actions (src/shared/actions), plus a plain-words line
 * for each action, and call the same service the UI does.
 *
 * Every agent has these tools, for its own actions. The Dispatcher has them
 * too, for every action people and agents can see. Clubhouse's own actions
 * (owner 'app') never show to anyone.
 *
 * Errors are typed: `{ error: { code, message } }` with isError, using the
 * ActionError codes, so an agent can explain a refusal. An action the caller
 * may not see answers not_found, the same as one that doesn't exist.
 *
 * Permission model (#2921): each tool maps to one `action.*` permission,
 * listed in ACTION_TOOL_PERMISSIONS. Until those grants land, actionScope
 * below is the whole rule, and the one place to replace.
 */

import { callGrantIsApproved, grantApprovalContext, registerGlobalTool } from '../tool-registry';
import { checkToolGrant, decideGrant, isGroupMember, registerActionOwnerLookup } from '../grant-check';
import { resolveArgTargets } from '../arg-targets';
import type { GrantCallTarget } from '../../../../shared/agent-grants';
import { groupProjectRegistry } from '../../group-project-registry';
import { groupProjectHost } from '../../group-project-host';
import type { McpToolDefinition, McpToolResult } from '../types';
import { isDispatcherAgent, isTrackedDispatcher } from '../dispatcher-gate';
import { mcpCallerKind } from '../mcp-call-gate';
import { knownAgent } from '../../app-event-sources';
import { appLog } from '../../log-service';
import * as actions from '../../actions';
import {
  ACTION_EVENT_KINDS,
  ACTION_STEP_KINDS,
  ActionError,
  MAX_ACTION_STEPS,
  MAX_DELAY_MINUTES,
  MIN_ABSENCE_MINUTES,
  MIN_COALESCE_SECONDS,
  MAX_COALESCE_SECONDS,
  MISSED_RUN_RULES,
  SCHEDULE_PRESETS,
  describeAction,
  presetToCron,
  suggestActionName,
  DEFAULT_PRESET_FIELDS,
  type Action,
  type ActionErrorCode,
  type ActionOwner,
  type ActionView,
  type SchedulePreset,
} from '../../../../shared/actions';

/** The permission each tool needs in the agent permission model (#2921). */
export const ACTION_TOOL_PERMISSIONS = {
  create_action: 'action.create',
  list_actions: 'action.list',
  update_action: 'action.update',
  delete_action: 'action.delete',
  run_action: 'action.run',
  action_history: 'action.history',
  // A subscription is an action the caller owns (#3042): creating one is creating an action.
  subscribe: 'action.create',
} as const;

export type ActionToolName = keyof typeof ACTION_TOOL_PERMISSIONS;

/** ActionError codes, plus `internal` for something that broke. */
export type ActionToolErrorCode = ActionErrorCode | 'internal';

// ── Scope ───────────────────────────────────────────────────────────────────

export interface ActionScope {
  callerId: string;
  /** Owner of the actions this caller creates. */
  owner: ActionOwner;
  /** Whether the caller may see and change this action. */
  /** Whether the caller may read this action (list, history). */
  canSee(action: Pick<Action, 'owner'> & Partial<Pick<Action, 'trigger'>>): boolean;
  /** Whether the caller may change, delete or run it. */
  canChange(action: Pick<Action, 'owner'>): boolean;
}

function groupAdmin(callerId: string, groupProjectId: string, approved = false): boolean {
  const project = groupProjectRegistry.getSync(groupProjectId);
  if (!project || !groupProjectHost.isThisMachine(project.host) || !isGroupMember(groupProjectId, callerId)) return false;
  const outcome = decideGrant(callerId, 'group_project.admin', { kind: 'group_project', groupRole: 'member', groupProjectId } as GrantCallTarget).outcome;
  return outcome === 'allow' || (outcome === 'ask' && approved);
}

function canSeeAction(action: Pick<Action, 'owner'> & Partial<Pick<Action, 'trigger'>>, reader: ActionOwner): boolean {
  if (action.trigger?.kind === 'event' && action.trigger.source.kind === 'device' && !actions.canReadDevices(reader)) return false;
  return action.owner.kind !== 'app' && (action.trigger?.kind !== 'event' || action.trigger.source.kind !== 'any' || actions.canWatchAgentActivity(reader));
}

/**
 * Who the caller is to Actions:
 * - The Dispatcher owns what it creates, and sees and changes every action
 *   people and agents can see.
 * - Any other agent owns what it creates, and sees and changes only those.
 * - A helper's actions are marked as a helper's, with a lower cap, and are
 *   deleted when it is disposed.
 * - A quick agent can't own actions: it ends when its task does.
 * What each step may do and what a trigger may watch follow the owner's
 * Clubhouse permissions, and how many actions an owner may have is a rule of
 * Actions: rights.ts, which the engine checks on create, update, turning on
 * and every run (#2960, D131).
 */
export function actionScope(callerId: string, groupApproved = false): ActionScope {
  if (isDispatcherAgent(callerId)) {
    return { callerId, owner: { kind: 'dispatcher' }, canSee: (a) => canSeeAction(a, { kind: 'dispatcher' }), canChange: (a) => a.owner.kind === 'group_project' ? groupAdmin(callerId, a.owner.groupProjectId, groupApproved) : a.owner.kind !== 'app' };
  }
  if (isTrackedDispatcher(callerId)) {
    throw new ActionError('not_allowed', 'The Dispatcher is turned off, so it can’t manage actions.');
  }
  const kind = mcpCallerKind(callerId);
  if (kind === 'quick') {
    throw new ActionError('not_allowed', 'Quick agents can’t own actions, because they end when their task does. Ask the person or the agent that started you to set one up.');
  }
  const helper = kind === 'helper' || !!knownAgent(callerId)?.parentAgentId;
  const owner: ActionOwner = { kind: 'agent', agentId: callerId, ...(helper && { helper: true }) };
  return {
    callerId,
    owner,
    // Agents read every action people and agents can see, but change and run
    // only their own: running a person's action would act at the person's access.
    canSee: (a) => canSeeAction(a, owner),
    canChange: (a) => a.owner.kind === 'group_project' ? groupAdmin(callerId, a.owner.groupProjectId, groupApproved) : a.owner.kind === 'agent' && a.owner.agentId === callerId,
  };
}

// ── Results ─────────────────────────────────────────────────────────────────

function json(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function actionToolError(code: ActionToolErrorCode, message: string): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }], isError: true };
}

/** The action as the UI has it, plus one line in plain words. */
function present(view: ActionView, reader: ActionOwner): ActionView & { description: string } {
  const { lastRun: _lastRun, ...action } = view;
  const lastRun = actions.actionHistory(view.id, reader)[0];
  return { ...action, ...(lastRun && { lastRun }), description: describeAction(view, actions.actionNames()) };
}

const NOT_FOUND = 'No action with that id.';

/** One action the caller may see. Not seeing it and it not existing read the same. */
function findVisible(scope: ActionScope, id: string): ActionView {
  const view = actions.getAction(id);
  if (!view || !scope.canSee(view)) throw new ActionError('not_found', NOT_FOUND);
  return view;
}

/** One action the caller may change or run: its own (the Dispatcher: any). */
function findChangeable(scope: ActionScope, id: string): ActionView {
  const view = findVisible(scope, id);
  if (!scope.canChange(view)) {
    throw new ActionError('not_allowed', 'You can only change, delete or run actions you made. Ask the person to change this one.');
  }
  return view;
}

function idArg(args: Record<string, unknown>): string {
  const id = args.id;
  if (typeof id !== 'string' || !id.trim()) throw new ActionError('invalid_input', 'id is required: the action’s id, from list_actions.');
  return id.trim();
}

// ── Input ───────────────────────────────────────────────────────────────────
//
// Conveniences on top of the shared model, so an agent doesn't need ids it
// can't see: "self" for its own agent id, a project by name or path, its own
// project when a quick agent step or a project source leaves it out, and a
// schedule preset by hour and minute instead of its cron line. Everything
// else passes through to the shared checks unchanged.

const SELF = 'self';

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

interface InputContext {
  /** The calling agent's id, or undefined for the Dispatcher. */
  agentId?: string;
}

function agentRef(value: unknown, ctx: InputContext): unknown {
  if (value !== SELF) return value;
  if (!ctx.agentId) throw new ActionError('invalid_input', '"self" means the calling agent, and the Dispatcher can’t be a step’s target or an event source. Name an agent by id.');
  return ctx.agentId;
}

function projectRef(value: unknown, ctx: InputContext, field: string): unknown {
  const own = ctx.agentId ? actions.projectIdOfAgent(ctx.agentId) : undefined;
  if (value === undefined || value === null || value === '') {
    if (own) return own;
    throw new ActionError('invalid_input', `${field} is required: a project id, name or path.`);
  }
  if (typeof value !== 'string') return value;
  // An agent resolves only its own project, so a name never tells it whether another exists.
  const id = actions.findProjectId(value, ctx.agentId ? (p) => p === own : undefined);
  if (!id) throw new ActionError('invalid_input', 'No project you can use has that id, name or path.');
  return id;
}

/** A one-time action's time: epoch ms, or a local date and time. Never in the past. */
function onceAt(value: unknown): unknown {
  let at = value;
  if (typeof value === 'string') {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    // Date.parse reads a bare date as UTC midnight; a person means local midnight.
    at = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime() : Date.parse(value);
    if (!Number.isFinite(at)) throw new ActionError('invalid_input', `"${value}" isn’t a date and time. Use a form like 2026-11-08T09:00.`);
  }
  if (typeof at === 'number' && at < Date.now()) throw new ActionError('invalid_input', 'That time has already passed. Pick a time in the future.');
  return at;
}

/** A whole number in range, the fallback when left out, or invalid_input. */
function numberIn(v: unknown, field: string, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max) return v;
  throw new ActionError('invalid_input', `${field} must be a whole number from ${min} to ${max}.`);
}

function prepareTrigger(raw: unknown, ctx: InputContext): unknown {
  if (!isObject(raw)) return raw;
  const t: Obj = { ...raw };
  if (t.kind === 'schedule' && (t.cron === undefined || t.cron === null || t.cron === '')) {
    const preset = t.preset as SchedulePreset;
    if (!SCHEDULE_PRESETS.includes(preset) || preset === 'cron') {
      throw new ActionError('invalid_input', 'A schedule needs a preset (daily, weekdays, weekly or hourly) with hour and minute, or a cron line.');
    }
    const fields = {
      hour: numberIn(t.hour, 'hour', 0, 23, DEFAULT_PRESET_FIELDS.hour),
      minute: numberIn(t.minute, 'minute', 0, 59, DEFAULT_PRESET_FIELDS.minute),
      weekday: numberIn(t.weekday, 'weekday', 0, 6, DEFAULT_PRESET_FIELDS.weekday),
    };
    t.cron = presetToCron(preset, fields);
  }
  if (t.kind === 'once') t.at = onceAt(t.at);
  if (t.kind === 'event' && isObject(t.source)) {
    const source: Obj = { ...t.source };
    // App and project events take no source, or may name one project.
    const appEvent = typeof t.event === 'string' && (t.event.startsWith('app.') || t.event.startsWith('project.'));
    if (source.kind === 'agent') source.agentId = agentRef(source.agentId, ctx);
    if (source.kind === 'project' && (!appEvent || typeof source.projectId === 'string')) {
      source.projectId = projectRef(source.projectId, ctx, 'The event source’s projectId');
    }
    t.source = source;
  }
  return t;
}

function prepareSteps(raw: unknown, ctx: InputContext): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((step: unknown) => {
    if (!isObject(step)) return step;
    const s: Obj = { ...step };
    if ('agentId' in s) s.agentId = agentRef(s.agentId, ctx);
    if (s.kind === 'quick') {
      if ('worktreeAgentId' in s) s.worktreeAgentId = agentRef(s.worktreeAgentId, ctx);
      // A step in another agent's worktree runs in that agent's project.
      const worktreeProject = typeof s.worktreeAgentId === 'string' && !s.projectId ? actions.projectIdOfAgent(s.worktreeAgentId) : undefined;
      s.projectId = worktreeProject ?? projectRef(s.projectId, ctx, 'A quick agent step’s projectId');
    }
    return s;
  });
}

function contextFor(scope: ActionScope): InputContext {
  return scope.owner.kind === 'agent' ? { agentId: scope.owner.agentId } : {};
}

const INPUT_FIELDS = ['name', 'trigger', 'steps', 'overlap', 'enabled', 'endsAt', 'maxRuns'] as const;

function prepareEndsAt(value: unknown): unknown {
  return value === undefined || value === null ? value : onceAt(value);
}

// ── Handlers ────────────────────────────────────────────────────────────────

function createAction(scope: ActionScope, args: Obj): unknown {
  let owner = scope.owner;
  if (args.groupProjectId !== undefined) {
    if (typeof args.groupProjectId !== 'string' || !scope.canChange({ owner: { kind: 'group_project', groupProjectId: args.groupProjectId } })) throw new ActionError('not_allowed', 'A group-project Admin grant on the host is required.');
    owner = { kind: 'group_project', groupProjectId: args.groupProjectId };
  }
  const ctx = owner.kind === 'group_project' ? {} : contextFor(scope);
  const input: Obj = {};
  for (const key of INPUT_FIELDS) if (args[key] !== undefined) input[key] = args[key];
  input.trigger = prepareTrigger(args.trigger, ctx);
  input.steps = prepareSteps(args.steps, ctx);
  input.endsAt = prepareEndsAt(args.endsAt);
  return { action: present(owner.kind === 'group_project' ? actions.createAction(input, owner, scope.owner) : actions.createAction(input, owner), scope.owner) };
}

/**
 * A subscription's trigger from the tool's flat arguments. Left out, the
 * source is Clubhouse for app and project events, and the caller's own
 * project for the rest (the Dispatcher has no project, so it names one).
 */
function subscriptionTrigger(args: Obj, ctx: InputContext): unknown {
  const event = args.event;
  const appEvent = typeof event === 'string' && (event.startsWith('app.') || event.startsWith('project.'));
  let source = args.source;
  if (source === undefined || source === null) {
    if (typeof event === 'string' && event.startsWith('device.')) source = { kind: 'device' };
    else if (appEvent) source = { kind: 'app' };
    else if (ctx.agentId) source = { kind: 'project' };
    else throw new ActionError('invalid_input', 'source is required: the agent to watch, as {"kind":"agent","agentId":...}.');
  }
  return prepareTrigger({
    kind: 'event',
    event,
    source,
    ...(args.branch !== undefined && { branch: args.branch }),
    ...(args.delayMinutes !== undefined && { delayMinutes: args.delayMinutes }),
    ...(args.delaySeconds !== undefined && { delaySeconds: args.delaySeconds }),
    ...(args.absenceMinutes !== undefined && { absenceMinutes: args.absenceMinutes }),
    ...(args.afterLocalTime !== undefined && { afterLocalTime: args.afterLocalTime }),
    ...(args.oncePerDay !== undefined && { oncePerDay: args.oncePerDay }),
    ...(args.coalesceSeconds !== undefined && { coalesceSeconds: args.coalesceSeconds }),
    ...(args.throttle !== undefined && { throttle: args.throttle }),
  }, ctx);
}

function subscribe(scope: ActionScope, args: Obj): unknown {
  const ctx = contextFor(scope);
  const input = {
    trigger: subscriptionTrigger(args, ctx),
    ...(args.note !== undefined && { note: args.note }),
    ...(args.name !== undefined && { name: args.name }),
  };
  return { action: present(actions.subscribe(input, scope.owner), scope.owner) };
}

function listActions(scope: ActionScope): unknown {
  const visible = actions.listActions().filter((a) => scope.canSee(a)).map((a) => present(a, scope.owner));
  return { count: visible.length, actions: visible };
}

function updateAction(scope: ActionScope, args: Obj): unknown {
  const id = idArg(args);
  const current = findChangeable(scope, id);
  const changes = INPUT_FIELDS.filter((key) => args[key] !== undefined);
  if (changes.length === 0) throw new ActionError('invalid_input', 'Nothing to change. Pass name, trigger, steps, overlap, enabled, endsAt or maxRuns.');
  // Only turning it on or off: the same as the switch in Settings.
  if (changes.length === 1 && changes[0] === 'enabled') {
    if (typeof args.enabled !== 'boolean') throw new ActionError('invalid_input', 'enabled must be true or false.');
    return { action: present(current.owner.kind === 'group_project' ? actions.setActionEnabled(id, args.enabled, scope.owner) : actions.setActionEnabled(id, args.enabled), scope.owner) };
  }
  const ctx = current.owner.kind === 'group_project' ? {} : contextFor(scope);
  // A name that was the suggestion for the old trigger and steps follows them.
  const suggested = current.name === suggestActionName(current, actions.actionNames());
  const followsSuggestion = args.name === undefined && suggested && (args.trigger !== undefined || args.steps !== undefined);
  // Fields left out keep their current value. The owner always stays.
  const input = {
    name: args.name !== undefined ? args.name : followsSuggestion ? undefined : current.name,
    trigger: args.trigger !== undefined ? prepareTrigger(args.trigger, ctx) : current.trigger,
    steps: args.steps !== undefined ? prepareSteps(args.steps, ctx) : current.steps,
    overlap: args.overlap !== undefined ? args.overlap : current.overlap,
    enabled: args.enabled !== undefined ? args.enabled : current.enabled,
    endsAt: args.endsAt !== undefined ? prepareEndsAt(args.endsAt) : current.endsAt,
    maxRuns: args.maxRuns !== undefined ? args.maxRuns : current.maxRuns,
  };
  return { action: present(current.owner.kind === 'group_project' ? actions.updateAction(id, input, scope.owner) : actions.updateAction(id, input), scope.owner) };
}

function deleteAction(scope: ActionScope, args: Obj): unknown {
  const id = idArg(args);
  const current = findChangeable(scope, id);
  actions.deleteAction(id);
  return { deleted: { id, name: current.name } };
}

function runAction(scope: ActionScope, args: Obj): unknown {
  const id = idArg(args);
  const current = findChangeable(scope, id);
  const { runId } = current.owner.kind === 'group_project' ? actions.runActionNow(id, scope.owner) : actions.runActionNow(id);
  const view = actions.getAction(id);
  return {
    runId,
    note: 'The run goes on in the background. Read action_history for how it went.',
    ...(view && { action: present(view, scope.owner) }),
  };
}

function actionHistory(scope: ActionScope, args: Obj): unknown {
  const id = idArg(args);
  const view = actions.getAction(id);
  if (view) {
    if (!scope.canSee(view)) throw new ActionError('not_found', NOT_FOUND);
    return { actionId: id, action: present(view, scope.owner), runs: actions.actionHistory(id, scope.owner) };
  }
  // A one-time action deletes itself after it runs, and its history stays.
  // Each run keeps its owner; runs from before that are the Dispatcher's to read.
  const runs = actions.actionHistory(id, scope.owner).filter((r) => (r.owner ? scope.canSee({ owner: r.owner }) : scope.owner.kind === 'dispatcher'));
  if (runs.length === 0) throw new ActionError('not_found', NOT_FOUND);
  return { actionId: id, runs };
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const TRIGGER_SCHEMA = {
  type: 'object',
  description: 'Schedule, once, or event. Timing: none, delaySeconds/delayMinutes (debounce and re-check), or coalesceSeconds (fixed window). Throttle composes. Any watches readable durable and quick agents.',
  properties: {
    kind: { type: 'string', enum: ['schedule', 'once', 'event'] },
    preset: { type: 'string', enum: [...SCHEDULE_PRESETS], description: 'Schedules: daily, weekdays, weekly, hourly, or cron for Custom (cron).' },
    hour: { type: 'number', description: 'Schedules with a preset: hour, 0 to 23. Unused by hourly. Default 9.' },
    minute: { type: 'number', description: 'Schedules with a preset: minute, 0 to 59. Default 0.' },
    weekday: { type: 'number', description: 'Weekly schedules: 0 (Sunday) to 6 (Saturday). Default 1.' },
    cron: { type: 'string', description: 'Schedules: a 5-field cron line in local time. Required for preset "cron"; filled in from hour and minute for the others.' },
    missed: { type: 'string', enum: [...MISSED_RUN_RULES], description: 'Schedules: skip (default), once or each.' },
    absenceMinutes: { type: 'number', minimum: MIN_ABSENCE_MINUTES, description: 'app.returned only: required absence in whole minutes, at least 5. Default 30. Tracking runs only while an enabled action uses this event.' },
    afterLocalTime: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: 'Events only: run at or after this local wall-clock time, HH:MM. Events before it are ignored. Delayed and queued starts recheck the time. Also applies to Run now.' },
    oncePerDay: { type: 'boolean', description: 'Events only: once per calendar day; moving the clock back gives no extra run. Starts consume the day, including Run now and failures. Skips do not. Saved across restarts.' },
    coalesceSeconds: { type: 'number', minimum: MIN_COALESCE_SECONDS, maximum: MAX_COALESCE_SECONDS, description: 'Events: fixed 10 to 600 second window from the first event. Devices group separately. No delay or replay. Any-agent turns and quick finishes default to 60 and list unique readable agents.' },
    throttle: {
      type: 'object', description: 'Events: per-Action sliding cap across all sources, including Run now and failures. Throttled skips consume no lifetime runs or calendar day. Composes with delay or coalescing.',
      properties: {
        maxRuns: { type: 'number', minimum: 1, description: 'Maximum started runs in the sliding window, a positive whole number.' },
        perMinutes: { type: 'number', minimum: 1, maximum: MAX_DELAY_MINUTES, description: 'Sliding window length in whole minutes, up to one week. Saved across restarts.' },
      },
      required: ['maxRuns', 'perMinutes'],
    },
    at: { type: ['string', 'number'], description: 'Once: a date and time like 2026-11-08T09:00 (local time when no zone is given; a date alone is local midnight), or epoch milliseconds. Must be in the future.' },
    event: { type: 'string', enum: [...ACTION_EVENT_KINDS], description: 'Events: what should happen.' },
    source: {
      type: 'object',
      description: 'Agent: agentId/self. Project: projectId/name/path. App: kind app. Any: turns/quick finishes, needs agent.watch and agent.read. Device: optional deviceId/deviceKind, needs device.read.',
      properties: {
        kind: { type: 'string', enum: ['agent', 'project', 'group_project', 'app', 'any', 'device'] },
        agentId: { type: 'string' },
        projectId: { type: 'string' },
        groupProjectId: { type: 'string', description: 'Group project whose board is watched.' },
        topic: { type: 'string', description: 'For message-posted events, an optional topic filter.' },
        deviceId: { type: 'string', description: 'Devices only: one id from list_devices. Left out means any device directly seen by this computer.' },
        deviceKind: { type: 'string', enum: ['computer', 'phone'], description: 'Devices only: filter to computers or phones. May be combined with deviceId.' },
      },
    },
    delayMinutes: { type: 'number', minimum: 1, maximum: MAX_DELAY_MINUTES, description: 'Events: whole-minute trailing debounce. New events restart it; re-check when it ends. Survives restart. Required for idle unless using delaySeconds. No coalescing or any-agent source.' },
    delaySeconds: { type: 'number', minimum: 1, maximum: MAX_DELAY_MINUTES * 60, description: 'Events: whole-second debounce, up to one week. New events restart it; re-check when it ends. Devices wait separately. Survives restart. Use instead of delayMinutes. No coalescing or any-agent source.' },
    branch: { type: 'string', description: 'Git events: run only for this branch, e.g. "main".' },
  },
  required: ['kind'],
};

const STEPS_SCHEMA = {
  type: 'array',
  description: `Run 1 to ${MAX_ACTION_STEPS} steps in order, stopping at the first failure. Kinds: wake, message, quick, sleep, notify. Rights follow the owner and are rechecked. Busy messages queue by default; steer is optional.`,
  minItems: 1,
  maxItems: MAX_ACTION_STEPS,
  items: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...ACTION_STEP_KINDS] },
      agentId: { type: 'string', description: 'wake, message, sleep: the agent, by id, or "self".' },
      prompt: { type: 'string', description: 'wake: optional first message. quick: the quick agent\'s task.' },
      text: { type: 'string', description: 'message: the message. notify: the notice text.' },
      topic: { type: 'string', description: 'group_post: the board topic.' },
      delivery: { type: 'string', enum: ['queue', 'steer'], description: 'message: queue for the next turn (default), or steer like a user mid-turn message. Steer falls back to queue when unsupported. A sleeping target wakes with the message.' },
      latestOnly: { type: 'boolean', description: 'message: replace older queued messages from this Action with its newest queued message. Default off. Does not replace user messages or messages from other Actions.' },
      maxWaitMinutes: { type: 'number', minimum: 1, maximum: MAX_DELAY_MINUTES, description: 'message: maximum whole minutes undelivered in the queue, up to one week. Default no limit. On expiry the message is removed, logged and recorded as expired in run history.' },
      projectId: { type: 'string', description: 'quick: the project to run in, by id, name or path. Left out: the worktree agent\'s project, or your own.' },
      worktreeAgentId: { type: 'string', description: 'quick: run in this agent\'s worktree instead of the project root.' },
      orchestrator: { type: 'string', description: 'quick: a CLI, or "auto" for helper routing. Left out: the project\'s provider, as before.' },
      difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'], description: 'quick with orchestrator "auto": task difficulty. Default: medium.' },
      model: { type: 'string', description: 'quick: which model to use.' },
    },
    required: ['kind'],
  },
};

const ACTION_FIELDS = {
  groupProjectId: { type: 'string', description: 'Create for this group project on its host; requires its Admin grant.' },
  name: { type: 'string', description: 'Optional. Left out, a name is suggested from the trigger and first step.' },
  trigger: TRIGGER_SCHEMA,
  steps: STEPS_SCHEMA,
  overlap: {
    type: 'string',
    enum: ['skip', 'queue'],
    description: 'When the trigger fires while this action\'s last run is still going: skip (default) or queue (run it after the current run).',
  },
  enabled: { type: 'boolean', description: 'On (default) or off.' },
  endsAt: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }], description: 'Recurring actions: stop at a future absolute time, epoch ms or a date with timezone. A running run finishes normally. Pass null to remove.' },
  maxRuns: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }], description: 'Recurring actions: lifetime started-run limit, including Run now and failures. Skips, including throttled runs, do not count. runsUsed survives restarts and edits. Pass null to remove.' },
};

const ID_FIELD = { id: { type: 'string', description: 'The action\'s id, from list_actions.' } };

const RESULT_NOTE =
  'Results use the same model as Settings > Actions, plus "description", the action in plain words. ' +
  'Errors come back as {"error":{"code","message"}}, with code invalid_input, not_found, not_allowed, unavailable or internal.';

// ── Registration ────────────────────────────────────────────────────────────

type Handler = (scope: ActionScope, args: Obj) => unknown;

async function guarded(tool: ActionToolName, callerId: string, args: Obj, handler: Handler): Promise<McpToolResult> {
  try {
    let scope: ActionScope;
    const run = async () => {
      const options = tool === 'create_action' ? CREATE : tool === 'update_action' ? UPDATE_ONE : tool === 'delete_action' ? WRITE_ONE : tool === 'run_action' ? RUN_ONE : undefined;
      let approved = false;
      if (options) {
        const targets = await resolveArgTargets(callerId, options.grant, args);
        const check = checkToolGrant(callerId, options.grant, args, undefined, targets);
        approved = check.ok === false && check.reason === 'ask_first' && check.asks.some((ask) => ask.action === 'group_project.admin')
          && callGrantIsApproved(callerId, tool, args, check, grantApprovalContext(callerId, tool, args, options.grant, targets));
      }
      scope = actionScope(callerId, approved);
      return handler(scope, args);
    };
    const value = tool === 'create_action' && typeof args.groupProjectId === 'string'
      ? await actions.withGroupActionLock(args.groupProjectId, run)
      : (tool === 'update_action' || tool === 'delete_action' || tool === 'run_action') && typeof args.id === 'string'
        ? await actions.changeActionOnHost(args.id, run) : await run();
    const result = json(value);
    if (scope!.owner.kind === 'dispatcher' && (tool === 'create_action' || tool === 'update_action' || tool === 'subscribe')
      && isObject(value) && isObject(value.action) && typeof value.action.id === 'string') {
      const action = actions.getAction(value.action.id);
      if (action) {
        try {
          const { showDispatcherActionSummary } = await import('../../dispatcher/dispatcher-action-summary');
          await showDispatcherActionSummary(action, actions.actionNames());
        } catch (err) {
          // telemetry-exempt: the change already succeeded; a failed receipt must not invite a duplicate create.
          appLog('core:dispatcher', 'warn', 'Could not show an Action summary', { meta: { error: err instanceof Error ? err.message : String(err) } });
        }
      }
    }
    appLog('core:mcp', 'info', `${tool}: done`, { meta: { agentId: callerId, scope: scope.owner.kind } });
    return result;
  } catch (err) {
    if (err instanceof ActionError) {
      // telemetry-exempt: the refusal reaches the caller as the tool result
      appLog('core:mcp', 'info', `${tool}: refused`, { meta: { agentId: callerId, code: err.code } });
      return actionToolError(err.code === 'hidden' ? 'not_found' : err.code, err.code === 'hidden' ? NOT_FOUND : err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    // telemetry-exempt: the error reaches the caller as the tool result
    appLog('core:mcp', 'warn', `${tool} failed`, { meta: { agentId: callerId, error: message } });
    return actionToolError('internal', message);
  }
}

/** Listed for agents that can own actions: not quick agents, nor a turned-off Dispatcher. */
/**
 * Grant declarations (#2967): listing, reading history and creating are on
 * `app` (agents read every action); changing and running one action are on
 * that action (`action_arg`), so the
 * evaluator can tell the caller's own actions from a person's or another
 * agent's. Until it reads these (#2921), actionScope and rights.ts enforce
 * the same: read all, change and run only your own.
 */
const LIST = { group: 'actions', grant: { actions: ['action.read'], target: 'app' } } as const;
// Ask first cannot authorize unattended watching: rights.ts explains that a saved Allow is needed.
const WATCH_ACTIVITY = { actions: ['agent.watch'], target: 'app', ifAnyAgentSource: true, askHandledByTool: true } as const;
const SUBSCRIBE = { group: 'actions', grant: [{ actions: ['action.write'], target: 'app' }, WATCH_ACTIVITY] } as const;
const CREATE = { group: 'actions', grant: [...SUBSCRIBE.grant, { actions: ['group_project.admin'], target: 'group_project_arg', ifArgs: ['groupProjectId'], strictTargets: true, requiresGroupMembership: true, from: { args: ['groupProjectId'] } }] } as const;
// Trigger/step grants are rechecked by rights.ts, not granted by action.write.
// The action named in the arguments: its owner tells the caller's own from others'.
const GROUP_OWNER_ADMIN = { actions: ['group_project.admin'], target: 'action_group_project' } as const;
const WRITE_ONE = { group: 'actions', grant: [{ actions: ['action.write'], target: 'action_arg' }, GROUP_OWNER_ADMIN] } as const;
const UPDATE_ONE = { group: 'actions', grant: [...WRITE_ONE.grant, WATCH_ACTIVITY] } as const;
const RUN_ONE = { group: 'actions', grant: [{ actions: ['action.run'], target: 'action_arg' }, GROUP_OWNER_ADMIN] } as const;

function schema(properties: Obj, required: string[] = []): McpToolDefinition['inputSchema'] {
  return { type: 'object', properties, ...(required.length > 0 && { required }) };
}

/**
 * Who owns the action a call names, for the grant check (#2921): an agent's
 * own action is `self`, anyone else's needs a grant on it. A person's or the
 * Dispatcher's action has no owning agent; an unknown id (or Clubhouse's own
 * action) is undefined, refused like someone else's.
 */
export function actionOwnerFromArgs(args: Record<string, unknown>): { actionId: string; ownerAgentId?: string; groupProjectId?: string } | undefined {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return undefined;
  let view: ActionView | undefined;
  try {
    view = actions.getAction(id);
  } catch {
    // telemetry-exempt: Actions still starting; the call is refused and the tool says why
    return undefined;
  }
  if (!view) return undefined;
  return { actionId: view.id, ...(view.owner.kind === 'agent' && { ownerAgentId: view.owner.agentId }), ...(view.owner.kind === 'group_project' && { groupProjectId: view.owner.groupProjectId }) };
}

export function registerActionTools(): void {
  registerActionOwnerLookup(actionOwnerFromArgs);
  registerGlobalTool(
    'create_action',
    {
      description:
        'Create an action: a workflow Clubhouse runs on a schedule, when something happens, or once, whenever the app is open. ' +
        'You own it, and its usage counts toward you. It shows in Settings > Actions with you as owner. Dispatcher changes also show a summary in its chat. ' +
        'An agent may own up to 20 actions, a helper 5 and the Dispatcher 50. ' +
        RESULT_NOTE,
      inputSchema: schema(ACTION_FIELDS, ['trigger', 'steps']),
    },
    (callerId, args) => guarded('create_action', callerId, args, createAction),
    CREATE,
  );
  registerGlobalTool(
    'list_actions',
    {
      description:
        'List the actions you can manage, each with its trigger, steps, on or off state (with the reason when Clubhouse turned it off), ' +
        'any problem from its last run, next run time and last run, and optional endsAt, maxRuns and lifetime runsUsed. You see every action; you can change and run only those you made. ' + RESULT_NOTE,
      inputSchema: schema({}),
    },
    (callerId, args) => guarded('list_actions', callerId, args, (scope) => listActions(scope)),
    LIST,
  );
  registerGlobalTool(
    'update_action',
    {
      description:
        'Change an action. Pass only the fields to change; the rest keep their current value. trigger and steps replace the whole ' +
        'trigger or step list. Pass just enabled to turn it on or off. The owner never changes, and its rights are checked again. ' +
        'Pass an empty name to get a suggested one. ' + RESULT_NOTE,
      inputSchema: schema({ ...ID_FIELD, ...ACTION_FIELDS }, ['id']),
    },
    (callerId, args) => guarded('update_action', callerId, args, updateAction),
    UPDATE_ONE,
  );
  registerGlobalTool(
    'delete_action',
    {
      description:
        'Delete an action. Its run history stays until it ages out. To stop it for now and keep it, use update_action with enabled false. ' +
        RESULT_NOTE,
      inputSchema: schema(ID_FIELD, ['id']),
    },
    (callerId, args) => guarded('delete_action', callerId, args, deleteAction),
    WRITE_ONE,
  );
  registerGlobalTool(
    'run_action',
    {
      description:
        'Run an action now, as a normal run, to test it. Works on an action that is off. The usual limits apply: a run still going is ' +
        'skipped or queued by its overlap rule, and an action runs at most 60 times an hour. ' + RESULT_NOTE,
      inputSchema: schema(ID_FIELD, ['id']),
    },
    (callerId, args) => guarded('run_action', callerId, args, runAction),
    RUN_ONE,
  );
  registerGlobalTool(
    'action_history',
    {
      description:
        'Read an action\'s recent runs, newest first: what set it off, the outcome (done, failed, cancelled, skipped, throttled or expired) with one line ' +
        'of reason, and what each step did. History keeps at most the last 10 runs within 72 hours. ' + RESULT_NOTE,
      inputSchema: schema(ID_FIELD, ['id']),
    },
    (callerId, args) => guarded('action_history', callerId, args, actionHistory),
    LIST,
  );
  registerGlobalTool(
    'subscribe',
    {
      description:
        'Subscribe to an event. Clubhouse messages you what happened with your note, waking you if needed. ' +
        'Watching any readable agent, including quick agents, is allowed by default for the Dispatcher and can be turned off in its Clubhouse permissions. ' +
        'You own the action in Settings > Actions. Stop it with delete_action, or pause it with update_action and enabled false. ' + RESULT_NOTE,
      inputSchema: schema({
        event: TRIGGER_SCHEMA.properties.event,
        source: {
          ...TRIGGER_SCHEMA.properties.source,
          description:
            'Agent or project by id. Any: turns/quick finishes, needs agent.watch and agent.read. Device: optional deviceId/deviceKind, needs device.read. Default: your project, app or devices.',
        },
        branch: TRIGGER_SCHEMA.properties.branch,
        delayMinutes: TRIGGER_SCHEMA.properties.delayMinutes,
        delaySeconds: TRIGGER_SCHEMA.properties.delaySeconds,
        absenceMinutes: TRIGGER_SCHEMA.properties.absenceMinutes,
        afterLocalTime: TRIGGER_SCHEMA.properties.afterLocalTime,
        oncePerDay: TRIGGER_SCHEMA.properties.oncePerDay,
        coalesceSeconds: TRIGGER_SCHEMA.properties.coalesceSeconds,
        throttle: TRIGGER_SCHEMA.properties.throttle,
        note: { type: 'string', description: 'Optional. What the message should remind you of, e.g. "Tag the release." Left out, it says you asked to be told.' },
        name: ACTION_FIELDS.name,
      }, ['event']),
    },
    (callerId, args) => guarded('subscribe', callerId, args, subscribe),
    SUBSCRIBE,
  );
}
