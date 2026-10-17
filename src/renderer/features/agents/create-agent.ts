import { useAgentStore } from '../../stores/agentStore';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useToastStore } from '../../stores/toastStore';
import { isRemoteProjectId, parseNamespacedId } from '../../stores/remoteProjectStore';
import type { TemplateConfig } from './TemplateConfigDialog';

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
  freeAgentMode?: boolean;
  mcpIds?: string[];
  persona?: string;
}

function toastFailure(err: unknown): void {
  useToastStore.getState().addToast(`Failed to create agent: ${err instanceof Error ? err.message : String(err)}`, 'error');
}

export async function createDurableAgent(project: AgentProjectRef, input: DurableAgentInput): Promise<void> {
  const { name, color, model, useWorktree, orchestrator, freeAgentMode, mcpIds, persona } = input;

  if (isRemoteProjectId(project.id)) {
    // Remote project — proxy create to satellite via REST
    const remoteParts = parseNamespacedId(project.id);
    if (!remoteParts) return;
    try {
      await useAnnexClientStore.getState().sendAgentCreateDurable(remoteParts.satelliteId, remoteParts.agentId, {
        name,
        color,
        model: model !== 'default' ? model : undefined,
        useWorktree,
        orchestrator,
        freeAgentMode,
        mcpIds,
      });
      // Snapshot refresh is broadcast by the satellite — controller will update automatically
    } catch (err) {
      console.error('Failed to create remote durable agent:', err);
      toastFailure(err);
    }
    return;
  }

  const { registerCreatingAgent, removeAgent, spawnDurableAgent } = useAgentStore.getState();
  // Show agent in 'creating' state immediately while worktree is set up
  const tempId = useWorktree
    ? registerCreatingAgent(project.id, name, color, orchestrator, freeAgentMode)
    : null;

  try {
    const config = await window.clubhouse.agent.createDurable(
      project.path, name, color, model !== 'default' ? model : undefined, useWorktree, orchestrator, freeAgentMode, mcpIds, undefined, persona,
    );
    if (tempId) removeAgent(tempId);
    await spawnDurableAgent(project.id, project.path, config, false);
  } catch (err) {
    if (tempId) removeAgent(tempId);
    console.error('Failed to create durable agent:', err);
    toastFailure(err);
  }
}

export async function createDurableAgentFromTemplate(project: AgentProjectRef, templateConfig: TemplateConfig): Promise<void> {
  const { persona, name, color, model, useWorktree, orchestrator: orch, freeAgentMode: fam, mcpIds } = templateConfig;
  const { registerCreatingAgent, removeAgent, spawnDurableAgent } = useAgentStore.getState();

  const tempId = registerCreatingAgent(project.id, name, color, undefined, undefined);
  try {
    const config = await window.clubhouse.agent.createDurable(
      project.path, name, color, model !== 'default' ? model : undefined, useWorktree,
      orch, fam || undefined, mcpIds, undefined, persona.id,
    );
    if (tempId) removeAgent(tempId);
    await spawnDurableAgent(project.id, project.path, config, false);
  } catch (err) {
    if (tempId) removeAgent(tempId);
    console.error('Failed to create agent from template:', err);
    toastFailure(err);
  }
}
