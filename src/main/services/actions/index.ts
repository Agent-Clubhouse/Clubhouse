/**
 * Actions service (#2918): the engine wired to the app. Runs in the main
 * process whenever the app is open, with or without a window or project.
 *
 * Callers: the IPC handlers (Settings > Actions, as the person), and the
 * Clubhouse MCP tools (as an agent or the Dispatcher). Clubhouse's own
 * actions (owner 'app') never appear in lists or history.
 */

import * as path from 'path';
import { powerMonitor } from 'electron';
import { ActionError, type Action, type ActionNames, type ActionNotice, type ActionOwner, type ActionRun, type ActionView } from '../../../shared/actions';
import { IPC } from '../../../shared/ipc-channels';
import type { Project } from '../../../shared/types';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import { isAgentRunning } from '../agent-system';
import { onAppEvent } from '../app-event-bus';
import { knownAgent, knownAgents } from '../app-event-sources';
import { bindingManager } from '../clubhouse-mcp/binding-manager';
import { sleepAgent, wakeWiredAgent } from '../clubhouse-mcp/tools/agent-lifecycle';
import { appLog } from '../log-service';
import * as notificationService from '../notification-service';
import * as projectStore from '../project-store';
import { startQuickAgent } from '../quick-agent-service';
import { createActionsStorage, createRunHistory } from './actions-store';
import { ActionsEngine, type EngineFacts, type EngineObservation } from './engine';
import { createInterimRights } from './rights';
import { createStepRunner } from './steps';

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

const facts: EngineFacts & { parentOf(id: string): string | undefined; agentWorktree(id: string): string | undefined } = {
  agentExists: (id) => !!knownAgent(id),
  isRunning: (id) => isAgentRunning(id),
  agentName: (id) => knownAgent(id)?.name,
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

const observers = new Set<(o: EngineObservation) => void>();

/** For telemetry: every trigger, wait, overlap decision, limit hit and run outcome. */
export function observeActions(fn: (o: EngineObservation) => void): () => void {
  observers.add(fn);
  return () => { observers.delete(fn); };
}

let engine: ActionsEngine | null = null;
let changeTimer: ReturnType<typeof setTimeout> | null = null;

function broadcastChanged(): void {
  // Several changes in one tick reach the UI once.
  if (changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = null;
    broadcastToAllWindows(IPC.ACTIONS.CHANGED);
  }, 50);
}

function createEngine(): ActionsEngine {
  const rights = createInterimRights({
    agentName: facts.agentName,
    parentOf: facts.parentOf,
    agentProjectId: facts.agentProjectId,
    isConnected: (from, to) => bindingManager.getBindingsForAgent(from).some((b) => b.targetKind === 'agent' && b.targetId === to),
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
    // A person set this step up to put the agent to sleep: no mid-turn refusal after the wait.
    sleep: async (req) => parseToolResult(await sleepAgent({ ...req, force: true })),
    startQuick: (req) => startQuickAgent(req),
    notify: (title, body) => {
      const settings = notificationService.getSettings();
      if (!settings.enabled) return { shown: false, reason: 'notifications are off in Settings' };
      if (!settings.agentRequestedAttention) return { shown: false, reason: '“An agent asks for me” is off in Settings' };
      notificationService.sendNotification(title, body, !settings.playSound);
      return { shown: true };
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
        broadcastToAllWindows(IPC.ACTIONS.NOTICE, { actionId: action.id, name: action.name, message: `“${action.name}” couldn’t run. ${reason}` } satisfies ActionNotice);
      },
      turnedOff: (action, reason) => {
        broadcastToAllWindows(IPC.ACTIONS.NOTICE, { actionId: action.id, name: action.name, message: `“${action.name}”: ${reason}` } satisfies ActionNotice);
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
  appLog('core:actions', 'info', 'Actions started', { meta: { count: engine.list().length } });
}

export function stopActions(): void {
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

export function actionHistory(id: string): ActionRun[] {
  // History outlives one-time actions, so an id that is gone still reads.
  const e = requireEngine();
  const a = e.get(id);
  if (a?.owner.kind === 'app') return [];
  return e.history(id).sort((x, y) => y.startedAt - x.startedAt);
}

// ── Lookups for the Clubhouse MCP tools ─────────────────────────────────────

/** Agent and project names, for describing actions in plain words. */
export function actionNames(): ActionNames {
  return { agent: (id) => facts.agentName(id), project: (id) => facts.projectName(id) };
}

/** The project an agent belongs to, from the last read. */
export function projectIdOfAgent(agentId: string): string | undefined {
  return facts.agentProjectId(agentId);
}

/** A project by id, name or path, or undefined when none matches. */
export function findProjectId(ref: string): string | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  if (projectById(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  const byName = projects.find((p) => projectLabel(p).toLowerCase() === lower || p.name.toLowerCase() === lower);
  if (byName) return byName.id;
  return path.isAbsolute(trimmed) ? projectIdForPath(trimmed) : undefined;
}

// ── Clubhouse's own actions ─────────────────────────────────────────────────

/**
 * Create or replace one of Clubhouse's own actions (internal upkeep). They
 * run like any other, but never appear in lists, agent pages or history.
 */
export function ensureAppAction(key: string, input: unknown): Action {
  const e = requireEngine();
  const existing = e.list().find((a) => a.owner.kind === 'app' && a.name === key);
  const named = { ...(input as Record<string, unknown>), name: key };
  return existing ? e.update(existing.id, named) : e.create(named, { kind: 'app' });
}
