import { useAgentStore } from '../../stores/agentStore';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useToastStore } from '../../stores/toastStore';
import { isRemoteProjectId, parseNamespacedId } from '../../stores/remoteProjectStore';
import type { TemplateConfig } from './TemplateConfigDialog';
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
  freeAgentMode?: boolean;
  mcpIds?: string[];
  persona?: string;
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
  const { name, color, model, useWorktree, orchestrator, freeAgentMode, mcpIds, persona } = input;

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
        freeAgentMode,
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
    ? registerCreatingAgent(project.id, name, color, orchestrator, freeAgentMode)
    : null;

  try {
    const config = await window.clubhouse.agent.createDurable(
      project.path, name, color, model !== 'default' ? model : undefined, useWorktree, orchestrator, freeAgentMode, mcpIds, undefined, persona,
    );
    if (tempId) removeAgent(tempId);
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
    tel.event('clubhouse.ui.action_failed', [ATTR.uiAction('agent_create'), ATTR.errorType('unknown')]);
    tel.exception(err, { handled: true, attrs: [ATTR.uiAction('agent_create')] });
    toastFailure(err);
  }
}
