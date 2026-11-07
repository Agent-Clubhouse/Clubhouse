/**
 * Agent-level managed operations (#2893): create a managed agent, switch an
 * existing one to managed, and apply a template's settings. They combine the
 * managed-agents service with agent config and orchestration policy.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as agentConfig from '../agent-config';
import { setOrchestrationPolicy } from '../orchestration-policy';
import { resolveOrchestrator } from '../agent-system';
import type { DurableAgentConfig } from '../../../shared/types';
import type { ManagedAgentSetup, ManagedTemplateSettings } from '../../../shared/managed-agents-types';
import { CLUBHOUSE_MCP_PART_ID } from '../../../shared/managed-agents-types';
import { managedAgents } from './index';
import { BUILTIN_BLOCK_IDS } from './builtins';
import { ManagedError } from './service';
import { managedStateDir } from './state-store';

export interface CreateManagedAgentInput {
  name: string;
  color: string;
  /** Start from this template. Omit to build from scratch. */
  templateId?: string;
  /** The setup to save. When a template is given too, this replaces the template's parts. */
  setup?: Omit<ManagedAgentSetup, 'version'>;
  /** Settings over the template's. */
  settings?: ManagedTemplateSettings;
}

/** Apply settings a template or the builder carries. Unset fields are left alone. */
export async function applyManagedSettings(projectPath: string, agentId: string, settings: ManagedTemplateSettings): Promise<void> {
  const updates: Parameters<typeof agentConfig.updateDurableConfig>[2] = {};
  if (settings.orchestrator !== undefined) updates.orchestrator = settings.orchestrator;
  if (settings.model !== undefined) updates.model = settings.model;
  if (settings.freeAgentMode !== undefined) updates.freeAgentMode = settings.freeAgentMode;
  if (Object.keys(updates).length > 0) await agentConfig.updateDurableConfig(projectPath, agentId, updates);
  if (settings.orchestration && Object.keys(settings.orchestration).length > 0) {
    const result = await setOrchestrationPolicy(projectPath, agentId, settings.orchestration);
    if (!result.ok) throw new ManagedError('invalid', result.message);
  }
}

export async function createManagedAgent(projectPath: string, input: CreateManagedAgentInput): Promise<DurableAgentConfig> {
  const service = managedAgents();
  const base = input.templateId ? await service.setupFromTemplate(input.templateId) : null;
  const settings: ManagedTemplateSettings = { ...(base?.settings ?? {}), ...(input.settings ?? {}) };
  if (base?.settings.orchestration || input.settings?.orchestration) {
    settings.orchestration = { ...(base?.settings.orchestration ?? {}), ...(input.settings?.orchestration ?? {}) };
  }
  const setup: Omit<ManagedAgentSetup, 'version'> = input.setup
    ? { ...input.setup, ...(input.templateId && { templateId: input.templateId }) }
    : base?.setup ?? { blocks: [BUILTIN_BLOCK_IDS.identity], skills: [], mcps: [CLUBHOUSE_MCP_PART_ID] };
  // Managed agents always get their own folder: a worktree in a git project, a plain folder otherwise.
  const config = await agentConfig.createDurable(projectPath, input.name, input.color, settings.model, true, settings.orchestrator, settings.freeAgentMode);
  try {
    await service.saveSetup(projectPath, config.id, setup);
    if (settings.orchestration && Object.keys(settings.orchestration).length > 0) {
      await applyManagedSettings(projectPath, config.id, { orchestration: settings.orchestration });
    }
  } catch (err) {
    // Leave no half-made agent: it has no setup, so remove it.
    await agentConfig.deleteUnregister(projectPath, config.id).catch(() => {});
    throw err;
  }
  return (await agentConfig.getDurableConfig(projectPath, config.id)) ?? config;
}

/**
 * Switch an existing agent to managed (#2893). Keep turns its current
 * instructions file into a block for this agent only. Nothing on disk is
 * deleted: the next start overwrites the instructions file it manages.
 */
export async function convertToManaged(projectPath: string, agentId: string, options: { keep: boolean; templateId?: string }): Promise<ManagedAgentSetup> {
  const service = managedAgents();
  const agent = await agentConfig.getDurableConfig(projectPath, agentId);
  if (!agent) throw new ManagedError('not_found');
  if (agent.managed) return agent.managed;
  if (!agent.worktreePath) throw new ManagedError('invalid', 'This agent works in the project folder. Managed agents need their own folder.');
  if (!options.keep && !options.templateId) throw new ManagedError('invalid', 'Choose a template, or keep what the agent has now.');
  const provider = await resolveOrchestrator(projectPath, agent.orchestrator);
  let existing = '';
  try {
    existing = await provider.readInstructions(agent.worktreePath);
  } catch { /* telemetry-exempt: no instructions file yet */ }
  await backupInstructions(agent, provider.conventions.legacyInstructionsFile, existing);
  if (!options.keep && options.templateId) {
    const { setup, settings } = await service.setupFromTemplate(options.templateId);
    const saved = await service.saveSetup(projectPath, agentId, setup);
    await applyManagedSettings(projectPath, agentId, settings);
    return saved;
  }
  const blocks: string[] = [];
  if (existing.trim()) {
    const part = await service.createPart({
      name: `${agent.name} notes`,
      description: `What ${agent.name} had before it was managed.`,
      content: { kind: 'block', content: existing },
    }).catch(async (err) => {
      if (err instanceof ManagedError && err.code === 'name_taken') {
        return service.createPart({ name: `${agent.name} notes ${Date.now().toString(36)}`, content: { kind: 'block', content: existing } });
      }
      throw err;
    });
    blocks.push(part.id);
  }
  return service.saveSetup(projectPath, agentId, { blocks, skills: [], mcps: agent.mcpOverride === false ? [] : [CLUBHOUSE_MCP_PART_ID] });
}

/** Keep a copy of the instructions file before Clubhouse takes it over, so nothing is lost. */
async function backupInstructions(agent: DurableAgentConfig, file: string, existing: string): Promise<void> {
  if (!existing) return;
  const backup = path.join(managedStateDir(), 'before-managed', agent.id);
  await fsp.mkdir(backup, { recursive: true });
  await fsp.writeFile(path.join(backup, path.basename(file || 'instructions.md')), existing, 'utf-8');
}
