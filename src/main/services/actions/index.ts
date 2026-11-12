/**
 * Actions service (#2918): the engine wired to the app. Runs in the main
 * process whenever the app is open, with or without a window or project.
 *
 * Callers: the IPC handlers (Settings > Actions, as the person), and the
 * Clubhouse MCP tools (as an agent or the Dispatcher). Clubhouse's own
 * actions (owner 'app') never appear in lists or history.
 */

import * as path from 'path';
import { uptime } from 'os';
import { app, BrowserWindow, powerMonitor } from 'electron';
import {
  ActionError,
  assertActionInput,
  subscriptionStep,
  summarizeActionUsage,
  type Action,
  type ActionNames,
  type ActionNotice,
  type ActionOwner,
  type ActionRun,
  type ActionView,
  type ActionOwnerUsage,
  type EventTrigger,
  type ValidActionInput,
} from '../../../shared/actions';
import { IPC } from '../../../shared/ipc-channels';
import type { Project } from '../../../shared/types';
import type { MessageDelivery } from '../../../shared/chat';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import { isAgentRunning } from '../agent-system';
import { onAppEvent, publishAppEvent } from '../app-event-bus';
import { knownAgent, knownAgents } from '../app-event-sources';
import { bindingManager } from '../clubhouse-mcp/binding-manager';
import { localConnectionWakeOn } from '../connection-grants-store';
import { isCrossProjectEnabled, isOrchestrationEnabled, orchestrationControl } from '../clubhouse-mcp/orchestration-gate';
import { isDispatcherEnabled } from '../dispatcher/dispatcher-settings';
import { sleepAgent, wakeWiredAgent } from '../clubhouse-mcp/tools/agent-lifecycle';
import { deliverToDispatcher, dispatcherInboxId } from '../clubhouse-mcp/tools/dispatcher-delivery';
import { clearDispatcherBackgroundWork, noteDispatcherBackgroundWork } from '../dispatcher/dispatcher-usage';
import { DISPATCHER_NAME, getDispatcherAgentId, getDispatcherState, isDispatcherAgentId, isDispatcherIdentityAgentId, isDispatcherPath } from '../dispatcher/dispatcher-service';
import { appLog } from '../log-service';
import * as notificationService from '../notification-service';
import * as projectStore from '../project-store';
import { startActionQuickAgent } from './quick-routing';
import { createActionsStorage, createRunHistory } from './actions-store';
import { ActionsEngine, type EngineFacts, type EngineObservation } from './engine';
import { matchProjectRef } from './project-ref';
import { createGrantRights } from './rights';
import { grantsFromFacts } from '../agent-grants-service';
import { actionMessage, createStepRunner, type DispatcherStepDelivery } from './steps';
import { ActionPresence } from './presence';
import { devicePresenceOnline } from '../annex-device-presence';
import { listDevices } from '../annex-devices';

export { ActionError };


// ── Facts from caches ───────────────────────────────────────────────────────

let projects: Project[] = [];

async function refreshProjects(): Promise<void> {
  try {
    projects = await projectStore.list();
  } catch (err) {
    // telemetry-exempt: logged; the last list stays in use
    appLog('core:actions', 'warn', 'Could not read projects', { meta: { error: err instanceof Error ? err.message : String(err) } });
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === 'linux' ? r : r.toLowerCase();
  };
  return norm(a) === norm(b);
}

function projectById(id: string): Project | undefined {
  return projects.find((p) => p.id === id);
}

function projectIdForPath(projectPath: string): string | undefined {
  return projects.find((p) => samePath(p.path, projectPath))?.id;
}

function projectLabel(p: Project): string {
  return p.displayName || p.name;
}

/** The Dispatcher's name, as people named it. It is in no project, so knownAgent doesn't have it. */
function dispatcherName(): string {
  return getDispatcherState().config?.name || DISPATCHER_NAME;
}

const facts: EngineFacts & { parentOf(id: string): string | undefined; agentWorktree(id: string): string | undefined } = {
  deviceOnline: devicePresenceOnline,
  // The Dispatcher counts as an agent here, so its subscriptions can message it (#3042).
  agentExists: (id) => !!knownAgent(id) || isDispatcherAgentId(id),
  isRunning: (id) => isAgentRunning(id),
  agentName: (id) => knownAgent(id)?.name ?? (isDispatcherAgentId(id) ? dispatcherName() : undefined),
  isQuickAgent: (id) => knownAgent(id)?.quick === true,
  agentProjectId: (id) => {
    const a = knownAgent(id);
    return a ? projectIdForPath(a.projectPath) : undefined;
  },
  projectName: (id) => {
    const p = projectById(id);
    return p ? projectLabel(p) : undefined;
  },
  projectIdForPath,
  repoOwner: (repoPath) => {
    for (const [agentId, a] of knownAgents()) {
      if (a.worktreePath && samePath(a.worktreePath, repoPath)) return { agentId, projectId: projectIdForPath(a.projectPath) };
    }
    return { projectId: projectIdForPath(repoPath) };
  },
  parentOf: (id) => knownAgent(id)?.parentAgentId,
  agentWorktree: (id) => knownAgent(id)?.worktreePath,
  dispatcherAgentId: () => getDispatcherAgentId() ?? undefined,
  isDispatcherOwnedAgent: (id) => {
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current && !seen.has(current)) {
      seen.add(current);
      if (isDispatcherIdentityAgentId(current)) return true;
      const agent = knownAgent(current);
      if (isDispatcherPath(agent?.projectPath)) return true;
      current = agent?.parentAgentId;
    }
    return false;
  },
};

function parseToolResult(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): { ok: boolean; status?: string; messageDelivered?: boolean; text: string } {
  const text = result.content.map((c) => c.text ?? '').join(' ');
  let status: string | undefined;
  let messageDelivered: boolean | undefined;
  try {
    const parsed = JSON.parse(text) as { status?: unknown; messageDelivered?: unknown };
    if (typeof parsed.status === 'string') status = parsed.status;
    if (typeof parsed.messageDelivered === 'boolean') messageDelivered = parsed.messageDelivered;
  } catch {
    // telemetry-exempt: a plain-text result (an error) has no status
  }
  return { ok: !result.isError && status !== 'refused', ...(status && { status }), ...(messageDelivered !== undefined && { messageDelivered }), text };
}

// ── Engine ──────────────────────────────────────────────────────────────────

/**
 * A check one of Clubhouse's own actions runs before it messages the
 * Dispatcher (#3040): the text to send, or why nothing needs sending.
 */
export type AppActionGate = (ctx: { actionId: string; name: string }) => Promise<{ send: string } | { skip: string }>;

const appGates = new Map<string, AppActionGate>();

/** Set (or clear, with null) the gate for Clubhouse's own action with this name. */
export function setAppActionGate(name: string, gate: AppActionGate | null): void {
  if (gate) appGates.set(name, gate);
  else appGates.delete(name);
}

/**
 * An action step's message to the Dispatcher. Clubhouse's own actions pass
 * their gate first. Clubhouse's and the Dispatcher's own actions are its
 * background work, so the turn they start counts apart from conversations.
 */
async function deliverActionToDispatcher(req: DispatcherStepDelivery): Promise<{ delivered: true; woke: boolean; delivery?: MessageDelivery } | { delivered: false; text: string; skipped?: boolean }> {
  let { text, routed } = req;
  const gate = req.owner.kind === 'app' ? appGates.get(req.actionName) : undefined;
  if (gate) {
    let decision: Awaited<ReturnType<AppActionGate>>;
    try {
      decision = await gate({ actionId: req.actionId, name: req.actionName });
    } catch (err) {
      // telemetry-exempt: logged here, since a hidden run's failure is never shown; the step fails
      appLog('core:actions', 'warn', 'A Clubhouse action could not get ready', { meta: { action: req.actionName, error: err instanceof Error ? err.message : String(err) } });
      throw err;
    }
    if ('skip' in decision) return { delivered: false, skipped: true, text: decision.skip };
    ({ text, routed } = actionMessage(req.actionName, decision.send));
  }
  const background = req.owner.kind === 'app' || req.owner.kind === 'dispatcher';
  const inboxId = dispatcherInboxId(req.targetId);
  if (background) noteDispatcherBackgroundWork(inboxId);
  try {
    const delivery = await deliverToDispatcher({
      senderId: req.senderId,
      targetId: req.targetId,
      targetName: req.targetName,
      text,
      routed,
      taskId: `action_${Date.now().toString(36)}`,
      submit: true,
      toolName: 'action',
      args: { actionId: req.actionId },
      fromAction: true,
      ...(req.messageOptions && { messageOptions: req.messageOptions }),
    });
    if (background && !delivery.delivered) clearDispatcherBackgroundWork(inboxId);
    return delivery;
  } catch (err) {
    if (background) clearDispatcherBackgroundWork(inboxId);
    throw err;
  }
}

const observers = new Set<(o: EngineObservation) => void>();

/** For telemetry: every trigger, wait, overlap decision, limit hit and run outcome. */
export function observeActions(fn: (o: EngineObservation) => void): () => void {
  observers.add(fn);
  return () => { observers.delete(fn); };
}

let engine: ActionsEngine | null = null;
let presence: ActionPresence | null = null;
let changeTimer: ReturnType<typeof setTimeout> | null = null;

function syncPresence(): void {
  presence?.configure(engine?.list().flatMap((a) =>
    a.enabled && a.trigger.kind === 'event' && a.trigger.event === 'app.returned'
      ? [{ id: a.id, absenceMinutes: a.trigger.absenceMinutes }] : []) ?? []);
}

function createPresence(): ActionPresence {
  let idleFailed = false;
  return new ActionPresence({
    clock: { now: () => uptime() * 1000, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
    used: () => engine?.recordUse(Date.now()),
    returned: (actionIds) => publishAppEvent({ type: 'app.returned', actionIds }),
    signals: {
      focused: () => BrowserWindow.getFocusedWindow() !== null,
      idleSeconds: () => {
        try {
          const idle = powerMonitor.getSystemIdleTime();
          idleFailed = false;
          return idle;
        } catch (err) {
          // telemetry-exempt: logged; only explicit lock/suspend signals can qualify an absence
          if (!idleFailed) appLog('core:actions', 'warn', 'Could not read system idle time for return actions', { meta: { error: err instanceof Error ? err.message : String(err) } });
          idleFailed = true;
          return null;
        }
      },
      listen: (listener) => {
        const focus = () => listener('focus');
        const blur = () => listener('blur');
        app.on('browser-window-focus', focus);
        app.on('browser-window-blur', blur);
        // Lock/unlock are macOS/Windows only; Linux uses focus, suspend/resume and idle time where reported.
        const lock = () => listener('lock');
        const unlock = () => listener('unlock');
        const suspend = () => listener('suspend');
        const resume = () => listener('resume');
        powerMonitor.on('lock-screen', lock);
        powerMonitor.on('unlock-screen', unlock);
        powerMonitor.on('suspend', suspend);
        powerMonitor.on('resume', resume);
        return () => {
          app.removeListener('browser-window-focus', focus);
          app.removeListener('browser-window-blur', blur);
          powerMonitor.removeListener('lock-screen', lock);
          powerMonitor.removeListener('unlock-screen', unlock);
          powerMonitor.removeListener('suspend', suspend);
          powerMonitor.removeListener('resume', resume);
        };
      },
    },
  });
}

function broadcastChanged(): void {
  syncPresence();
  // Several changes in one tick reach the UI once.
  if (changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    broadcastToAllWindows(IPC.ACTIONS.CHANGED);
  }, 50);
}

function createEngine(): ActionsEngine {
  const canStartAgents = (id: string) => isOrchestrationEnabled(id) || knownAgent(id)?.orchestrates === true;
  const rights = createGrantRights({
    agentName: facts.agentName,
    parentOf: facts.parentOf,
    agentProjectId: facts.agentProjectId,
    // The owner's permissions as the MCP gate works them out (callerGrants): the live gate while it
    // runs, else its saved settings, with its saved changes (#2960, D131). An off Dispatcher holds
    // only what any agent does.
    grantsOf: (id) => {
      const known = knownAgent(id);
      const orchestrates = !isDispatcherAgentId(id) && canStartAgents(id);
      return grantsFromFacts(id, {
        dispatcher: isDispatcherAgentId(id) && isDispatcherEnabled(),
        helper: !!known?.parentAgentId,
        orchestrates,
        crossProject: orchestrates && (isCrossProjectEnabled(id) || known?.crossProject === true),
        ...(orchestrates && { control: orchestrationControl(id) ?? known?.control }),
      });
    },
    agentProjectPath: (id) => knownAgent(id)?.projectPath,
    projectPath: (id) => projectById(id)?.path,
    isConnected: (from, to) => bindingManager.getBindingsForAgent(from).some((b) => b.targetKind === 'agent' && b.targetId === to),
    wakeOn: localConnectionWakeOn,
    // The Dispatcher's wires exist only while it is on, so an off Dispatcher reaches no one.
    dispatcherAgentId: () => getDispatcherAgentId() ?? undefined,
    // The live gate for a running agent, else its saved switch (an asleep agent isn't synced to the gate).
    canStartAgents,
    agentAccess: (id) => knownAgent(id)?.access ?? 'ask',
  });
  const steps = createStepRunner({
    agentExists: facts.agentExists,
    agentName: facts.agentName,
    agentWorktree: facts.agentWorktree,
    isRunning: facts.isRunning,
    project: (id) => {
      const p = projectById(id);
      return p ? { id: p.id, path: p.path, ...(p.orchestrator && { orchestrator: p.orchestrator }), name: projectLabel(p) } : undefined;
    },
    wake: async (req) => parseToolResult(await wakeWiredAgent(req)),
    wakeRefusal: (owner, agentId) => rights.checkStep(owner, { kind: 'wake', agentId }),
    // A person set this step up to put the agent to sleep: no mid-turn refusal after the wait.
    sleep: async (req) => parseToolResult(await sleepAgent({ ...req, force: true })),
    startQuick: (req) => startActionQuickAgent(req),
    notify: (title, body) => {
      const settings = notificationService.getSettings();
      if (!settings.enabled) return { shown: false, reason: 'notifications are off in Settings' };
      if (!settings.agentRequestedAttention) return { shown: false, reason: '“An agent asks for me” is off in Settings' };
      notificationService.sendNotification(title, body, !settings.playSound);
      return { shown: true };
    },
    // Messages to the Dispatcher take its one delivery path, which wakes it (#3037).
    dispatcher: {
      is: (id) => isDispatcherAgentId(id),
      deliver: deliverActionToDispatcher,
    },
  });
  return new ActionsEngine({
    clock: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
    storage: createActionsStorage(),
    history: createRunHistory(),
    facts,
    steps,
    rights,
    hooks: {
      changed: broadcastChanged,
      failed: (action, reason) => {
        appLog('core:actions', 'warn', 'An action couldn’t run', { meta: { actionId: action.id, reason } });
        broadcastToAllWindows(IPC.ACTIONS.NOTICE, { actionId: action.id, name: action.name, message: `“${action.name}” couldn’t run. ${reason}`, exists: !!engine?.get(action.id) } satisfies ActionNotice);
      },
      turnedOff: (action, reason) => {
        broadcastToAllWindows(IPC.ACTIONS.NOTICE, { actionId: action.id, name: action.name, message: `“${action.name}”: ${reason}`, exists: true } satisfies ActionNotice);
      },
      observe: (o) => { for (const fn of observers) { try { fn(o); } catch { /* telemetry-exempt: an observer can't break a run */ } } },
    },
  });
}

let unsubs: Array<() => void> = [];

/** Start Actions. Call after the app event sources start and before "Clubhouse started" is published. */
export async function startActions(): Promise<void> {
  if (engine) return;
  await refreshProjects();
  engine = createEngine();
  presence = createPresence();
  unsubs.push(projectStore.onProjectsChanged(() => { void refreshProjects(); }));
  unsubs.push(onAppEvent((event) => {
    // Project events need the new list first, so names and ids resolve.
    if (event.type === 'project.added' || event.type === 'project.removed') {
      void refreshProjects().then(() => engine?.handleEvent(event));
      return;
    }
    engine?.handleEvent(event);
  }));
  const onResume = () => engine?.resume();
  powerMonitor.on('resume', onResume);
  unsubs.push(() => powerMonitor.removeListener('resume', onResume));
  engine.start();
  syncPresence();
  appLog('core:actions', 'info', 'Actions started', { meta: { count: engine.list().length } });
}

export function stopActions(): void {
  presence?.stop();
  presence = null;
  for (const u of unsubs) u();
  unsubs = [];
  engine?.stop();
  engine = null;
}

function requireEngine(): ActionsEngine {
  if (!engine) throw new ActionError('unavailable', 'Actions are still starting. Try again in a moment.');
  return engine;
}

function view(e: ActionsEngine, a: Action): ActionView {
  const runs = e.history(a.id);
  const lastRun = runs.sort((x, y) => y.startedAt - x.startedAt)[0];
  const next = e.nextRunAt(a.id);
  return { ...a, running: e.isRunning(a.id), ...(next !== undefined && { nextRunAt: next }), ...(lastRun && { lastRun }) };
}

// ── API (IPC and MCP) ───────────────────────────────────────────────────────

/** Every action people and agents can see: Clubhouse's own are left out. */
export function listActions(): ActionView[] {
  const e = requireEngine();
  return e.list().filter((a) => a.owner.kind !== 'app').map((a) => view(e, a));
}

/** One visible action, or undefined (also for Clubhouse's own). */
export function getAction(id: string): ActionView | undefined {
  const e = requireEngine();
  const a = e.get(id);
  return a && a.owner.kind !== 'app' ? view(e, a) : undefined;
}

function requireVisible(id: string): Action {
  const a = requireEngine().get(id);
  if (!a || a.owner.kind === 'app') throw new ActionError('not_found', 'No action with that id.');
  return a;
}

export function createAction(input: unknown, owner: ActionOwner): ActionView {
  const e = requireEngine();
  return view(e, e.create(input, owner));
}

/**
 * Subscribe the owner to an event (#3042): it is told when it happens. The
 * subscription is an action it owns, listed with the others.
 */
export function subscribe(input: unknown, owner: ActionOwner): ActionView {
  const e = requireEngine();
  return view(e, e.subscribe(input, owner));
}

export function updateAction(id: string, input: unknown): ActionView {
  requireVisible(id);
  const e = requireEngine();
  return view(e, e.update(id, input));
}

export function setActionEnabled(id: string, enabled: boolean): ActionView {
  requireVisible(id);
  const e = requireEngine();
  return view(e, e.setEnabled(id, enabled));
}

export function deleteAction(id: string): void {
  requireVisible(id);
  requireEngine().remove(id);
}

export function runActionNow(id: string): { runId: string } {
  requireVisible(id);
  return { runId: requireEngine().runNow(id) };
}

export function actionHistory(id: string, reader?: ActionOwner): ActionRun[] {
  // History outlives one-time actions, so an id that is gone still reads.
  const e = requireEngine();
  const a = e.get(id);
  if (a?.owner.kind === 'app') return [];
  return e.history(id, reader).sort((x, y) => y.startedAt - x.startedAt);
}

/** Internal receipt ingestion only; never creates an Action or schedules work. */
export function recordExternalRun(run: ActionRun & { externalSource: 'annex_delivery' }): Promise<void> {
  return requireEngine().recordExternalRun(run);
}

/** User-only Settings view. MCP history continues to use its reader-scoped path. */
export function actionUsage(): ActionOwnerUsage[] {
  const e = requireEngine();
  return summarizeActionUsage(e.list(), e.history());
}

export function canWatchAgentActivity(reader: ActionOwner): boolean {
  return requireEngine().canWatchAgentActivity(reader);
}

export function canReadDevices(reader: ActionOwner): boolean {
  return requireEngine().canReadDevices(reader);
}

// ── Lookups for the Clubhouse MCP tools ─────────────────────────────────────

/** Agent and project names, for describing actions in plain words. */
export function actionNames(): ActionNames {
  return {
    agent: (id) => facts.agentName(id), project: (id) => facts.projectName(id),
    device: (id) => listDevices().find((d) => d.fingerprint.toLowerCase() === id.toLowerCase())?.alias || undefined,
  };
}

/** The project an agent belongs to, from the last read. */
export function projectIdOfAgent(agentId: string): string | undefined {
  return facts.agentProjectId(agentId);
}

/**
 * A project by id, name or path, among the projects `usable` allows, or
 * undefined when none matches. Two with the same name are refused.
 */
export function findProjectId(ref: string, usable: (projectId: string) => boolean = () => true): string | undefined {
  return matchProjectRef(projects.filter((p) => usable(p.id)), ref, samePath);
}

// ── Clubhouse's own actions ─────────────────────────────────────────────────

function findAppAction(e: ActionsEngine, key: string): Action | undefined {
  return e.list().find((a) => a.owner.kind === 'app' && a.name === key);
}

/** Whether an action already says what valid input says, so replacing it would change nothing. */
function sameDefinition(a: Action, v: ValidActionInput): boolean {
  return a.name === v.name && a.overlap === v.overlap && a.enabled === v.enabled
    && JSON.stringify(a.trigger) === JSON.stringify(v.trigger) && JSON.stringify(a.steps) === JSON.stringify(v.steps);
}

/**
 * Create or replace one of Clubhouse's own actions (internal upkeep). They
 * run like any other, but never appear in lists, agent pages or history.
 * Input that matches what is there changes nothing, so a wait in progress
 * or the next scheduled time is kept.
 */
export function ensureAppAction(key: string, input: unknown): Action {
  const e = requireEngine();
  const existing = findAppAction(e, key);
  const named = { ...(input as Record<string, unknown>), name: key };
  if (existing && sameDefinition(existing, assertActionInput(named))) return existing;
  return existing ? e.update(existing.id, named) : e.create(named, { kind: 'app' });
}

/**
 * Create or replace one of Clubhouse's own subscriptions (#3040): an event
 * that messages the Dispatcher with `note`, made the way subscribe makes
 * one. Hidden like ensureAppAction's, and unchanged when it already matches.
 */
export function ensureAppSubscription(key: string, input: { trigger: EventTrigger; note?: string; enabled?: boolean }): Action {
  const e = requireEngine();
  const owner: ActionOwner = { kind: 'app' };
  const recipient = e.subscriberOf(owner);
  if (!recipient) throw new ActionError('not_allowed', 'There is no Dispatcher to tell yet.');
  const existing = findAppAction(e, key);
  if (existing?.subscription) {
    const named = { name: key, trigger: input.trigger, steps: [subscriptionStep(recipient, input.note)], overlap: 'queue', enabled: input.enabled !== false };
    if (sameDefinition(existing, assertActionInput(named))) return existing;
    return e.update(existing.id, named);
  }
  if (existing) e.remove(existing.id);
  return e.subscribe({ trigger: input.trigger, note: input.note, name: key, enabled: input.enabled !== false }, owner);
}

/** Remove one of Clubhouse's own actions, if there is one. Returns whether it was there. */
export function removeAppAction(key: string): boolean {
  const e = requireEngine();
  const existing = findAppAction(e, key);
  if (existing) e.remove(existing.id);
  return !!existing;
}

/** Clubhouse's own actions, by name. Never shown to people or agents. */
export function listAppActions(): Action[] {
  return requireEngine().list().filter((a) => a.owner.kind === 'app');
}

/** Whether Actions have started, so Clubhouse's own can be set up. */
export function actionsReady(): boolean {
  return engine !== null;
}
