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

import { registerGlobalTool } from '../tool-registry';
import { registerActionOwnerLookup } from '../grant-check';
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
} as const;

export type ActionToolName = keyof typeof ACTION_TOOL_PERMISSIONS;

/** ActionError codes, plus `internal` for something that broke. */
export type ActionToolErrorCode = ActionErrorCode | 'internal';

// ── Scope ───────────────────────────────────────────────────────────────────

export interface ActionScope {
  /** Owner of the actions this caller creates. */
  owner: ActionOwner;
  /** Whether the caller may see and change this action. */
  /** Whether the caller may read this action (list, history). */
  canSee(action: Pick<Action, 'owner'>): boolean;
  /** Whether the caller may change, delete or run it. */
  canChange(action: Pick<Action, 'owner'>): boolean;
}

/**
 * Who the caller is to Actions. Interim rule until the permission model's
 * grants land (#2921):
 * - The Dispatcher owns what it creates, and sees and changes every action
 *   people and agents can see.
 * - Any other agent owns what it creates, and sees and changes only those.
 * - A helper's actions are marked as a helper's: its steps may act only on
 *   itself (rights.ts), and they are deleted when it is disposed.
 * - A quick agent can't own actions: it ends when its task does.
 * What each step may do and what a trigger may watch, and how many actions
 * an owner may have, are the rest of the interim rule: rights.ts, which the
 * engine checks on create, update, turning on and every run.
 */
export function actionScope(callerId: string): ActionScope {
  if (isDispatcherAgent(callerId)) {
    return { owner: { kind: 'dispatcher' }, canSee: (a) => a.owner.kind !== 'app', canChange: (a) => a.owner.kind !== 'app' };
  }
  if (isTrackedDispatcher(callerId)) {
    throw new ActionError('not_allowed', 'The Dispatcher is turned off, so it can’t manage actions.');
  }
  const kind = mcpCallerKind(callerId);
  if (kind === 'quick') {
    throw new ActionError('not_allowed', 'Quick agents can’t own actions, because they end when their task does. Ask the person or the agent that started you to set one up.');
  }
  const helper = kind === 'helper' || !!knownAgent(callerId)?.parentAgentId;
  return {
    owner: { kind: 'agent', agentId: callerId, ...(helper && { helper: true }) },
    // Agents read every action people and agents can see, but change and run
    // only their own: running a person's action would act at the person's access.
    canSee: (a) => a.owner.kind !== 'app',
    canChange: (a) => a.owner.kind === 'agent' && a.owner.agentId === callerId,
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
function present(view: ActionView): ActionView & { description: string } {
  return { ...view, description: describeAction(view, actions.actionNames()) };
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

const INPUT_FIELDS = ['name', 'trigger', 'steps', 'overlap', 'enabled'] as const;

// ── Handlers ────────────────────────────────────────────────────────────────

function createAction(scope: ActionScope, args: Obj): unknown {
  const ctx = contextFor(scope);
  const input: Obj = {};
  for (const key of INPUT_FIELDS) if (args[key] !== undefined) input[key] = args[key];
  input.trigger = prepareTrigger(args.trigger, ctx);
  input.steps = prepareSteps(args.steps, ctx);
  return { action: present(actions.createAction(input, scope.owner)) };
}

function listActions(scope: ActionScope): unknown {
  const visible = actions.listActions().filter((a) => scope.canSee(a)).map(present);
  return { count: visible.length, actions: visible };
}

function updateAction(scope: ActionScope, args: Obj): unknown {
  const id = idArg(args);
  const current = findChangeable(scope, id);
  const changes = INPUT_FIELDS.filter((key) => args[key] !== undefined);
  if (changes.length === 0) throw new ActionError('invalid_input', 'Nothing to change. Pass the fields to change: name, trigger, steps, overlap or enabled.');
  // Only turning it on or off: the same as the switch in Settings.
  if (changes.length === 1 && changes[0] === 'enabled') {
    if (typeof args.enabled !== 'boolean') throw new ActionError('invalid_input', 'enabled must be true or false.');
    return { action: present(actions.setActionEnabled(id, args.enabled)) };
  }
  const ctx = contextFor(scope);
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
  };
  return { action: present(actions.updateAction(id, input)) };
}

function deleteAction(scope: ActionScope, args: Obj): unknown {
  const id = idArg(args);
  const current = findChangeable(scope, id);
  actions.deleteAction(id);
  return { deleted: { id, name: current.name } };
}

function runAction(scope: ActionScope, args: Obj): unknown {
  const id = idArg(args);
  findChangeable(scope, id);
  const { runId } = actions.runActionNow(id);
  const view = actions.getAction(id);
  return {
    runId,
    note: 'The run goes on in the background. Read action_history for how it went.',
    ...(view && { action: present(view) }),
  };
}

function actionHistory(scope: ActionScope, args: Obj): unknown {
  const id = idArg(args);
  const view = actions.getAction(id);
  if (view) {
    if (!scope.canSee(view)) throw new ActionError('not_found', NOT_FOUND);
    return { actionId: id, action: present(view), runs: actions.actionHistory(id) };
  }
  // A one-time action deletes itself after it runs, and its history stays.
  // Each run keeps its owner; runs from before that are the Dispatcher's to read.
  const runs = actions.actionHistory(id).filter((r) => (r.owner ? scope.canSee({ owner: r.owner }) : scope.owner.kind === 'dispatcher'));
  if (runs.length === 0) throw new ActionError('not_found', NOT_FOUND);
  return { actionId: id, runs };
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const TRIGGER_SCHEMA = {
  type: 'object',
  description:
    'When the action runs. Three kinds:\n' +
    '- On a schedule, in local time: {"kind":"schedule","preset":"weekdays","hour":9,"minute":0}. ' +
    'Presets: daily (every day), weekdays (Monday to Friday), weekly (with weekday), hourly (at minute past each hour). ' +
    'For anything else use preset "cron" with a 5-field cron line, e.g. {"kind":"schedule","preset":"cron","cron":"30 8 * * 1,3"}; ' +
    'this is the Custom (cron) option and should not be the default. ' +
    '"missed" says what to do with times that passed while Clubhouse was closed or the machine slept: ' +
    'skip (default), once (run once when Clubhouse opens), or each (run each missed time, up to 10).\n' +
    '- Once, at a set time: {"kind":"once","at":"2026-11-08T09:00"} (local time, or epoch milliseconds). ' +
    'It deletes itself after it runs. If Clubhouse is closed then, it runs when Clubhouse next opens.\n' +
    '- When something happens: {"kind":"event","event":"agent.slept","source":{"kind":"agent","agentId":"self"},"delayMinutes":30}. ' +
    'source is one agent ({"kind":"agent","agentId":...}) or any agent in a project ({"kind":"project","projectId":...}); ' +
    'app events take no source, and project events may name one project. ' +
    'Agent events: agent.woke, agent.slept, agent.created, agent.deleted, agent.turn_ended, agent.turn_failed, ' +
    'agent.idle (needs delayMinutes: the idle time), agent.waiting (waits on the person), agent.error, agent.compacted, ' +
    'helper.finished. Git events (local only, nothing is fetched): git.commit, git.branch_switched, ' +
    'git.remote_updated (pushed, pulled or fetched), with an optional branch filter. ' +
    'App events: app.started, project.added, project.removed. ' +
    'What an action may watch follows the same rights as its steps: an agent may watch itself, its helpers, agents it is connected to ' +
    'and its own project; a helper only itself; the Dispatcher agents connected to it and app events. ' +
    `delayMinutes (up to ${MAX_DELAY_MINUTES}) waits before running; when the wait ends the condition is checked again, ` +
    'and the run is cancelled if it no longer holds (for example the agent woke up again). The wait starts over on the next matching event.',
  properties: {
    kind: { type: 'string', enum: ['schedule', 'once', 'event'] },
    preset: { type: 'string', enum: [...SCHEDULE_PRESETS], description: 'Schedules: daily, weekdays, weekly, hourly, or cron for Custom (cron).' },
    hour: { type: 'number', description: 'Schedules with a preset: hour, 0 to 23. Unused by hourly. Default 9.' },
    minute: { type: 'number', description: 'Schedules with a preset: minute, 0 to 59. Default 0.' },
    weekday: { type: 'number', description: 'Weekly schedules: 0 (Sunday) to 6 (Saturday). Default 1.' },
    cron: { type: 'string', description: 'Schedules: a 5-field cron line in local time. Required for preset "cron"; filled in from hour and minute for the others.' },
    missed: { type: 'string', enum: [...MISSED_RUN_RULES], description: 'Schedules: skip (default), once or each.' },
    at: { type: ['string', 'number'], description: 'Once: a date and time like 2026-11-08T09:00 (local time when no zone is given; a date alone is local midnight), or epoch milliseconds. Must be in the future.' },
    event: { type: 'string', enum: [...ACTION_EVENT_KINDS], description: 'Events: what should happen.' },
    source: {
      type: 'object',
      description: 'Events: {"kind":"agent","agentId":"<id or self>"} or {"kind":"project","projectId":"<id, name or path>"}. For agents, a project left out means your own.',
      properties: {
        kind: { type: 'string', enum: ['agent', 'project', 'app'] },
        agentId: { type: 'string' },
        projectId: { type: 'string' },
      },
    },
    delayMinutes: { type: 'number', description: 'Events: minutes to wait, re-checking the condition when the wait ends.' },
    branch: { type: 'string', description: 'Git events: run only for this branch, e.g. "main".' },
  },
  required: ['kind'],
};

const STEPS_SCHEMA = {
  type: 'array',
  description:
    `What the action does: 1 to ${MAX_ACTION_STEPS} steps, run in order, stopping at the first one that couldn't run.\n` +
    '- {"kind":"wake","agentId":...,"prompt"?:...} wakes an agent, resuming its last session, with an optional first message.\n' +
    '- {"kind":"message","agentId":...,"text":...} messages an agent. A busy agent gets it on its next turn; a sleeping one is woken with it.\n' +
    '- {"kind":"quick","projectId"?:...,"worktreeAgentId"?:...,"prompt":...} starts a quick agent in a project\'s root, or in another agent\'s worktree. ' +
    'Optional overrides: orchestrator, model. It runs headless with Full access, so only an agent that itself runs at Full access may have quick steps.\n' +
    '- {"kind":"sleep","agentId":...} puts an agent to sleep.\n' +
    '- {"kind":"notify","text":...} sends the person a Clubhouse notification, following their notification settings.\n' +
    'agentId "self" means you. An agent\'s actions may act on itself, its helpers and agents it is connected to, and start quick agents ' +
    'in its own project; a helper\'s actions may act only on itself. The Dispatcher\'s actions may act on agents connected to it, ' +
    'and can\'t start quick agents. These rights are checked again on every run.',
  items: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...ACTION_STEP_KINDS] },
      agentId: { type: 'string', description: 'wake, message, sleep: the agent, by id, or "self".' },
      prompt: { type: 'string', description: 'wake: optional first message. quick: the quick agent\'s task.' },
      text: { type: 'string', description: 'message: the message. notify: the notice text.' },
      projectId: { type: 'string', description: 'quick: the project to run in, by id, name or path. Left out: the worktree agent\'s project, or your own.' },
      worktreeAgentId: { type: 'string', description: 'quick: run in this agent\'s worktree instead of the project root.' },
      orchestrator: { type: 'string', description: 'quick: which CLI to use. Default: the project\'s provider.' },
      model: { type: 'string', description: 'quick: which model to use.' },
    },
    required: ['kind'],
  },
};

const ACTION_FIELDS = {
  name: { type: 'string', description: 'Optional. Left out, a name is suggested from the trigger and first step.' },
  trigger: TRIGGER_SCHEMA,
  steps: STEPS_SCHEMA,
  overlap: {
    type: 'string',
    enum: ['skip', 'queue'],
    description: 'When the trigger fires while this action\'s last run is still going: skip (default) or queue (run it after the current run).',
  },
  enabled: { type: 'boolean', description: 'On (default) or off.' },
};

const ID_FIELD = { id: { type: 'string', description: 'The action\'s id, from list_actions.' } };

const RESULT_NOTE =
  'Results use the same model as Settings > Actions, plus "description", the action in plain words. ' +
  'Errors come back as {"error":{"code","message"}}, with code invalid_input, not_found, not_allowed, unavailable or internal.';

// ── Registration ────────────────────────────────────────────────────────────

type Handler = (scope: ActionScope, args: Obj) => unknown;

async function guarded(tool: ActionToolName, callerId: string, args: Obj, handler: Handler): Promise<McpToolResult> {
  try {
    const scope = actionScope(callerId);
    const result = json(handler(scope, args));
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
const CREATE = { group: 'actions', grant: { actions: ['action.write'], target: 'app' } } as const;
// The action named in the arguments: its owner tells the caller's own from others'.
const WRITE_ONE = { group: 'actions', grant: { actions: ['action.write'], target: 'action_arg' } } as const;
const RUN_ONE = { group: 'actions', grant: { actions: ['action.run'], target: 'action_arg' } } as const;

function schema(properties: Obj, required: string[] = []): McpToolDefinition['inputSchema'] {
  return { type: 'object', properties, ...(required.length > 0 && { required }) };
}

/**
 * Who owns the action a call names, for the grant check (#2921): an agent's
 * own action is `self`, anyone else's needs a grant on it. A person's or the
 * Dispatcher's action has no owning agent; an unknown id (or Clubhouse's own
 * action) is undefined, refused like someone else's.
 */
export function actionOwnerFromArgs(args: Record<string, unknown>): { actionId: string; ownerAgentId?: string } | undefined {
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
  return { actionId: view.id, ...(view.owner.kind === 'agent' && { ownerAgentId: view.owner.agentId }) };
}

export function registerActionTools(): void {
  registerActionOwnerLookup(actionOwnerFromArgs);
  registerGlobalTool(
    'create_action',
    {
      description:
        'Create an action: a workflow Clubhouse runs on a schedule, when something happens, or once, whenever the app is open. ' +
        'You own it, and its usage counts toward you. There is no notice to the person; it shows in Settings > Actions with you as owner. ' +
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
        'any problem from its last run, next run time and last run. You see every action; you can change and run only those you made. ' + RESULT_NOTE,
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
    WRITE_ONE,
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
        'Read an action\'s recent runs, newest first: what set it off, the outcome (done, failed, cancelled or skipped) with one line ' +
        'of reason, and what each step did. History keeps at most the last 10 runs within 72 hours. ' + RESULT_NOTE,
      inputSchema: schema(ID_FIELD, ['id']),
    },
    (callerId, args) => guarded('action_history', callerId, args, actionHistory),
    LIST,
  );
}
