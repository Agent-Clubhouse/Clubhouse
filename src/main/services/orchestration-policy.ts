/**
 * Orchestration policy (#2228), main side: read and change an agent's
 * policy, keep the MCP tool gate in sync with it, resolve a helper's launch
 * access, check helper limits, and settle helpers when orchestration is
 * turned off.
 *
 * Policy layering, per field: the agent's own `orchestration` fields, then
 * the `orchestration:` front-matter of the agent's persona, then (for every
 * field but `orchestrate` and `connectToDispatcher`) the front-matter of the
 * Orchestrator persona (`orchestrator`, looked up project > user >
 * built-in), then
 * ORCHESTRATION_DEFAULTS. So a project ships its own policy by adding
 * `.clubhouse/personas/orchestrator.md` with, for example:
 *
 *     ---
 *     orchestration: {"orchestrate": true, "access": "same", "control": "ask-before-start", "maxHelpers": 3}
 *     ---
 *
 * The Orchestrator persona's `orchestrate` and `connectToDispatcher` apply
 * only to agents that use that persona, so it never turns orchestration on,
 * or connects the Dispatcher, for everyone.
 *
 * An unset `connectToDispatcher` follows the agent's resolved `orchestrate`,
 * and a helper's is always false, whatever is set (#2578). It never opens the tool gate, which reads only
 * `orchestrate`: a connected plain agent gets no orchestration tools.
 *
 * The tool gate. Only two things open it: a spawn (syncOrchestrationGate)
 * and setOrchestrationPolicy, and only for an agent running in that project.
 * Everything else may only close it: policy reads, a persona change, the
 * agent leaving the registry. So an edit to agents.json or a persona file
 * never hands a running agent the orchestration tools.
 *
 * A persona change that would turn orchestration off while the agent has
 * helpers keeps it on instead: `orchestrate: true` is pinned on the agent
 * and the user turns it off through turnOffOrchestration, choosing what
 * happens to the helpers. Without helpers the gate just closes.
 *
 * Policy writes for one agent (set, turn-off, persona reconcile) run one at
 * a time under a per-agent lock, each on a fresh read of the config.
 *
 * Cross-project helpers (#2512): with `crossProjectHelpers` on (and
 * orchestration), the crossProject gate opens too, and the agent may start
 * helpers in other registered projects. Limits, the helper summary and
 * turn-off count and settle helpers in every project. Turning only
 * `crossProjectHelpers` off settles nothing: helpers already in other
 * projects keep running and can still be managed.
 *
 * Control levels and limits are stored and exposed here; the tools that
 * start and dispose helpers (#2227, #2229) enforce them.
 */

import * as path from 'path';
import * as agentConfig from './agent-config';
import { isAgentRunning, killAgent } from './agent-system';
import { agentRegistry } from './agent-registry';
import * as orchestrationSettings from './orchestration-settings';
import * as projectStore from './project-store';
import { readProjectAgentDefaults } from './agent-settings-service';
import { readLayeredPersonaRaw, resolvePersonaId } from './materialization-service';
import { listHelpersEverywhere, type HelperEntry } from './helper-index';
import {
  closeCrossProject,
  isCrossProjectEnabled,
  isOrchestrationEnabled,
  setOrchestrationEnabled,
} from './clubhouse-mcp/orchestration-gate';
import { appLog } from './log-service';
import { setPersonaChangeHook, type PersonaChange } from './persona-change-hook';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { readFrontMatterValue } from '../../shared/persona-pattern';
import type { DurableAgentConfig } from '../../shared/types';
import {
  ORCHESTRATION_OFF_MESSAGE,
  applyOrchestrationPatch,
  checkHelperLimit,
  normalizeOrchestrationConfig,
  resolveHelperAccess,
  resolveOrchestrationPolicy,
  validateOrchestrationPatch,
  type HelperAccessResolution,
  type HelperLimitCheck,
  type HelperProjectGroup,
  type HelperSummary,
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

/** A project path as a comparison key: resolved, and case-folded on Windows. */
function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** Whether the agent is running (in the registry) for this project. */
function isLiveIn(projectPath: string, agentId: string): boolean {
  const registration = agentRegistry.get(agentId);
  return !!registration && samePath(registration.projectPath, projectPath);
}

// ── Per-agent lock ───────────────────────────────────────────────────────

const locks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every earlier locked call for this agent has settled. Policy
 * writes and the helper dispose tools (#2229) share it, so a turn-off can't
 * release a helper in the middle of its dispose. Not reentrant.
 *
 * Keyed on the agent id alone (ids are unique across the app), so a caller
 * that names the agent's project by another path, such as a helper's project
 * for a parent in another project, takes the same lock (#2512).
 */
export async function withAgentLock<T>(_projectPath: string, agentId: string, fn: () => Promise<T>): Promise<T> {
  const key = agentId;
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.catch((): undefined => undefined).then(fn);
  const settled = run.catch((): undefined => undefined);
  locks.set(key, settled);
  try {
    return await run;
  } finally {
    if (locks.get(key) === settled) locks.delete(key);
  }
}

// ── Resolution ───────────────────────────────────────────────────────────

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
 * over the Orchestrator persona's (minus `orchestrate` and `connectToDispatcher`).
 */
export async function readPersonaOrchestrationDefaults(
  projectPath: string,
  agent: DurableAgentConfig,
): Promise<OrchestrationPolicyConfig | undefined> {
  return personaDefaultsFor(projectPath, await effectivePersonaId(projectPath, agent));
}

/** The persona an agent resolves to: its own, else the project default. */
async function effectivePersonaId(projectPath: string, agent: DurableAgentConfig): Promise<string | undefined> {
  try {
    return resolvePersonaId(agent, await readProjectAgentDefaults(projectPath));
  } catch {
    // telemetry-exempt: unreadable project defaults mean the agent's own persona only
    return agent.persona;
  }
}

async function personaDefaultsFor(projectPath: string, personaId: string | undefined): Promise<OrchestrationPolicyConfig | undefined> {
  const own = personaId ? await readPersonaPolicy(projectPath, personaId) : undefined;
  if (personaId === ORCHESTRATOR_PERSONA_ID) return own;
  const project = await readPersonaPolicy(projectPath, ORCHESTRATOR_PERSONA_ID);
  if (project) {
    delete project.orchestrate;
    delete project.connectToDispatcher;
  }
  return normalizeOrchestrationConfig({ ...project, ...own });
}

/** Resolve an agent's policy from `stored` (its own fields, or the ones about to be saved). */
async function resolveFor(
  projectPath: string,
  agent: DurableAgentConfig,
  stored: OrchestrationPolicyConfig | undefined,
): Promise<ResolvedOrchestrationPolicy> {
  return resolveOrchestrationPolicy(stored, await readPersonaOrchestrationDefaults(projectPath, agent), { helper: !!agent.parentAgentId });
}

/** Resolve as if the agent's effective persona were `personaId`. */
async function resolveWithPersona(
  projectPath: string,
  personaId: string | undefined,
  stored: OrchestrationPolicyConfig | undefined,
): Promise<ResolvedOrchestrationPolicy> {
  return resolveOrchestrationPolicy(stored, await personaDefaultsFor(projectPath, personaId));
}

/** Open or close the gate from a policy. Only spawn and setOrchestrationPolicy call this. */
function applyGate(projectPath: string, agent: DurableAgentConfig, policy: ResolvedOrchestrationPolicy): void {
  setOrchestrationEnabled(agent.id, policy.orchestrate && !isDisposedAgent(agent) && isLiveIn(projectPath, agent.id), {
    crossProject: policy.crossProjectHelpers,
  });
}

/** Close the gate, or only the crossProject gate, when the policy is off. Never opens either. */
function closeGateIfOff(agent: DurableAgentConfig, policy: ResolvedOrchestrationPolicy): void {
  if (!policy.orchestrate || isDisposedAgent(agent)) setOrchestrationEnabled(agent.id, false);
  else if (!policy.crossProjectHelpers) closeCrossProject(agent.id);
}

/**
 * Whether an agent may start a helper in another project now: orchestration
 * and cross-project helpers on in its policy and open in the gate. For
 * start_helper's `project` (#2515). Never opens the gate.
 */
export async function isCrossProjectAllowed(homePath: string, agentId: string): Promise<boolean> {
  const policy = await getOrchestrationPolicy(homePath, agentId);
  return !!policy?.orchestrate && policy.crossProjectHelpers && isCrossProjectEnabled(agentId);
}

/**
 * An agent's resolved policy, or null for an unknown agent. A read can
 * close the gate (the policy is off) but never opens it.
 */
export async function getOrchestrationPolicy(projectPath: string, agentId: string): Promise<ResolvedOrchestrationPolicy | null> {
  const agent = await agentConfig.getDurableConfig(projectPath, agentId);
  if (!agent) {
    if (isLiveIn(projectPath, agentId)) setOrchestrationEnabled(agentId, false);
    return null;
  }
  const policy = await resolveFor(projectPath, agent, agent.orchestration);
  if (isLiveIn(projectPath, agentId)) closeGateIfOff(agent, policy);
  return policy;
}

/**
 * Resolved policies for many agents of one project, for the mobile catalog.
 * Reads project defaults once and each persona once. Never touches the gate.
 */
export async function resolveOrchestrationPolicies(
  projectPath: string,
  agents: DurableAgentConfig[],
): Promise<Map<string, ResolvedOrchestrationPolicy>> {
  const defaults = await readProjectAgentDefaults(projectPath).catch((): undefined => undefined);
  const personas = new Map<string | undefined, Promise<OrchestrationPolicyConfig | undefined>>();
  const out = new Map<string, ResolvedOrchestrationPolicy>();
  await Promise.all(agents.map(async (agent) => {
    let personaId = agent.persona;
    if (defaults) {
      try { personaId = resolvePersonaId(agent, defaults); } catch { /* telemetry-exempt: as effectivePersonaId, the agent's own persona */ }
    }
    if (!personas.has(personaId)) personas.set(personaId, personaDefaultsFor(projectPath, personaId));
    out.set(agent.id, resolveOrchestrationPolicy(agent.orchestration, await personas.get(personaId), { helper: !!agent.parentAgentId }));
  }));
  return out;
}

/**
 * Set the gate for an agent that is starting (called at spawn, after it is
 * registered for `projectPath`). Never throws; on failure orchestration
 * reads as off.
 */
export async function syncOrchestrationGate(projectPath: string, agentId: string): Promise<void> {
  try {
    // Under the lock, so a spawn can't reopen the gate in the middle of a turn-off.
    await withAgentLock(projectPath, agentId, async () => {
      const agent = await agentConfig.getDurableConfig(projectPath, agentId);
      if (!agent) {
        setOrchestrationEnabled(agentId, false);
        return;
      }
      applyGate(projectPath, agent, await resolveFor(projectPath, agent, agent.orchestration));
    });
  } catch (err) {
    // telemetry-exempt: the gate fails closed and the spawn goes on
    setOrchestrationEnabled(agentId, false);
    appLog('core:orchestration', 'warn', 'Could not read the orchestration policy; orchestration is off for this run', {
      meta: { agentId, error: errorText(err) },
    });
  }
}

/** Group helpers by the project holding them, keeping their order. */
function groupByProject(helpers: HelperEntry[]): HelperProjectGroup[] {
  const groups = new Map<string, HelperProjectGroup>();
  for (const { projectPath, config } of helpers) {
    const group = groups.get(projectPath) ?? { projectPath, helperIds: [] };
    group.helperIds.push(config.id);
    groups.set(projectPath, group);
  }
  return [...groups.values()];
}

/**
 * An agent's live direct helpers in every project, grouped by project (home
 * first), so the UI can warn before orchestration is turned off.
 */
export async function getHelperSummary(projectPath: string, agentId: string): Promise<HelperSummary> {
  const helpers = await listHelpersEverywhere(projectPath, agentId);
  return {
    hasHelpers: helpers.length > 0,
    helperIds: helpers.map(({ config }) => config.id),
    projects: groupByProject(helpers),
  };
}

/** How many of the agent's live direct helpers are in another project than its own. */
async function countHelpersElsewhere(projectPath: string, agentId: string): Promise<number> {
  let count = 0;
  for (const helper of await listHelpersEverywhere(projectPath, agentId)) {
    if (!await agentConfig.isSameProject(helper.projectPath, projectPath)) count++;
  }
  return count;
}

// ── Changing the policy ──────────────────────────────────────────────────

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
  return withAgentLock(projectPath, agentId, async () => {
    const agent = await agentConfig.getDurableConfig(projectPath, agentId);
    if (!agent) return { ok: false, message: 'Agent not found' };

    const current = await resolveFor(projectPath, agent, agent.orchestration);
    const stored = applyOrchestrationPatch(agent.orchestration, patch);
    const next = await resolveFor(projectPath, agent, stored);
    if (next.orchestrate && isDisposedAgent(agent)) {
      return { ok: false, message: 'A disposed agent cannot orchestrate', policy: current };
    }

    if (current.orchestrate && !next.orchestrate) {
      const { helperIds, projects } = await getHelperSummary(projectPath, agentId);
      if (helperIds.length > 0) {
        return {
          ok: false,
          message: `${agent.name} has ${helperIds.length} helper(s). Choose whether to keep or dispose them first.`,
          policy: current,
          needsHelperChoice: { helperIds, projects },
        };
      }
    }

    await agentConfig.setOrchestrationConfig(projectPath, agentId, stored);
    applyGate(projectPath, agent, next);
    appLog('core:orchestration', 'info', 'Orchestration policy changed', {
      meta: {
        agentId,
        orchestrate: next.orchestrate,
        access: next.access,
        control: next.control,
        maxHelpers: next.maxHelpers,
        crossProjectHelpers: next.crossProjectHelpers,
        connectToDispatcher: next.connectToDispatcher,
      },
    });
    // Turning only cross-project helpers off settles nothing; say what keeps running.
    const kept = current.crossProjectHelpers && !next.crossProjectHelpers && next.orchestrate
      ? await countHelpersElsewhere(projectPath, agentId)
      : 0;
    return { ok: true, message: 'Saved', policy: next, ...(kept > 0 && { crossProjectHelpersKept: kept }) };
  });
}

/**
 * Settle an agent's helpers in every project with `choice`, stopping running
 * ones (each in its own project) before a dispose.
 */
async function settleHelpers(
  projectPath: string,
  agentId: string,
  choice: 'keep' | 'dispose',
  force: boolean | undefined,
): Promise<TurnOffOrchestrationResult> {
  if (choice === 'keep') return agentConfig.resolveHelpersForDelete(projectPath, agentId, 'keep');
  const preview = await agentConfig.resolveHelpersForDelete(projectPath, agentId, 'dispose', { dryRun: true, force });
  if (!preview.ok) return preview;
  // Stop running helpers so none holds its worktree open (EBUSY on Windows).
  for (const { projectPath: helperPath, config: helper } of await listHelpersEverywhere(projectPath, agentId, { recursive: true })) {
    if (isAgentRunning(helper.id)) await killAgent(helper.id, helperPath, undefined, 'user', { waitForExit: true });
  }
  return agentConfig.resolveHelpersForDelete(projectPath, agentId, 'dispose', { force });
}

/**
 * Turn orchestration off for an agent that may have helpers, in any project.
 * - `keep`: its direct helpers become ordinary agents (parentAgentId cleared).
 * - `dispose`: every live helper below it is disposed through the helper
 *   dispose flow and its checks. Work at risk blocks it and nothing changes,
 *   unless `force`. Running helpers are stopped first.
 * - `cancel`: nothing changes.
 *
 * The gate closes before the helpers are settled, so no helper tool runs
 * meanwhile, and reopens if settling fails (orchestration stays on). After
 * `orchestrate: false` is written the helpers are checked again: one that
 * appeared meanwhile (a start already in flight) gets the same choice. If
 * that second pass fails, orchestration stays off and the result says so.
 * An agent whose orchestration is already off keeps its config as is.
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
  return withAgentLock(projectPath, agentId, async () => {
    const agent = await agentConfig.getDurableConfig(projectPath, agentId);
    if (!agent) return { ok: false, message: 'Agent not found' };
    const current = await resolveFor(projectPath, agent, agent.orchestration);
    if (choice === 'cancel') return { ok: true, cancelled: true, message: 'Nothing changed', policy: current };

    const wasOpen = isOrchestrationEnabled(agentId);
    setOrchestrationEnabled(agentId, false);
    let cascade: TurnOffOrchestrationResult;
    try {
      cascade = await settleHelpers(projectPath, agentId, choice, options.force);
    } catch (err) {
      if (wasOpen) applyGate(projectPath, agent, current);
      throw err;
    }
    if (!cascade.ok) {
      if (wasOpen) applyGate(projectPath, agent, current);
      return { ...cascade, policy: current };
    }

    // Re-read: the cascade wrote the config.
    const fresh = (await agentConfig.getDurableConfig(projectPath, agentId)) ?? agent;
    let stored = fresh.orchestration;
    if (current.orchestrate) {
      stored = applyOrchestrationPatch(fresh.orchestration, { orchestrate: false });
      await agentConfig.setOrchestrationConfig(projectPath, agentId, stored);
    }
    // Closed again after the write, whatever happened to the gate meanwhile.
    setOrchestrationEnabled(agentId, false);
    const policy = await resolveFor(projectPath, fresh, stored);

    const late = (await listHelpersEverywhere(projectPath, agentId)).map(({ config }) => config);
    if (late.length > 0) {
      const again = await settleHelpers(projectPath, agentId, choice, options.force);
      if (!again.ok) {
        appLog('core:orchestration', 'warn', 'Helpers started during turn-off could not be settled', {
          meta: { agentId, choice, helperIds: late.map((h) => h.id) },
        });
        return { ...again, message: `Orchestration is off, but ${again.message}`, policy };
      }
      cascade = { ...cascade, helperIds: [...(cascade.helperIds ?? []), ...(again.helperIds ?? [])] };
    }

    appLog('core:orchestration', 'info', 'Orchestration turned off', {
      meta: { agentId, choice, helpers: cascade.helperIds?.length ?? 0 },
    });
    return { ...cascade, policy };
  });
}

/**
 * After a persona change: if the resolved `orchestrate` went from on to off,
 * close the gate, or, while the agent has helpers, pin `orchestrate: true`
 * on it until the user turns it off with a helper choice. Never opens the
 * gate. `previousPersona` is the effective persona the agent had before (its
 * own, or the project default it used).
 */
export async function reconcileAfterPersonaChange(
  projectPath: string,
  agentId: string,
  previousPersona: string | undefined,
): Promise<void> {
  await withAgentLock(projectPath, agentId, async () => {
    const agent = await agentConfig.getDurableConfig(projectPath, agentId);
    if (!agent) return;
    const before = await resolveWithPersona(projectPath, previousPersona, agent.orchestration);
    const after = await resolveFor(projectPath, agent, agent.orchestration);
    if (!before.orchestrate || after.orchestrate) return;

    const { helperIds } = await getHelperSummary(projectPath, agentId);
    if (helperIds.length > 0) {
      await agentConfig.setOrchestrationConfig(projectPath, agentId, applyOrchestrationPatch(agent.orchestration, { orchestrate: true }));
      appLog('core:orchestration', 'info', 'Persona change kept orchestration on: the agent has helpers', {
        meta: { agentId, helpers: helperIds.length },
      });
      return;
    }
    setOrchestrationEnabled(agentId, false);
  });
}

/** Route a persona change to the agents it affects. */
async function onPersonaChange(change: PersonaChange): Promise<void> {
  if (change.kind === 'agent') {
    const agent = await agentConfig.getDurableConfig(change.projectPath, change.agentId);
    if (!agent) return;
    // The persona it resolved to before: its old own one, else the (unchanged) project default.
    const previous = change.previousPersona
      ?? (await effectivePersonaId(change.projectPath, { ...agent, persona: undefined }));
    await reconcileAfterPersonaChange(change.projectPath, change.agentId, previous);
    return;
  }
  // The project default changed: only agents without their own persona follow it.
  for (const agent of await agentConfig.listDurable(change.projectPath)) {
    if (agent.persona || isDisposedAgent(agent)) continue;
    await reconcileAfterPersonaChange(change.projectPath, agent.id, change.previousDefault);
  }
}

// ── Access and limits ────────────────────────────────────────────────────

/**
 * A helper's launch access for an orchestrator, for #2227 to pass to
 * spawnAgent. The ceiling is what the orchestrator runs with now, recorded
 * on its registry entry: at spawn, on chat level changes (driver mode
 * events, setLevel, a new session after /clear), and for a terminal Claude
 * agent from the `permission_mode` its hooks report (Shift+Tab, raising or
 * lowering). Terminal Codex and Copilot report no mode, so for them the
 * ceiling stays the level they were launched with. An orchestrator
 * that isn't running in this project, or whose mode is unknown, counts as
 * standard. The level is ranked for `helperProvider` (default: the
 * orchestrator's own provider), so its real flags never exceed the ceiling.
 * The result always carries an explicit permission mode.
 */
export async function resolveHelperLaunchSettings(
  projectPath: string,
  orchestratorId: string,
  options: { helperProvider?: string } = {},
): Promise<HelperAccessResolution> {
  const agent = await agentConfig.getDurableConfig(projectPath, orchestratorId);
  if (!agent) throw new Error('Orchestrator not found');
  const policy = await resolveFor(projectPath, agent, agent.orchestration);
  const registration = isLiveIn(projectPath, orchestratorId) ? agentRegistry.get(orchestratorId) : undefined;
  const helperProvider = options.helperProvider ?? registration?.orchestrator ?? agent.orchestrator;
  return resolveHelperAccess(registration?.launchAccess, policy.access, helperProvider);
}

async function countLiveHelpers(projectPath: string): Promise<number> {
  const agents = await agentConfig.listDurable(projectPath);
  return agents.filter((a) => a.parentAgentId && !isDisposedAgent(a)).length;
}

/**
 * Whether an orchestrator may start another helper: orchestration must be on
 * (policy and gate), its live helpers (awake or asleep, not disposed) in
 * every project under its policy's `maxHelpers`, and live helpers across `projectPaths`
 * (default: every project in the project store plus this one, each path
 * counted once) under the global cap. A project that can't be read is
 * skipped.
 */
export async function checkHelperLimitFor(
  projectPath: string,
  orchestratorId: string,
  options: { projectPaths?: string[] } = {},
): Promise<HelperLimitCheck> {
  const policy = await getOrchestrationPolicy(projectPath, orchestratorId);
  if (!policy) throw new Error('Orchestrator not found');
  const globalCap = orchestrationSettings.getGlobalHelperCap();
  const helperCount = (await listHelpersEverywhere(projectPath, orchestratorId)).length;
  if (!policy.orchestrate || !isOrchestrationEnabled(orchestratorId)) {
    return {
      ok: false,
      reason: 'orchestration-off',
      message: ORCHESTRATION_OFF_MESSAGE,
      helperCount,
      totalHelperCount: 0,
      maxHelpers: policy.maxHelpers,
      globalCap,
    };
  }

  const paths = new Map<string, string>();
  for (const p of [projectPath, ...(options.projectPaths ?? (await projectStore.list()).map((proj) => proj.path))]) {
    const key = process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
    if (!paths.has(key)) paths.set(key, p);
  }
  let totalHelperCount = 0;
  for (const p of paths.values()) {
    try {
      totalHelperCount += await countLiveHelpers(p);
    } catch (err) {
      // telemetry-exempt: one unreadable project doesn't block every start
      appLog('core:orchestration', 'warn', 'Skipped a project while counting helpers', {
        meta: { projectPath: p, error: errorText(err) },
      });
    }
  }
  return checkHelperLimit({ helperCount, totalHelperCount, maxHelpers: policy.maxHelpers, globalCap });
}

// ── Wiring ───────────────────────────────────────────────────────────────

// Persona changes may turn the resolved policy off. (An agent leaving the
// registry closes its gate in agent-registry's untrack.)
setPersonaChangeHook(onPersonaChange);
