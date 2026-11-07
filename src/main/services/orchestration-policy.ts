/**
 * Orchestration policy (#2228), main side: read and change an agent's
 * policy, keep the MCP tool gate in sync with it, resolve a helper's launch
 * access, check helper limits, and settle helpers when orchestration is
 * turned off.
 *
 * Policy, per field: the agent's own `orchestration` fields, then
 * ORCHESTRATION_DEFAULTS. The persona layer that sat between them (a
 * persona's `orchestration:` front matter and the project's or user's
 * `orchestrator.md`) was retired in #2901. What it decided is written to an
 * agent's own fields when it switches to managed, and once by the startup
 * pass for agents that stay unmanaged (D62): see carryPersonaOrchestration
 * and managed-agents/legacy-migration.
 *
 * An unset `connectToDispatcher` follows the agent's resolved `orchestrate`,
 * and a helper's is always false, whatever is set (#2578). It never opens the tool gate, which reads only
 * `orchestrate`: a connected plain agent gets no orchestration tools.
 *
 * No Clubhouse MCP, no orchestration (#2589): where isMcpEnabled is false for
 * an agent, `orchestrate`, `crossProjectHelpers` and `connectToDispatcher`
 * resolve false, turning one on is refused, and the saved values stay. Writes
 * that decide about helpers compare the saved values, so a turn-off still
 * asks about helpers with MCP off too.
 *
 * A helper's bridge is forced on so it can start and report, which is why
 * isMcpEnabled above can read true for it. Its own calls follow its raw `mcpOverride`.
 * Where that resolves off (`mcpReportOnly`), the same rules hold: turning a switch on
 * is refused, nothing opens the gate, and what is saved stays and applies again.
 *
 * Helpers aren't touched when MCP goes off: they keep running and keep their
 * parent. The orchestrator's gate closes, so it loses the helper tools until
 * MCP is back, and the Helpers card still lets the user manage them. New tool
 * calls stop too, for every tool: see clubhouse-mcp/mcp-call-gate.
 *
 * The Dispatcher follows the same rule at app level (resolveDispatcherEnablement):
 * derived off, its saved value kept, and a running one left running.
 *
 * The tool gate. Only three things open it: a spawn (syncOrchestrationGate),
 * setOrchestrationPolicy, and MCP coming back for a gate MCP going off closed
 * (reconcileMcpGate), and only for an agent running in that project.
 * Everything else may only close it: policy reads, the agent leaving the
 * registry. So an edit to agents.json never hands a running agent the
 * orchestration tools it didn't have.
 *
 * Policy writes for one agent (set, turn-off, the carry before a switch) run
 * one at a time under a per-agent lock, each on a fresh read of the config.
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
import { legacyPersonaOrchestration, orchestrationToCarry } from './managed-agents/legacy-migration';
import { listHelpersEverywhere, type HelperEntry } from './helper-index';
import {
  closeCrossProject,
  isCrossProjectEnabled,
  isOrchestrationEnabled,
  setOrchestrationEnabled,
} from './clubhouse-mcp/orchestration-gate';
import { setMcpCaller } from './clubhouse-mcp/mcp-call-gate';
import { appLog } from './log-service';
import { noteRoutingPolicyChanged } from './helper-routing-changes';
import { appendSettingsAudit, currentSettingsOrigin, type SettingsAuditRow, type SettingsAuditSurface } from './settings-audit';
import { isMcpEnabled, onMcpEnablementChanged } from './mcp-settings';
import { noteManagedSettingsChanged } from './managed-agents/changed-notice';
import { clubhouseMcpOverride, isDisposedAgent } from '../../shared/agent-helpers';
import type { DurableAgentConfig } from '../../shared/types';
import {
  MCP_REQUIRED_MESSAGE,
  ORCHESTRATION_DEFAULTS,
  ORCHESTRATION_OFF_MESSAGE,
  applyOrchestrationPatch,
  decideHelperAuto,
  checkHelperLimit,
  isMcpDependentOff,
  normalizeOrchestrationConfig,
  patchTurnsOnMcpSwitch,
  resolveHelperAccess,
  resolveOrchestrationPolicy,
  savedOrchestrate,
  validateOrchestrationPatch,
  type HelperAccessResolution,
  type HelperLimitCheck,
  type HelperProjectGroup,
  type HelperSummary,
  type OrchestrationOffChoice,
  type OrchestrationPolicy,
  type OrchestrationPolicyConfig,
  type OrchestrationPolicyPatch,
  type ResolvedOrchestrationPolicy,
  type SetOrchestrationPolicyResult,
  type TurnOffOrchestrationResult,
} from '../../shared/orchestration-policy';

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

/** Resolve an agent's policy from `stored` (its own fields, or the ones about to be saved). */
async function resolveFor(
  projectPath: string,
  agent: DurableAgentConfig,
  stored: OrchestrationPolicyConfig | undefined,
): Promise<ResolvedOrchestrationPolicy> {
  const policy = resolveOrchestrationPolicy(stored, resolveOptions(projectPath, agent));
  return withAutoEffective(policy, await projectAutoOff(projectPath));
}

async function projectAutoOff(projectPath: string): Promise<boolean> {
  try {
    return (await readProjectAgentDefaults(projectPath)).helperAuto === 'off';
  } catch {
    // telemetry-exempt: unreadable project defaults can't have said off, and the start reads them again
    return false;
  }
}

/** What the surfaces show: whether Auto would work, not only this agent's own switch (#2671). */
function withAutoEffective(policy: ResolvedOrchestrationPolicy, projectOff: boolean): ResolvedOrchestrationPolicy {
  return { ...policy, autoEffective: decideHelperAuto({ app: orchestrationSettings.getAutoHelpers(), projectOff, policy }) };
}

function resolveOptions(projectPath: string, agent: DurableAgentConfig): { helper: boolean; mcpOff: boolean; mcpReportOnly: boolean } {
  return {
    helper: !!agent.parentAgentId,
    mcpOff: !isMcpEnabled(projectPath, clubhouseMcpOverride(agent)),
    mcpReportOnly: !!agent.parentAgentId && !isMcpEnabled(projectPath, agent.mcpOverride),
  };
}

/** Agents whose open gate closed because MCP went off, so MCP coming back reopens it. */
const closedByMcp = new Set<string>();

/** Remember a gate that is about to close because MCP is off. */
function noteMcpClosure(agentId: string, mcpOff: boolean): void {
  if (mcpOff && isOrchestrationEnabled(agentId)) closedByMcp.add(agentId);
}

/** Open or close the gate from a policy. Only spawn, setOrchestrationPolicy and reconcileMcpGate call this. */
function applyGate(projectPath: string, agent: DurableAgentConfig, policy: ResolvedOrchestrationPolicy): void {
  noteMcpClosure(agent.id, isMcpDependentOff(policy));
  setOrchestrationEnabled(agent.id, policy.orchestrate && !policy.mcpReportOnly && !isDisposedAgent(agent) && isLiveIn(projectPath, agent.id), {
    crossProject: policy.crossProjectHelpers,
  });
}

/** Close the gate, or only the crossProject gate, when the policy is off. Never opens either. */
function closeGateIfOff(agent: DurableAgentConfig, policy: ResolvedOrchestrationPolicy): void {
  noteMcpClosure(agent.id, isMcpDependentOff(policy));
  if (!policy.orchestrate || policy.mcpReportOnly || isDisposedAgent(agent)) setOrchestrationEnabled(agent.id, false);
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
 * Reads project defaults once. Never touches the gate.
 */
export async function resolveOrchestrationPolicies(
  projectPath: string,
  agents: DurableAgentConfig[],
): Promise<Map<string, ResolvedOrchestrationPolicy>> {
  const projectOff = await projectAutoOff(projectPath);
  const out = new Map<string, ResolvedOrchestrationPolicy>();
  for (const agent of agents) {
    out.set(agent.id, withAutoEffective(resolveOrchestrationPolicy(agent.orchestration, resolveOptions(projectPath, agent)), projectOff));
  }
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
      // A new run decides for itself: its MCP config comes from this start, not the last one.
      closedByMcp.delete(agentId);
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

type PolicyAudit = Pick<SettingsAuditRow, 'surface' | 'actorId' | 'targetId'>;

/**
 * One row per field whose saved value changed: what the agent itself says, null
 * when unset. Resolved values would miss a clear from false to unset, or anything
 * written while MCP masks it. Every field is an enum, a boolean or a whole number.
 */
async function auditPolicyChange(audit: PolicyAudit, before: OrchestrationPolicyConfig | undefined, after: OrchestrationPolicyConfig | undefined): Promise<void> {
  for (const key of Object.keys(ORCHESTRATION_DEFAULTS) as Array<keyof OrchestrationPolicy>) {
    const was = before?.[key] ?? null;
    const now = after?.[key] ?? null;
    if (was === now) continue;
    await appendSettingsAudit({ ...audit, scope: 'agent', key: `orchestration.${key}`, before: was, after: now, outcome: 'ok' });
  }
}

async function auditPolicyRefusal(audit: PolicyAudit, patch: OrchestrationPolicyPatch, code: string): Promise<void> {
  for (const key of Object.keys(patch)) {
    await appendSettingsAudit({ ...audit, scope: 'agent', key: `orchestration.${key}`, outcome: 'refused', code });
  }
}

/**
 * Change an agent's policy. Fields set to null go back to the default value. Turning orchestration off while the agent has live helpers
 * changes nothing and returns `needsHelperChoice`: settle them with
 * turnOffOrchestration. An invalid patch throws. `precondition` runs under the
 * agent's lock on the fresh config, before anything is written, and refuses the
 * change by throwing (#2661).
 */
export async function setOrchestrationPolicy(
  projectPath: string,
  agentId: string,
  rawPatch: unknown,
  options: {
    precondition?: (agent: DurableAgentConfig, current: ResolvedOrchestrationPolicy) => void;
    /** Who is asking, for the audit record. Defaults to the surface this call came in on. */
    surface?: SettingsAuditSurface;
    actorId?: string;
  } = {},
): Promise<SetOrchestrationPolicyResult> {
  const patch = validateOrchestrationPatch(rawPatch);
  const who = currentSettingsOrigin();
  const actorId = options.actorId ?? who.actorId;
  const audit = { surface: options.surface ?? who.surface, ...(actorId && { actorId }), targetId: agentId };
  return withAgentLock(projectPath, agentId, async () => {
    const agent = await agentConfig.getDurableConfig(projectPath, agentId);
    if (!agent) return { ok: false, message: 'Agent not found' };

    const current = await resolveFor(projectPath, agent, agent.orchestration);
    options.precondition?.(agent, current);
    const stored = applyOrchestrationPatch(agent.orchestration, patch);
    const next = await resolveFor(projectPath, agent, stored);
    if (isMcpDependentOff(next) && patchTurnsOnMcpSwitch(patch)) {
      await auditPolicyRefusal(audit, patch, 'mcp_required');
      return { ok: false, message: MCP_REQUIRED_MESSAGE, policy: current, mcpRequired: true };
    }
    if (savedOrchestrate(next) && isDisposedAgent(agent)) {
      await auditPolicyRefusal(audit, patch, 'agent_disposed');
      return { ok: false, message: 'A disposed agent cannot orchestrate', policy: current };
    }

    if (savedOrchestrate(current) && !savedOrchestrate(next)) {
      const { helperIds, projects } = await getHelperSummary(projectPath, agentId);
      if (helperIds.length > 0) {
        await auditPolicyRefusal(audit, patch, 'has_helpers');
        return {
          ok: false,
          message: `${agent.name} has ${helperIds.length} helper(s). Choose whether to keep or dispose them first.`,
          policy: current,
          needsHelperChoice: { helperIds, projects },
        };
      }
    }

    // Copied now: the write can change this agent's own record.
    const storedBefore = agent.orchestration && { ...agent.orchestration };
    await agentConfig.setOrchestrationConfig(projectPath, agentId, stored);
    // A managed agent's setup-changed bar compares the policy with what its session started on.
    if (agent.managed) noteManagedSettingsChanged();
    applyGate(projectPath, agent, next);
    await auditPolicyChange(audit, storedBefore, stored);
    // Its own switch or orchestrate as saved, or the outcome: a clear from false to unset can change the outcome,
    // and a write while MCP is off changes what comes back with it.
    if (storedBefore?.autoHelpers !== stored?.autoHelpers
      || storedBefore?.orchestrate !== stored?.orchestrate
      || current.autoEffective?.effective !== next.autoEffective?.effective) noteRoutingPolicyChanged();
    appLog('core:orchestration', 'info', 'Orchestration policy changed', {
      meta: {
        agentId,
        orchestrate: next.orchestrate,
        access: next.access,
        control: next.control,
        maxHelpers: next.maxHelpers,
        crossProjectHelpers: next.crossProjectHelpers,
        connectToDispatcher: next.connectToDispatcher,
        mcpOff: !!next.mcpOff,
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
    if (savedOrchestrate(current)) {
      stored = applyOrchestrationPatch(fresh.orchestration, { orchestrate: false });
      await agentConfig.setOrchestrationConfig(projectPath, agentId, stored);
      await appendSettingsAudit({ ...currentSettingsOrigin(), targetId: agentId, scope: 'agent', key: 'orchestration.orchestrate', before: true, after: false, outcome: 'ok' });
      // Now, not at the end: the write stands even if settling a late helper fails below.
      noteRoutingPolicyChanged();
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
 * Before an unmanaged agent switches to managed (#2901): the persona layer is
 * retired, so every field the agent's persona or the project's Orchestrator
 * persona decided (managed-agents/legacy-migration) is written to its own
 * fields, and the policy resolves as it did with the layer. A managed agent,
 * or one whose persona layer decides nothing, is left as it is. The gate isn't
 * touched: the outcome doesn't change. Saved as is, without the MCP check: MCP
 * off masks it the same either way. A switch that fails afterwards keeps the
 * fields, since nothing else would give them back.
 *
 * `plain`: the same for an agent that stays unmanaged (D62), so it keeps
 * what a project or user `orchestrator.md`, or its persona, gave it.
 *
 * Returns the fields written, or undefined when there were none.
 */
export async function carryPersonaOrchestration(projectPath: string, agentId: string, why: 'managed' | 'plain' = 'managed'): Promise<OrchestrationPolicyConfig | undefined> {
  return withAgentLock(projectPath, agentId, async () => {
    const agent = await agentConfig.getDurableConfig(projectPath, agentId);
    if (!agent || agent.managed) return undefined;
    const carried = orchestrationToCarry(agent.orchestration, await legacyPersonaOrchestration(projectPath, agent));
    if (!carried) return undefined;
    await agentConfig.setOrchestrationConfig(projectPath, agentId, normalizeOrchestrationConfig({ ...agent.orchestration, ...carried }));
    for (const [key, value] of Object.entries(carried)) {
      await appendSettingsAudit({ surface: 'persona', targetId: agentId, scope: 'agent', key: `orchestration.${key}`, before: null, after: value as boolean | number | string, outcome: 'ok', code: why === 'plain' ? 'carried_from_persona_layer' : 'carried_to_managed' });
    }
    appLog('core:orchestration', 'info', why === 'plain'
      ? 'Orchestration defaults from the persona layer kept on a plain agent'
      : 'Orchestration defaults from the persona kept on the agent before it switched to managed', {
      meta: { agentId, fields: Object.keys(carried) },
    });
    return carried;
  });
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

// ── Following MCP ────────────────────────────────────────────────────────

/**
 * Bring a running agent's gate in line with MCP (#2589): close it while MCP is
 * off, and when MCP is back reopen it only if MCP going off closed it, and the
 * policy still says so. A gate that wasn't open stays shut, so turning MCP on
 * never hands out tools the agent didn't have.
 */
async function reconcileMcpGate(projectPath: string, agentId: string): Promise<void> {
  await withAgentLock(projectPath, agentId, async () => {
    const live = isLiveIn(projectPath, agentId);
    if (!live) closedByMcp.delete(agentId);
    if (!live || (!isOrchestrationEnabled(agentId) && !closedByMcp.has(agentId))) return;
    const agent = await agentConfig.getDurableConfig(projectPath, agentId);
    if (!agent) return;
    // Its own setting, not a helper's forced bridge: this gate is about what it can call.
    if (!isMcpEnabled(projectPath, agent.mcpOverride)) {
      noteMcpClosure(agentId, true);
      setOrchestrationEnabled(agentId, false);
      return;
    }
    if (closedByMcp.delete(agentId)) applyGate(projectPath, agent, await resolveFor(projectPath, agent, agent.orchestration));
  });
}

/** Reconcile the running agents with a gate to move, in one project or all of them. */
function reconcileMcpGates(onlyProject?: string): void {
  for (const [agentId, { projectPath }] of agentRegistry.getAllRegistrations()) {
    if (onlyProject !== undefined && !samePath(projectPath, onlyProject)) continue;
    if (!isOrchestrationEnabled(agentId) && !closedByMcp.has(agentId)) continue;
    reconcileMcpGate(projectPath, agentId).catch((err) => {
      // telemetry-exempt: logged; the next change or spawn settles the gate
      appLog('core:orchestration', 'warn', 'Could not update the orchestration gate after an MCP change', {
        meta: { agentId, error: errorText(err) },
      });
    });
  }
}

/**
 * Refresh the call gate's copy of running agents' configs, and through it their
 * tool lists. The gate reads the app and project settings live, so this only
 * matters for an agent's own `mcpOverride` and for telling a CLI to re-list.
 */
function refreshMcpCallers(onlyProject?: string): void {
  for (const [agentId, { projectPath }] of agentRegistry.getAllRegistrations()) {
    if (onlyProject !== undefined && !samePath(projectPath, onlyProject)) continue;
    agentConfig.getDurableConfig(projectPath, agentId).then((config) => setMcpCaller(agentId, projectPath, config)).catch((err) => {
      // telemetry-exempt: logged; the gate keeps what it had, closed if it never had a config, and the next change retries
      appLog('core:orchestration', 'warn', 'Could not update the MCP call gate after a change', {
        meta: { agentId, error: errorText(err) },
      });
    });
  }
}

/**
 * Keep running agents' gates following MCP: the app and project settings, and
 * an agent's own `mcpOverride`, which arrives as a config change. Returns an
 * unsubscribe function.
 */
export function watchMcpForOrchestration(): () => void {
  const unsubscribers = [
    onMcpEnablementChanged(() => {
      reconcileMcpGates();
      refreshMcpCallers();
    }),
    agentConfig.onAgentConfigChanged((projectPath) => {
      reconcileMcpGates(projectPath);
      refreshMcpCallers(projectPath);
    }),
  ];
  return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
}
