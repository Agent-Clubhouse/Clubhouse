/**
 * Group Project Lifecycle — tracks membership changes and posts
 * join/leave events to the system topic on the bulletin board.
 */

import { bindingManager } from './clubhouse-mcp/binding-manager';
import { getBulletinBoard } from './group-project-bulletin';
import { groupProjectRegistry } from './group-project-registry';
import { executeShoulderTap } from './group-project-shoulder-tap';
import type { BindingTargetKind } from './clubhouse-mcp/types';
import { appLog } from './log-service';

/** Tracks known memberships: projectId → Set<agentId> */
const memberships = new Map<string, Set<string>>();
/** Cached agent names: agentId → human-readable name */
const agentNames = new Map<string, string>();

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

      const agentName = agentNames.get(agentId) || resolveAgentName(agentId);
      try {
        const board = getBulletinBoard(projectId);
        await board.postMessage('system', 'system', `${agentName} left the project`);
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
      // Agent joined this project
      members.add(agentId);

      const agentName = resolveAgentName(agentId);
      agentNames.set(agentId, agentName);
      try {
        const board = getBulletinBoard(projectId);
        await board.postMessage('system', 'system', `${agentName} joined the project`);
      } catch (err) {
        appLog('core:group-project', 'warn', 'Failed to post join event', {
          meta: { agentId, projectId, error: err instanceof Error ? err.message : String(err) },
        });
      }

      // Auto-send polling instruction if polling is enabled
      try {
        const project = await groupProjectRegistry.get(projectId);
        if (project?.metadata?.pollingEnabled) {
          await executeShoulderTap({
            projectId,
            senderLabel: 'system',
            targetAgentId: agentId,
            message: '[SYSTEM:POLLING_START] Poll the bulletin board every 60 seconds when idle or between turns. Use read_bulletin to check for updates.',
          });
        }
      } catch (err) {
        appLog('core:group-project', 'warn', 'Failed to send polling instruction to new agent', {
          meta: { agentId, projectId, error: err instanceof Error ? err.message : String(err) },
        });
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
  initialized = false;
}
