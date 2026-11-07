import type { ManagedTemplateSettings } from '../../../shared/managed-agents-types';
import { useAgentStore } from '../../stores/agentStore';
import type { AgentProjectRef } from '../agents/create-agent';
import type { SetupDraft } from './ManagedBuilder';
import { managed, unwrap } from './managedApi';

export interface ManagedAgentInput {
  name: string;
  color: string;
  /** From a template as it is: main applies the template's parts and settings. */
  templateId?: string;
  /** From the builder: exactly these parts. A templateId inside is remembered, not applied. */
  setup?: SetupDraft;
  settings?: ManagedTemplateSettings;
}

/**
 * Create a Clubhouse-managed durable agent (#2893) and start it, the way
 * createDurableAgent does for a plain one: a "creating" row while main makes
 * its folder, then the first session. Resolves to the new agent's id; a
 * failure rejects so the caller can show it in place.
 */
export async function createManagedDurableAgent(project: AgentProjectRef, input: ManagedAgentInput): Promise<string> {
  const { registerCreatingAgent, removeAgent, spawnDurableAgent } = useAgentStore.getState();
  const tempId = registerCreatingAgent(project.id, input.name, input.color, input.settings?.orchestrator, input.settings?.freeAgentMode);
  let config;
  try {
    config = await unwrap(managed().createAgent(project.path, input));
  } finally {
    removeAgent(tempId);
  }
  await spawnDurableAgent(project.id, project.path, config, false);
  return config.id;
}
