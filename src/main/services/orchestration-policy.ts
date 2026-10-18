/**
 * Orchestration policy (#2228), main side: read and change an agent's
 * policy, keep the MCP tool gate in sync with it, resolve a helper's launch
 * access, check helper limits, and settle helpers when orchestration is
 * turned off.
 *
 * Policy layering, per field: the agent's own `orchestration` fields, then
 * the `orchestration:` front-matter of the agent's persona, then (for every
 * field but `orchestrate`) the front-matter of the Orchestrator persona
 * (`orchestrator`, looked up project > user > built-in), then
 * ORCHESTRATION_DEFAULTS. So a project ships its own policy by adding
 * `.clubhouse/personas/orchestrator.md` with, for example:
 *
 *     ---
 *     orchestration: {"orchestrate": true, "access": "same", "control": "ask-before-start", "maxHelpers": 3}
 *     ---
 *
 * The Orchestrator persona's `orchestrate` applies only to agents that use
 * that persona, so it never turns orchestration on for everyone.
 *
 * Control levels and limits are stored and exposed here; the tools that
 * start and dispose helpers (#2227, #2229) enforce them.
 */

import * as agentConfig from './agent-config';
import { isAgentRunning, killAgent } from './agent-system';
import * as freeAgentSettings from './free-agent-settings';
import * as orchestrationSettings from './orchestration-settings';
import * as projectStore from './project-store';
import { readProjectAgentDefaults } from './agent-settings-service';
import { readLayeredPersonaRaw, resolvePersonaId } from './materialization-service';
import { setOrchestrationEnabled } from './clubhouse-mcp/orchestration-gate';
import { appLog } from './log-service';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { readFrontMatterValue } from '../../shared/persona-pattern';
import type { DurableAgentConfig, FreeAgentPermissionMode } from '../../shared/types';
import {
  applyOrchestrationPatch,
  checkHelperLimit,
  normalizeOrchestrationConfig,
  resolveHelperAccess,
  resolveOrchestrationPolicy,
  validateOrchestrationPatch,
  type HelperAccessResolution,
  type HelperLimitCheck,
  type OrchestrationOffChoice,
  type OrchestrationPolicyConfig,
  type ResolvedOrchestrationPolicy,
  type SetOrchestrationPolicyResult,
  type TurnOffOrchestrationResult,
} from '../../shared/orchestration-policy';

/** The persona whose front-matter supplies project-wide orchestration defaults. */
export const ORCHESTRATOR_PERSONA_ID = 'orchestrator';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readPersonaPolicy(projectPath: string, personaId: string): Promise<OrchestrationPolicyConfig | undefined> {
  try {
    const raw = await readLayeredPersonaRaw(projectPath, personaId);
    return raw === undefined ? undefined : normalizeOrchestrationConfig(readFrontMatterValue(raw, 'orchestration'));
  } catch (err) {
    // telemetry-exempt: an unreadable persona falls back to the defaults
    appLog('core:orchestration', 'warn', 'Could not read orchestration defaults from a persona', {
      meta: { personaId, error: errorText(err) },
    });
    return undefined;
  }
}

/**
 * The persona layer of an agent's policy: its own persona's front-matter
 * over the Orchestrator persona's (minus `orchestrate`).
 */
export async function readPersonaOrchestrationDefaults(
  projectPath: string,
  agent: DurableAgentConfig,
): Promise<OrchestrationPolicyConfig | undefined> {
  let personaId: string | undefined;
  try {
    personaId = resolvePersonaId(agent, await readProjectAgentDefaults(projectPath));
  } catch {
    // telemetry-exempt: unreadable project defaults mean the agent's own persona only
    personaId = agent.persona;
  }
  const own = personaId ? await readPersonaPolicy(projectPath, personaId) : undefined;
  if (personaId === ORCHESTRATOR_PERSONA_ID) return own;
  const project = await readPersonaPolicy(projectPath, ORCHESTRATOR_PERSONA_ID);
  if (project) delete project.orchestrate;
  return normalizeOrchestrationConfig({ ...project, ...own });
}

/** Resolve an agent's policy from `stored` (its own fields, or the ones about to be saved). */
async function resolveFor(
  projectPath: string,
  agent: DurableAgentConfig,
  stored: OrchestrationPolicyConfig | undefined,
): Promise<ResolvedOrchestrationPolicy> {
  return resolveOrchestrationPolicy(stored, await readPersonaOrchestrationDefaults(projectPath, agent));
}

function applyGate(agent: DurableAgentConfig, policy: ResolvedOrchestrationPolicy): void {
  setOrchestrationEnabled(agent.id, policy.orchestrate && !isDisposedAgent(agent));
}

/**
 * An agent's resolved policy, or null for an unknown agent. Reading it also
 * brings the tool gate up to date.
 */
export async function getOrchestrationPolicy(projectPath: string, agentId: string): Promise<ResolvedOrchestrationPolicy | null> {
  const agent = await agentConfig.getDurableConfig(projectPath, agentId);
  if (!agent) {
    setOrchestrationEnabled(agentId, false);
    return null;
  }
  const policy = await resolveFor(projectPath, agent, agent.orchestration);
  applyGate(agent, policy);
  return policy;
}

/**
 * Bring the tool gate up to date for an agent (called at spawn). Never
 * throws; on failure orchestration reads as off.
 */
export async function syncOrchestrationGate(projectPath: string, agentId: string): Promise<void> {
  try {
    await getOrchestrationPolicy(projectPath, agentId);
  } catch (err) {
    // telemetry-exempt: the gate fails closed and the spawn goes on
    setOrchestrationEnabled(agentId, false);
    appLog('core:orchestration', 'warn', 'Could not read the orchestration policy; orchestration is off for this run', {
      meta: { agentId, error: errorText(err) },
    });
  }
}

/** An agent's live direct helpers, so the UI can warn before orchestration is turned off. */
export async function getHelperSummary(projectPath: string, agentId: string): Promise<{ hasHelpers: boolean; helperIds: string[] }> {
  const helpers = await agentConfig.listHelpers(projectPath, agentId);
  return { hasHelpers: helpers.length > 0, helperIds: helpers.map((h) => h.id) };
}

/**
 * Change an agent's policy. Fields set to null go back to the persona or
 * default value. Turning orchestration off while the agent has live helpers
 * changes nothing and returns `needsHelperChoice`: settle them with
 * turnOffOrchestration. An invalid patch throws.
 */
export async function setOrchestrationPolicy(
  projectPath: string,
  agentId: string,
  rawPatch: unknown,
): Promise<SetOrchestrationPolicyResult> {
  const patch = validateOrchestrationPatch(rawPatch);
  const agent = await agentConfig.getDurableConfig(projectPath, agentId);
  if (!agent) return { ok: false, message: 'Agent not found' };

  const current = await resolveFor(projectPath, agent, agent.orchestration);
  const stored = applyOrchestrationPatch(agent.orchestration, patch);
  const next = await resolveFor(projectPath, agent, stored);
  if (next.orchestrate && isDisposedAgent(agent)) {
    return { ok: false, message: 'A disposed agent cannot orchestrate', policy: current };
  }

  if (current.orchestrate && !next.orchestrate) {
    const { helperIds } = await getHelperSummary(projectPath, agentId);
    if (helperIds.length > 0) {
      return {
        ok: false,
        message: `${agent.name} has ${helperIds.length} helper(s). Choose whether to keep or dispose them first.`,
        policy: current,
        needsHelperChoice: { helperIds },
      };
    }
  }

  await agentConfig.setOrchestrationConfig(projectPath, agentId, stored);
  applyGate(agent, next);
  appLog('core:orchestration', 'info', 'Orchestration policy changed', {
    meta: { agentId, orchestrate: next.orchestrate, access: next.access, control: next.control, maxHelpers: next.maxHelpers },
  });
  return { ok: true, message: 'Saved', policy: next };
}

/**
 * Turn orchestration off for an agent that may have helpers.
 * - `keep`: its direct helpers become ordinary agents (parentAgentId cleared).
 * - `dispose`: every live helper below it is disposed through the helper
 *   dispose flow and its checks. Work at risk blocks it and nothing changes,
 *   unless `force`. Running helpers are stopped first.
 * - `cancel`: nothing changes.
 * Orchestration is turned off only once the helpers are settled.
 */
export async function turnOffOrchestration(
  projectPath: string,
  agentId: string,
  choice: OrchestrationOffChoice,
  options: { force?: boolean } = {},
): Promise<TurnOffOrchestrationResult> {
  if (choice !== 'keep' && choice !== 'dispose' && choice !== 'cancel') {
    throw new Error(`Unknown choice: ${String(choice)}`);
  }
  const agent = await agentConfig.getDurableConfig(projectPath, agentId);
  if (!agent) return { ok: false, message: 'Agent not found' };
  if (choice === 'cancel') {
    return { ok: true, cancelled: true, message: 'Nothing changed', policy: await resolveFor(projectPath, agent, agent.orchestration) };
  }

  let cascade: TurnOffOrchestrationResult = { ok: true, message: 'No helpers', helperIds: [] };
  if (choice === 'dispose') {
    const preview = await agentConfig.resolveHelpersForDelete(projectPath, agentId, 'dispose', { dryRun: true, force: options.force });
    if (!preview.ok) return preview;
    // Stop running helpers so none holds its worktree open (EBUSY on Windows).
    for (const helper of await agentConfig.listHelpers(projectPath, agentId, { recursive: true })) {
      if (isAgentRunning(helper.id)) await killAgent(helper.id, projectPath, undefined, 'user', { waitForExit: true });
    }
    cascade = await agentConfig.resolveHelpersForDelete(projectPath, agentId, 'dispose', { force: options.force });
  } else {
    cascade = await agentConfig.resolveHelpersForDelete(projectPath, agentId, 'keep');
  }
  if (!cascade.ok) return cascade;

  // Re-read: the cascade wrote the config.
  const fresh = (await agentConfig.getDurableConfig(projectPath, agentId)) ?? agent;
  const stored = applyOrchestrationPatch(fresh.orchestration, { orchestrate: false });
  await agentConfig.setOrchestrationConfig(projectPath, agentId, stored);
  const policy = await resolveFor(projectPath, fresh, stored);
  applyGate(fresh, policy);
  appLog('core:orchestration', 'info', 'Orchestration turned off', {
    meta: { agentId, choice, helpers: cascade.helperIds?.length ?? 0 },
  });
  return { ...cascade, policy };
}

/**
 * A helper's launch access for an orchestrator, for #2227 to pass to
 * spawnAgent: the orchestrator's own access with `same` (bypass carries
 * through), else the policy's fixed level, never higher than the
 * orchestrator's. `orchestratorPermissionMode` is the mode the orchestrator
 * actually runs with when known; otherwise the project's free-agent setting.
 */
export async function resolveHelperLaunchSettings(
  projectPath: string,
  orchestratorId: string,
  options: { orchestratorPermissionMode?: FreeAgentPermissionMode } = {},
): Promise<HelperAccessResolution> {
  const agent = await agentConfig.getDurableConfig(projectPath, orchestratorId);
  if (!agent) throw new Error('Orchestrator not found');
  const policy = await resolveFor(projectPath, agent, agent.orchestration);
  return resolveHelperAccess(
    {
      freeAgentMode: agent.freeAgentMode === true,
      permissionMode: options.orchestratorPermissionMode ?? freeAgentSettings.getPermissionMode(projectPath),
    },
    policy.access,
  );
}

async function countLiveHelpers(projectPath: string): Promise<number> {
  const agents = await agentConfig.listDurable(projectPath);
  return agents.filter((a) => a.parentAgentId && !isDisposedAgent(a)).length;
}

/**
 * Whether an orchestrator may start another helper: its live helpers (awake
 * or asleep, not disposed) under its policy's `maxHelpers`, and live helpers
 * across `projectPaths` (default: every project in the project store plus
 * this one) under the global cap. A project that can't be read is skipped.
 */
export async function checkHelperLimitFor(
  projectPath: string,
  orchestratorId: string,
  options: { projectPaths?: string[] } = {},
): Promise<HelperLimitCheck> {
  const policy = await getOrchestrationPolicy(projectPath, orchestratorId);
  if (!policy) throw new Error('Orchestrator not found');
  const helperCount = (await agentConfig.listHelpers(projectPath, orchestratorId)).length;

  const paths = new Set(options.projectPaths ?? (await projectStore.list()).map((p) => p.path));
  paths.add(projectPath);
  let totalHelperCount = 0;
  for (const p of paths) {
    try {
      totalHelperCount += await countLiveHelpers(p);
    } catch (err) {
      // telemetry-exempt: one unreadable project doesn't block every start
      appLog('core:orchestration', 'warn', 'Skipped a project while counting helpers', {
        meta: { projectPath: p, error: errorText(err) },
      });
    }
  }
  return checkHelperLimit({
    helperCount,
    totalHelperCount,
    maxHelpers: policy.maxHelpers,
    globalCap: orchestrationSettings.getGlobalHelperCap(),
  });
}
