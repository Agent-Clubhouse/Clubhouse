import type { ManagedTemplateSettings } from '../../../shared/managed-agents-types';
import { accessFromLegacy, type AccessLevel } from '../../../shared/agent-access';
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

export type ManagedAgentCreationResult =
  | { status: 'started'; agentId: string }
  | { status: 'start_failed'; agentId: string; error: unknown };

/**
 * The Access (#2761) a template, draft or agent record sets: its level, else
 * the level its legacy Free Agent Mode stands for. Unset when it sets neither.
 */
export function settingsAccess(s: { access?: AccessLevel; freeAgentMode?: boolean }): AccessLevel | undefined {
  if (s.access) return s.access;
  return s.freeAgentMode !== undefined ? accessFromLegacy(s.freeAgentMode, undefined) : undefined;
}

/**
 * Create a Clubhouse-managed durable agent (#2893) and start it, the way
 * createDurableAgent does for a plain one: a "creating" row while main makes
 * its folder, then the first session. Creation failures reject; a failed
 * first start returns the existing agent's id separately from that failure.
 */
export async function createManagedDurableAgent(project: AgentProjectRef, input: ManagedAgentInput): Promise<ManagedAgentCreationResult> {
  const { registerCreatingAgent, removeAgent, spawnDurableAgent } = useAgentStore.getState();
  const tempId = registerCreatingAgent(project.id, input.name, input.color, input.settings?.orchestrator, input.settings ? settingsAccess(input.settings) : undefined);
  let config;
  try {
    config = await unwrap(managed().createAgent(project.path, { ...input, creationRequestId: tempId }));
  } finally {
    removeAgent(tempId);
  }
  try {
    await spawnDurableAgent(project.id, project.path, config, false);
    return { status: 'started', agentId: config.id };
  } catch (error) {
    return { status: 'start_failed', agentId: config.id, error };
  }
}
