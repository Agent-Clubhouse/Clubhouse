import { useAgentStore } from '../../stores/agentStore';
import { isLegacyFreeAgent, type AccessLevel } from '../../../shared/agent-access';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useToastStore } from '../../stores/toastStore';
import { isRemoteProjectId, parseNamespacedId } from '../../stores/remoteProjectStore';
import { ATTR, tel } from '../../telemetry';

/**
 * Durable-agent creation shared by the legacy agent list and the new chrome's
 * project tree, so both create agents the same way (local or proxied to a
 * satellite) and report failures the same way.
 */

export interface AgentProjectRef {
  id: string;
  path: string;
}

export interface DurableAgentInput {
  name: string;
  color: string;
  model: string;
  useWorktree: boolean;
  orchestrator?: string;
  /** Access (#2761). Unset gives the app's Default access. */
  access?: AccessLevel;
  mcpIds?: string[];
  /**
   * False turns Clubhouse's hooks and permission prompts off (#2893, D70),
   * set before the first session starts so it never gets them. The Clubhouse
   * MCP always runs (D69).
   */
  clubhouseFeatures?: false;
  /**
   * Copy the project's legacy agent defaults into its new worktree (#3245).
   * Only when the person left "Copy this project's legacy defaults" on.
   */
  copyLegacyDefaults?: boolean;
}

/** Delete an agent that was created but never started. A failure is logged; the caller reports its own error. */
async function removeUnstartedAgent(projectPath: string, agentId: string): Promise<void> {
  try {
    await window.clubhouse.agent.deleteDurable(projectPath, agentId);
  } catch (err) {
    console.error('Failed to remove the agent after its setup failed:', err);
    tel.exception(err, { handled: true, attrs: [ATTR.uiAction('agent_create')] });
  }
}

function toastFailure(err: unknown): void {
  useToastStore.getState().addToast(`Failed to create agent: ${err instanceof Error ? err.message : String(err)}`, 'error');
}

/**
 * Resolves to the new agent's id once it exists locally, or null (remote, or it
 * failed and was reported). A failure toasts, unless `onError` takes the message
 * to show it in place (the New agent page keeps its form open).
 */
export async function createDurableAgent(
  project: AgentProjectRef,
  input: DurableAgentInput,
  { onError }: { onError?: (message: string) => void } = {},
): Promise<string | null> {
  const fail = (err: unknown) => (onError ? onError(err instanceof Error ? err.message : String(err)) : toastFailure(err));
  const { name, color, model, useWorktree, orchestrator, access, mcpIds, clubhouseFeatures, copyLegacyDefaults } = input;

  if (isRemoteProjectId(project.id)) {
    // Remote project — proxy create to satellite via REST
    const remoteParts = parseNamespacedId(project.id);
    if (!remoteParts) return null;
    try {
      await useAnnexClientStore.getState().sendAgentCreateDurable(remoteParts.satelliteId, remoteParts.agentId, {
        name,
        color,
        model: model !== 'default' ? model : undefined,
        useWorktree,
        orchestrator,
        // A satellite takes the legacy on/off; it maps it with its own settings.
        ...(access !== undefined && { freeAgentMode: isLegacyFreeAgent(access) }),
        mcpIds,
      });
      // Snapshot refresh is broadcast by the satellite — controller will update automatically
    } catch (err) {
      console.error('Failed to create remote durable agent:', err);
      tel.event('clubhouse.ui.action_failed', [ATTR.uiAction('agent_create'), ATTR.errorType('unknown')]);
      tel.exception(err, { handled: true, attrs: [ATTR.uiAction('agent_create')] });
      fail(err);
    }
    return null;
  }

  const { registerCreatingAgent, removeAgent, spawnDurableAgent } = useAgentStore.getState();
  // Show agent in 'creating' state immediately while worktree is set up
  const tempId = useWorktree
    ? registerCreatingAgent(project.id, name, color, orchestrator, access)
    : null;

  try {
    const args = [project.path, name, color, model !== 'default' ? model : undefined, useWorktree, orchestrator, access, mcpIds] as const;
    // Only a copy the person asked for adds the creation options (#3245).
    const config = copyLegacyDefaults && useWorktree
      ? await window.clubhouse.agent.createDurable(...args, undefined, undefined, { copyLegacyDefaults: true })
      : await window.clubhouse.agent.createDurable(...args);
    if (tempId) removeAgent(tempId);
    if (clubhouseFeatures === false) {
      const off = await window.clubhouse.managed.setClubhouseFeatures(project.path, config.id, false);
      if (off.ok === false) {
        // Leave no half-made agent behind: it never started, so remove it before saying why.
        await removeUnstartedAgent(project.path, config.id);
        throw new Error(off.message || "Couldn't turn Clubhouse features off");
      }
    }
    await spawnDurableAgent(project.id, project.path, config, false);
    return config.id;
  } catch (err) {
    if (tempId) removeAgent(tempId);
    console.error('Failed to create durable agent:', err);
    tel.event('clubhouse.ui.action_failed', [ATTR.uiAction('agent_create'), ATTR.errorType('unknown')]);
    tel.exception(err, { handled: true, attrs: [ATTR.uiAction('agent_create')] });
    fail(err);
    return null;
  }
}
