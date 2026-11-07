import { useAgentStore } from '../../stores/agentStore';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useToastStore } from '../../stores/toastStore';
import { isRemoteProjectId, parseNamespacedId } from '../../stores/remoteProjectStore';
import type { TemplateConfig } from './TemplateConfigDialog';
import { ATTR, tel } from '../../telemetry';
import { loadManagedFlag } from '../managed/managed-flag';

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
  /**
   * False turns Clubhouse's hooks, permission prompts and MCP bridge off
   * (#2893), set before the first session starts so it never gets them.
   */
  clubhouseFeatures?: false;
}

/**
 * With Clubhouse-managed agents on (#2901), a plain agent keeps its own files:
 * in a project with Clubhouse Mode on, Clubhouse Mode is turned off for it
 * before its first start. With the flag off, nothing changes.
 */
async function plainAgentSkipsClubhouseMode(projectPath: string): Promise<boolean> {
  if (!await loadManagedFlag()) return false;
  const settings = await window.clubhouse.app.getClubhouseModeSettings();
  return !!(settings?.projectOverrides?.[projectPath] ?? settings?.enabled);
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
  const { name, color, model, useWorktree, orchestrator, freeAgentMode, mcpIds, persona, clubhouseFeatures } = input;

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
    if (await plainAgentSkipsClubhouseMode(project.path)) {
      try {
        await window.clubhouse.agent.updateDurableConfig(project.path, config.id, { clubhouseModeOverride: true });
      } catch (err) {
        // Leave no agent that would start under Clubhouse Mode: it never started, so remove it before saying why.
        await removeUnstartedAgent(project.path, config.id);
        throw new Error(`Couldn't turn Clubhouse Mode off for it: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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

/** Resolves to the new agent's id, or null when it failed (reported with a toast). */
export async function createDurableAgentFromTemplate(project: AgentProjectRef, templateConfig: TemplateConfig): Promise<string | null> {
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
    return config.id;
  } catch (err) {
    if (tempId) removeAgent(tempId);
    console.error('Failed to create agent from template:', err);
    tel.event('clubhouse.ui.action_failed', [ATTR.uiAction('agent_create'), ATTR.errorType('unknown')]);
    tel.exception(err, { handled: true, attrs: [ATTR.uiAction('agent_create')] });
    toastFailure(err);
    return null;
  }
}
