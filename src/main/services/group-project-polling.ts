/**
 * Group Project polling — the single source of truth for the project-level
 * `metadata.pollingEnabled` setting and its member-wide side effects.
 *
 * Both the UI Polling switch (via IPC) and the `toggle_polling` admin MCP
 * command call {@link setProjectPolling}, so the persisted setting and the
 * injected start/stop instructions can never diverge. This mirrors what the UI
 * toggle historically did inline: persist `pollingEnabled` **and** inject the
 * orchestrator-aware start/stop message into every connected member's PTY.
 */

import { bindingManager } from './clubhouse-mcp/binding-manager';
import { groupProjectRegistry } from './group-project-registry';
import { getAgentOrchestrator } from './agent-registry';
import { isAgentAlive, injectPtyMessage } from './group-project-lifecycle';
import { inboxChannelName } from './group-project-bulletin';
import { pollingStartMsg, pollingStopMsg } from '../../shared/polling-messages';
import * as annexEventBus from './annex-event-bus';
import { appLog } from './log-service';
import { onAgentMcpConnected } from './clubhouse-mcp/connection-events';

/**
 * Delay (ms) between a member's MCP handshake and its deferred polling-start
 * message, so the CLI has finished starting up.
 */
const DEFERRED_POLLING_DELAY_MS = 3_000;

/**
 * Members that were asleep when the user turned polling on: agentId →
 * projectIds. They get the start message after their next MCP handshake.
 * Only the user's toggle queues here; restoring bindings never does (#1544).
 * In memory only, so nothing carries over a restart.
 */
const pendingStarts = new Map<string, Set<string>>();
let unsubscribeConnected: (() => void) | null = null;

function queuePendingStart(agentId: string, projectId: string): void {
  let pending = pendingStarts.get(agentId);
  if (!pending) {
    pending = new Set();
    pendingStarts.set(agentId, pending);
  }
  pending.add(projectId);
  if (!unsubscribeConnected) {
    unsubscribeConnected = onAgentMcpConnected((id) => { void flushPendingStarts(id); });
  }
}

function clearPendingStarts(projectId: string): void {
  for (const [agentId, projects] of pendingStarts) {
    projects.delete(projectId);
    if (projects.size === 0) pendingStarts.delete(agentId);
  }
}

/** Send the start message a member missed while asleep, if it still applies. */
async function flushPendingStarts(agentId: string): Promise<void> {
  const pending = pendingStarts.get(agentId);
  if (!pending) return;
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
    const msg = pollingStartMsg(project.name || projectId, getAgentOrchestrator(agentId), inboxChannelName(agentName));
    appLog('core:group-project', 'info', 'Sending polling start to member that was asleep when polling was turned on', {
      meta: { agentId, projectId },
    });
    setTimeout(() => injectPtyMessage(agentId, msg), DEFERRED_POLLING_DELAY_MS);
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
export async function setProjectPolling(projectId: string, enabled: boolean): Promise<PollingState | null> {
  const project = await groupProjectRegistry.get(projectId);
  if (!project) return null;
  const projectName = project.name || projectId;

  const updated = await groupProjectRegistry.update(projectId, { metadata: { pollingEnabled: enabled } });
  if (updated) annexEventBus.emitGroupProjectChanged('updated', updated);
  if (!enabled) clearPendingStarts(projectId);

  const members = groupProjectMemberBindings(projectId).map((b) => {
    const state = toMemberState(b);
    if (state.status === 'connected') {
      const orchestrator = getAgentOrchestrator(b.agentId);
      const inbox = inboxChannelName(state.agentName);
      const msg = enabled
        ? pollingStartMsg(projectName, orchestrator, inbox)
        : pollingStopMsg(projectName, orchestrator);
      injectPtyMessage(b.agentId, msg);
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
  unsubscribeConnected?.();
  unsubscribeConnected = null;
}

export { pendingStarts as _pendingStartsForTesting, DEFERRED_POLLING_DELAY_MS as _DEFERRED_POLLING_DELAY_MS_FOR_TESTING };
