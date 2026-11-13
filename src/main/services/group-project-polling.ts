/**
 * Group Project polling — the single source of truth for the project-level
 * `metadata.pollingEnabled` setting and its member-wide side effects.
 *
 * Both the UI Polling switch (via IPC) and the `toggle_polling` admin MCP
 * command call {@link setProjectPolling}, so the persisted setting and the
 * injected start/stop instructions can never diverge. This mirrors what the UI
 * toggle historically did inline: persist `pollingEnabled` **and** inject the
 * orchestrator-aware start/stop message into every connected member's PTY.
 *
 * A member without Clubhouse MCP can't call read_bulletin, so it gets no start
 * instruction: it would spend tokens and achieve nothing. The instruction is held
 * and sent when MCP is back for it, if polling is still on. That wakes and starts
 * nothing: a member that has since stopped gets it after its next handshake. A
 * stop instruction still goes out, since that one saves tokens.
 *
 * A running member losing MCP gets one stop as well, if its session looks to be
 * polling (group-project-polling-runs). The loop is the agent's own, so nothing
 * here can end it otherwise, and each refused firing spends a turn.
 *
 * Nothing restarts that loop by itself when MCP is back: the app can't tell a loop
 * this paused from one someone has since ended. The member shows as paused, and
 * Resume sends the start. Only the same session is offered that. A stopped,
 * sleeping or replaced session gets nothing and isn't woken, and a loop the user
 * turned off isn't offered.
 */

import { bindingManager } from './clubhouse-mcp/binding-manager';
import { groupProjectRegistry } from './group-project-registry';
import { groupProjectHost } from './group-project-host';
import { agentRegistry, getAgentOrchestrator } from './agent-registry';
import { canPoll, isAgentAlive, injectPtyMessage } from './group-project-lifecycle';
import { inboxChannelName } from './group-project-bulletin';
import { pollingStartMsg, pollingStopMsg } from '../../shared/polling-messages';
import * as annexEventBus from './annex-event-bus';
import { appLog } from './log-service';
import { onAgentMcpConnected } from './clubhouse-mcp/connection-events';
import { onOrchestrationGateChange } from './clubhouse-mcp/orchestration-gate';
import {
  currentPollingSession, forgetPollingRun, forgetPollingRuns, isPollingLive, isSamePollingSession, notePollingStart, _resetPollingRunsForTesting, type PollingSession,
} from './group-project-polling-runs';

/**
 * Delay (ms) between a member's MCP handshake and its deferred polling-start
 * message, so the CLI has finished starting up.
 */
const DEFERRED_POLLING_DELAY_MS = 3_000;

/**
 * Members that were asleep when the user turned polling on, or without Clubhouse
 * MCP: agentId → projectIds. They get the start message after their next MCP
 * handshake, or when MCP comes back while they run. Only the user's toggle and a
 * new member queue here; restoring bindings never does (#1544). In memory only,
 * so nothing carries over a restart.
 */
const pendingStarts = new Map<string, Set<string>>();
const deletedProjects = new Set<string>();
let unsubscribeConnected: (() => void) | null = null;
let unsubscribeGate: (() => void) | null = null;

function queuePendingStart(agentId: string, projectId: string): void {
  if (deletedProjects.has(projectId)) return;
  let pending = pendingStarts.get(agentId);
  if (!pending) {
    pending = new Set();
    pendingStarts.set(agentId, pending);
  }
  pending.add(projectId);
  if (!unsubscribeConnected) {
    unsubscribeConnected = onAgentMcpConnected((id) => { void flushPendingStarts(id); });
  }
  watchPollingForMcp();
}

/**
 * Loops stopped because MCP went off: agentId → projectId → the session that was
 * polling. This only decides who is offered Resume. Apart from pendingStarts, which
 * are starts nobody has had yet and so still deliver by themselves.
 */
const pausedByMcp = new Map<string, Map<string, PollingSession>>();

const pauseListeners = new Set<() => void>();

/** Listen for the members offered Resume changing. Returns an unsubscribe function. */
export function onPollingPauseChanged(listener: () => void): () => void {
  pauseListeners.add(listener);
  return () => { pauseListeners.delete(listener); };
}

function notifyPauseChanged(): void {
  for (const listener of [...pauseListeners]) listener();
}

let unsubscribeAuth: (() => void) | null = null;

/** A member's access moving arrives here, whichever setting moved it. */
export function watchPollingForMcp(): void {
  if (unsubscribeGate) return;
  unsubscribeGate = onOrchestrationGateChange((id) => {
    if (!isAgentAlive(id)) return;
    if (canPoll(id)) {
      void flushPendingStarts(id);
      if (pausedByMcp.has(id)) notifyPauseChanged();
    } else {
      void pausePollingForMcp(id);
    }
  });
  // A member stopping or starting again ends its offer.
  unsubscribeAuth = agentRegistry.onAuthChange((id) => { if (pausedByMcp.has(id)) notifyPauseChanged(); });
}

/**
 * A running member lost Clubhouse MCP: one stop for each project this session is
 * polling. Paused means already stopped, so this can't repeat however often the
 * gate moves.
 */
async function pausePollingForMcp(agentId: string): Promise<void> {
  for (const binding of bindingManager.getBindingsForAgent(agentId)) {
    const projectId = binding.targetId;
    if (binding.targetKind !== 'group-project' || pausedByMcp.get(agentId)?.has(projectId) || !isPollingLive(agentId, projectId)) continue;
    let project: Awaited<ReturnType<typeof groupProjectRegistry.get>>;
    try {
      project = await groupProjectRegistry.get(projectId);
    } catch {
      // telemetry-exempt: the registry logs its own read failures; skip this project
      continue;
    }
    if (!project?.metadata?.pollingEnabled) continue;
    // Things may have moved during the read, including another event getting here first.
    if (pausedByMcp.get(agentId)?.has(projectId) || canPoll(agentId) || !isPollingLive(agentId, projectId)) continue;
    const session = currentPollingSession(agentId);
    if (!session) continue;
    const paused = pausedByMcp.get(agentId) ?? new Map<string, PollingSession>();
    paused.set(projectId, session);
    pausedByMcp.set(agentId, paused);
    forgetPollingRun(agentId, projectId);
    appLog('core:group-project', 'info', 'Sending polling stop to member that lost Clubhouse MCP', { meta: { agentId, projectId } });
    injectPtyMessage(agentId, pollingStopMsg(project.name || projectId, getAgentOrchestrator(agentId)));
  }
}

function forgetPause(agentId: string, projectId: string): void {
  const paused = pausedByMcp.get(agentId);
  paused?.delete(projectId);
  if (paused?.size === 0) pausedByMcp.delete(agentId);
}

/** Whether this pause still stands: same session, still a member. Ends it for good when it doesn't. */
function pauseStands(agentId: string, projectId: string): boolean {
  const paused = pausedByMcp.get(agentId)?.get(projectId);
  if (!paused) return false;
  const now = currentPollingSession(agentId);
  if (now && isSamePollingSession(paused, now) && groupProjectMemberBindings(projectId).some((b) => b.agentId === agentId)) return true;
  forgetPause(agentId, projectId);
  return false;
}

/** The members to offer Resume: paused by MCP, in the same session, with MCP back. */
export function listPausedPolling(projectId: string): Array<{ agentId: string; agentName: string }> {
  return groupProjectMemberBindings(projectId)
    .filter((b) => pauseStands(b.agentId, projectId) && canPoll(b.agentId))
    .map((b) => ({ agentId: b.agentId, agentName: b.agentName || b.agentId }));
}

/** Resumes in flight, so a second click can't send a second start. */
const resuming = new Set<string>();

/**
 * Resume: one start, to a member offered it. Anything else sends nothing and wakes
 * nothing, and returns false. A read that fails keeps the offer and throws, so the
 * click can say so and be tried again.
 */
export async function resumePausedPolling(projectId: string, agentId: string): Promise<boolean> {
  const key = `${agentId}\u0000${projectId}`;
  if (resuming.has(key)) return false;
  if (!pauseStands(agentId, projectId) || !canPoll(agentId) || !isAgentAlive(agentId)) {
    notifyPauseChanged();
    return false;
  }
  resuming.add(key);
  try {
    const project = await groupProjectRegistry.get(projectId);
    // Things may have moved during the read. MCP going off again keeps the offer for when it's back.
    if (!pauseStands(agentId, projectId) || !canPoll(agentId) || !isAgentAlive(agentId)) return false;
    forgetPause(agentId, projectId);
    if (!project?.metadata?.pollingEnabled) return false;
    const agentName = groupProjectMemberBindings(projectId).find((b) => b.agentId === agentId)?.agentName || agentId;
    injectPtyMessage(agentId, pollingStartMsg(project.name || projectId, getAgentOrchestrator(agentId), await memberInbox(projectId, agentId, agentName)));
    notePollingStart(agentId, projectId);
    appLog('core:group-project', 'info', 'Resumed polling for a member on request', { meta: { agentId, projectId } });
    return true;
  } finally {
    resuming.delete(key);
    notifyPauseChanged();
  }
}

/** A new member without Clubhouse MCP: it gets its start message when it has MCP again. */
export function holdPollingStart(agentId: string, projectId: string): void {
  queuePendingStart(agentId, projectId);
}

function clearPendingStarts(projectId: string): void {
  for (const [agentId, projects] of pendingStarts) {
    projects.delete(projectId);
    if (projects.size === 0) pendingStarts.delete(agentId);
  }
}

/** Forget polling state and cancel delayed starts for a permanently deleted project. */
export function forgetDeletedProjectPolling(projectId: string): void {
  deletedProjects.add(projectId);
  clearPendingStarts(projectId);
  for (const [agentId, projects] of pausedByMcp) {
    projects.delete(projectId);
    if (!projects.size) pausedByMcp.delete(agentId);
  }
  forgetPollingRuns(projectId);
  notifyPauseChanged();
}

/** Send the start message a member missed while asleep, if it still applies. */
async function flushPendingStarts(agentId: string): Promise<void> {
  const pending = pendingStarts.get(agentId);
  if (!pending || !canPoll(agentId)) return;
  pendingStarts.delete(agentId);
  for (const projectId of pending) {
    const binding = groupProjectMemberBindings(projectId).find((b) => b.agentId === agentId);
    if (!binding) continue;
    let project: Awaited<ReturnType<typeof groupProjectRegistry.get>>;
    try {
      project = await groupProjectRegistry.get(projectId);
    } catch {
      // telemetry-exempt: the registry logs its own read failures; skip this project
      continue;
    }
    if (!project?.metadata?.pollingEnabled) continue;
    const agentName = binding.agentName || agentId;
    const msg = pollingStartMsg(project.name || projectId, getAgentOrchestrator(agentId), await memberInbox(projectId, agentId, agentName));
    appLog('core:group-project', 'info', 'Sending polling start to member that was asleep when polling was turned on', {
      meta: { agentId, projectId },
    });
    setTimeout(() => {
      if (deletedProjects.has(projectId)) return;
      // MCP can go off again in the delay. Held once more, so it isn't lost and isn't sent to no purpose.
      if (!canPoll(agentId)) {
        queuePendingStart(agentId, projectId);
        return;
      }
      injectPtyMessage(agentId, msg);
      notePollingStart(agentId, projectId);
    }, DEFERRED_POLLING_DELAY_MS);
  }
}

export interface PollingMemberState {
  agentId: string;
  agentName: string;
  status: 'connected' | 'sleeping';
}

export interface PollingState {
  pollingEnabled: boolean;
  members: PollingMemberState[];
}

/** All bindings belonging to a group project. */
function groupProjectMemberBindings(projectId: string) {
  return bindingManager
    .getAllBindings()
    .filter((b) => b.targetKind === 'group-project' && b.targetId === projectId);
}

function toMemberState(binding: { agentId: string; agentName?: string }): PollingMemberState {
  return {
    agentId: binding.agentId,
    agentName: binding.agentName || binding.agentId,
    status: isAgentAlive(binding.agentId) ? 'connected' : 'sleeping',
  };
}

/**
 * Read the current polling setting plus each member's connection status.
 *
 * Note: there is no per-agent "actively polling" tracking — polling is a
 * fire-and-forget instruction injected into the terminal — so `status` reflects
 * connectivity (connected/sleeping), and `pollingEnabled` is the project-wide
 * setting that the on-join auto-start and the UI label both read.
 */
export async function getProjectPollingState(projectId: string): Promise<PollingState | null> {
  const project = await groupProjectRegistry.get(projectId);
  if (!project) return null;
  return {
    pollingEnabled: !!project.metadata?.pollingEnabled,
    members: groupProjectMemberBindings(projectId).map(toMemberState),
  };
}

/**
 * Set the project-level polling setting and apply the member-wide side effect.
 *
 * Persists `metadata.pollingEnabled`, then injects the orchestrator-aware
 * start/stop instruction into every *connected* member's PTY. Persisting through
 * the registry triggers the change broadcast that refreshes the UI Polling
 * switch, and emits an annex event so any controller observing this satellite sees
 * the update. Returns the resulting state, or null if the project is unknown.
 */
/** A member's own inbox channel, which a same-named member can't share (#1646). */
async function memberInbox(projectId: string, agentId: string, agentName: string): Promise<string> {
  try {
    return await groupProjectHost.inboxFor(projectId, agentName, agentId);
  } catch {
    // telemetry-exempt: falls back to the name-derived inbox the member was always told
    return inboxChannelName(agentName);
  }
}

export async function setProjectPolling(projectId: string, enabled: boolean): Promise<PollingState | null> {
  const project = await groupProjectRegistry.get(projectId);
  if (!project) return null;
  const projectName = project.name || projectId;

  const updated = await groupProjectHost.update(projectId, { metadata: { pollingEnabled: enabled } });
  if (updated) annexEventBus.emitGroupProjectChanged('updated', updated);
  if (!enabled) {
    clearPendingStarts(projectId);
    // The user ended these loops, so nothing may bring them back.
    forgetPollingRuns(projectId);
    for (const agentId of [...pausedByMcp.keys()]) forgetPause(agentId, projectId);
    notifyPauseChanged();
  }

  const bindings = groupProjectMemberBindings(projectId);
  const inboxes = await Promise.all(bindings.map((b) => memberInbox(projectId, b.agentId, toMemberState(b).agentName)));
  const members = bindings.map((b, i) => {
    const state = toMemberState(b);
    if (state.status === 'connected' && enabled && !canPoll(b.agentId)) {
      queuePendingStart(b.agentId, projectId);
    } else if (state.status === 'connected') {
      const orchestrator = getAgentOrchestrator(b.agentId);
      const inbox = inboxes[i];
      const msg = enabled
        ? pollingStartMsg(projectName, orchestrator, inbox)
        : pollingStopMsg(projectName, orchestrator);
      injectPtyMessage(b.agentId, msg);
      if (enabled) notePollingStart(b.agentId, projectId);
    } else if (enabled) {
      queuePendingStart(b.agentId, projectId);
    }
    return state;
  });

  appLog('core:group-project', 'info', 'Project polling setting changed', {
    meta: {
      projectId,
      pollingEnabled: enabled,
      notified: members.filter((m) => m.status === 'connected').length,
    },
  });

  return { pollingEnabled: enabled, members };
}

/** For testing: drop queued starts and the connection listener. */
export function _resetPollingForTesting(): void {
  pendingStarts.clear();
  deletedProjects.clear();
  pausedByMcp.clear();
  resuming.clear();
  _resetPollingRunsForTesting();
  unsubscribeConnected?.();
  unsubscribeConnected = null;
  unsubscribeGate?.();
  unsubscribeGate = null;
  unsubscribeAuth?.();
  unsubscribeAuth = null;
  pauseListeners.clear();
}

export { pendingStarts as _pendingStartsForTesting, DEFERRED_POLLING_DELAY_MS as _DEFERRED_POLLING_DELAY_MS_FOR_TESTING };
