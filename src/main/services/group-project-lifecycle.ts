/**
 * Group Project Lifecycle — tracks membership changes and posts
 * join/leave events to the system topic on the bulletin board.
 */

import { bindingManager } from './clubhouse-mcp/binding-manager';
import { getBulletinBoard } from './group-project-bulletin';
import { groupProjectRegistry } from './group-project-registry';
import * as ptyManager from './pty-manager';
import { agentRegistry } from './agent-registry';
import type { BindingTargetKind } from './clubhouse-mcp/types';
import { appLog } from './log-service';
import { getAgentOrchestrator } from './agent-registry';
import { getProvider } from '../orchestrators/registry';
import { pollingStartMsg } from '../../shared/polling-messages';

/** Debounce window (ms) — suppress rejoins within this period after a leave unless agent is verified running. */
const REJOIN_DEBOUNCE_MS = 30_000;

/** Default delay (ms) before sending Enter after bracketed paste. */
const DEFAULT_PASTE_DELAY_MS = 200;

/** Get the orchestrator-specific paste delay for an agent. */
function getPasteDelayMs(agentId: string): number {
  const orchId = getAgentOrchestrator(agentId);
  if (orchId) {
    const provider = getProvider(orchId);
    if (provider) return provider.getPasteSubmitTiming().initialDelayMs;
  }
  return DEFAULT_PASTE_DELAY_MS;
}

/** Inject a message into an agent's PTY using bracketed paste + Enter. */
function injectPtyMessage(agentId: string, message: string): void {
  try {
    ptyManager.write(agentId, `\x1b[200~${message}\x1b[201~`);
    setTimeout(() => ptyManager.write(agentId, '\r'), getPasteDelayMs(agentId));
  } catch (err) {
    appLog('core:group-project', 'warn', 'PTY injection failed', {
      meta: { agentId, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** Tracks known memberships: projectId → Set<agentId> */
const memberships = new Map<string, Set<string>>();
/** Cached agent names: agentId → human-readable name */
const agentNames = new Map<string, string>();
/** Tracks recent leave timestamps: `${agentId}:${projectId}` → timestamp */
const recentLeaves = new Map<string, number>();

let initialized = false;
let unsubscribe: (() => void) | null = null;

/** Initialize lifecycle tracking. Call once at startup. */
export function initGroupProjectLifecycle(): void {
  if (initialized) return;
  initialized = true;

  unsubscribe = bindingManager.onChange((agentId: string) => {
    void syncMemberships(agentId);
  });

  appLog('core:group-project', 'info', 'Group project lifecycle initialized');
}

/** Check whether an agent has a live process (PTY or registered runtime). */
export function isAgentAlive(agentId: string): boolean {
  if (ptyManager.isRunning(agentId)) return true;
  // Agent may be running in headless or structured mode — check registry
  return agentRegistry.get(agentId) !== undefined;
}

async function syncMemberships(agentId: string): Promise<void> {
  const bindings = bindingManager.getBindingsForAgent(agentId);
  const currentProjects = new Set(
    bindings
      .filter(b => b.targetKind === ('group-project' as BindingTargetKind))
      .map(b => b.targetId),
  );

  // Find which projects this agent was previously in
  for (const [projectId, members] of memberships) {
    if (members.has(agentId) && !currentProjects.has(projectId)) {
      // Agent left this project
      members.delete(agentId);
      if (members.size === 0) memberships.delete(projectId);

      // Record the leave timestamp for debouncing
      recentLeaves.set(`${agentId}:${projectId}`, Date.now());

      const agentName = agentNames.get(agentId) || resolveAgentName(agentId);
      try {
        const board = getBulletinBoard(projectId);
        const proj = await groupProjectRegistry.get(projectId);
        const projName = proj?.name || projectId;
        await board.postMessage('system', 'system', `${agentName} left project "${projName}"`);
      } catch (err) {
        appLog('core:group-project', 'warn', 'Failed to post leave event', {
          meta: { agentId, projectId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  // Check for new memberships
  for (const projectId of currentProjects) {
    let members = memberships.get(projectId);
    if (!members) {
      members = new Set();
      memberships.set(projectId, members);
    }
    if (!members.has(agentId)) {
      // Debounce: if this agent recently left this project, verify liveness
      // before accepting the rejoin. Stale wire restores create bindings for
      // agents that are no longer running, producing spurious join events.
      const leaveKey = `${agentId}:${projectId}`;
      const lastLeave = recentLeaves.get(leaveKey);
      if (lastLeave !== undefined && Date.now() - lastLeave < REJOIN_DEBOUNCE_MS) {
        if (!isAgentAlive(agentId)) {
          appLog('core:group-project', 'info', 'Suppressed spurious rejoin — agent not running', {
            meta: { agentId, projectId, msSinceLeave: Date.now() - lastLeave },
          });
          // Retract the stale binding so list_members stays accurate
          bindingManager.unbind(agentId, projectId);
          continue;
        }
        // Agent is alive — clear the debounce record and proceed
        recentLeaves.delete(leaveKey);
      }

      // Agent joined this project
      members.add(agentId);

      const agentName = resolveAgentName(agentId);
      agentNames.set(agentId, agentName);

      // Fetch project info for name inclusion in messages
      let project: Awaited<ReturnType<typeof groupProjectRegistry.get>> | undefined;
      try {
        project = await groupProjectRegistry.get(projectId);
      } catch {
        // proceed with fallback name
      }
      const projectName = project?.name || projectId;

      try {
        const board = getBulletinBoard(projectId);
        await board.postMessage('system', 'system', `${agentName} joined project "${projectName}"`);
      } catch (err) {
        appLog('core:group-project', 'warn', 'Failed to post join event', {
          meta: { agentId, projectId, error: err instanceof Error ? err.message : String(err) },
        });
      }

      // Auto-send polling instruction if polling is enabled
      if (project?.metadata?.pollingEnabled) {
        const orchestrator = getAgentOrchestrator(agentId);
        // Small delay so the welcome message is processed first
        setTimeout(() => injectPtyMessage(agentId, pollingStartMsg(projectName, orchestrator)), 500);
      }
    }
  }
}

function resolveAgentName(agentId: string): string {
  // Look at all bindings to find the human-readable name for this agent
  const allBindings = bindingManager.getAllBindings();
  const binding = allBindings.find(b => b.agentId === agentId);
  return binding?.agentName || agentId;
}

/** For testing: reset state. */
export function _resetLifecycleForTesting(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  memberships.clear();
  agentNames.clear();
  recentLeaves.clear();
  initialized = false;
}

/** Exported for testing. */
export { REJOIN_DEBOUNCE_MS as _REJOIN_DEBOUNCE_MS_FOR_TESTING };
export { recentLeaves as _recentLeavesForTesting };
