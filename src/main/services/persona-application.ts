import { parsePersonaFile } from '../../shared/persona-pattern';
import type { DurableConfigUpdates } from '../../shared/types';
import { getDurableConfig, updateDurableConfig } from './agent-config';
import { resolveOrchestrator } from './agent-system';
import { isClubhouseModeEnabled } from './clubhouse-mode-settings';
import { materializeAgent, readLayeredPersonaRaw, writeResolvedPersonaInstructions } from './materialization-service';

/**
 * Apply a persona to a durable agent: look it up layered by scope (project >
 * user > built-in), save its id plus any front-matter settings on the agent,
 * then write its instructions. Shared by "Apply persona" and agent creation.
 *
 * In Clubhouse mode the instructions are rebuilt from project defaults +
 * persona. Otherwise the resolved persona body is written directly: it
 * replaces the instructions, or with `appendToExisting` (used at creation)
 * goes after the project-default snapshot already in the worktree.
 */
export async function applyPersonaToAgent(
  projectPath: string,
  agentId: string,
  personaId: string,
  options: { appendToExisting?: boolean } = {},
): Promise<void> {
  const agent = await getDurableConfig(projectPath, agentId);
  if (!agent) return;

  // Settings ride along in the persona file's front-matter (if any).
  const raw = await readLayeredPersonaRaw(projectPath, personaId);
  const { settings } = raw ? parsePersonaFile(raw) : { settings: {} };
  // Orchestration defaults stay on the persona and are read live (#2228).
  const { orchestration: _orchestration, ...copied } = settings as typeof settings & { orchestration?: unknown };

  const updates: DurableConfigUpdates = {
    persona: personaId,
    ...(copied as DurableConfigUpdates),
  };
  await updateDurableConfig(projectPath, agentId, updates);

  const updated = await getDurableConfig(projectPath, agentId);
  if (!updated) return;
  const provider = await resolveOrchestrator(projectPath, updated.orchestrator);
  if (isClubhouseModeEnabled(projectPath)) {
    await materializeAgent({ projectPath, agent: updated, provider });
  } else {
    await writeResolvedPersonaInstructions({
      projectPath,
      agent: updated,
      provider,
      append: options.appendToExisting,
    });
  }
}
