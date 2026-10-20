/**
 * Helper tools (#2227): an orchestrator starts, lists, sleeps and wakes its
 * own helper agents, and a helper replies to its parent.
 *
 * - start_helper, list_helpers, sleep_helper and wake_helper are in the
 *   `orchestration` tool group (#2228): listed and callable only while the
 *   caller's "Let this agent orchestrate" policy is on.
 * - message_parent is ungated: any agent with a parent may call it, and it
 *   refuses agents without one.
 *
 * start_helper returns at once in the `starting` state. The worktree is made
 * in the background (startDurableCreation, #2226), which can take up to a
 * minute on a big repo. When it is ready the helper is spawned with its task
 * as the first message, using the launch access resolved for the
 * orchestrator (#2228), and the orchestrator is told on its own input; a
 * failure is reported the same way, with the reason. The wires between the
 * two come from the helper's parentAgentId (helper-wire-source, #2225).
 *
 * Under the control levels "ask-before-start" and "ask-everything" nothing is
 * created: the start is held in helper-start-requests and returns
 * `needs_approval` with a request id (#2234). The user approves or declines
 * it from Needs you or the Helpers card; an approved start runs the same
 * path with every check but the control level, and the orchestrator is told
 * either way.
 *
 * Every tool is scoped to the caller's direct children: one orchestrator
 * never sees or touches another's helpers.
 */

import * as path from 'path';
import { registerGlobalTool } from '../tool-registry';
import { isOrchestrationEnabled, onOrchestrationGateChange } from '../orchestration-gate';
import type { McpToolResult } from '../types';
import * as agentConfig from '../../agent-config';
import { agentRegistry } from '../../agent-registry';
import { startDurableCreation } from '../../agent-creation';
import * as agentSystem from '../../agent-system';
import { getAgentRuntime } from '../../agent-runtime';
import { isAgentStoppingError } from '../../agent-runtime/agent-stopping';
import { getGitInfo } from '../../git-service';
import { withoutClubhouseOwnedChanges } from '../../clubhouse-owned-files';
import { applyPersonaToAgent } from '../../persona-application';
import {
  checkHelperLimitFor,
  getOrchestrationPolicy,
  resolveHelperLaunchSettings,
} from '../../orchestration-policy';
import { getAllProviders, getProvider } from '../../../orchestrators';
import type { OrchestratorId } from '../../../orchestrators';
import { broadcastToAllWindows } from '../../../util/ipc-broadcast';
import { appLog } from '../../log-service';
import { IPC } from '../../../../shared/ipc-channels';
import { AGENT_COLORS } from '../../../../shared/name-generator';
import { isDisposedAgent } from '../../../../shared/agent-helpers';
import {
  ACCESS_LEVELS,
  isAccessLevel,
  rankHelperLaunch,
  type HelperLaunch,
  type OrchestrationControl,
} from '../../../../shared/orchestration-policy';
import type { DurableAgentConfig, HelperStartArgs, HelperStartDecisionResult, HelperStartRequest } from '../../../../shared/types';
import {
  dropStartRequestsFor,
  onStartRequestsChanged,
  orchestratorsWithRequests,
  peekStartRequest,
  recordStartRequest,
  takeStartRequest,
} from '../../helper-start-requests';
import { McpArgError, optionalString } from './validation';

// ── Results ──────────────────────────────────────────────────────────────

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], ...(isError && { isError: true }) };
}

function jsonResult(value: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A trimmed, non-empty string argument, or an McpArgError. */
function requireText(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key)?.trim();
  if (!value) throw new McpArgError(`Missing required argument: ${key}`);
  return value;
}

function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  return optionalString(args, key)?.trim() || undefined;
}

/** Run a handler, turning argument errors and refusals into tool errors. */
async function guarded(tool: string, agentId: string, fn: () => Promise<McpToolResult>): Promise<McpToolResult> {
  try {
    return await fn();
  } catch (err) {
    // telemetry-exempt: the error reaches the calling agent as the tool result
    if (!(err instanceof McpArgError || err instanceof HelperToolError)) {
      appLog('core:mcp', 'warn', `${tool} failed`, { meta: { agentId, error: errorText(err) } });
    }
    return textResult(errorText(err), true);
  }
}

/** A refusal meant for the caller, as is. */
class HelperToolError extends Error {}

// ── Caller and helper resolution ─────────────────────────────────────────

interface Caller {
  projectPath: string;
  config: DurableAgentConfig;
}

/** The calling agent's project and durable config. */
async function resolveCaller(agentId: string): Promise<Caller> {
  const registration = agentRegistry.get(agentId);
  if (!registration) throw new HelperToolError('Your agent is not running in Clubhouse.');
  const config = await agentConfig.getDurableConfig(registration.projectPath, agentId);
  if (!config) throw new HelperToolError('Only durable agents can use helper tools.');
  return { projectPath: registration.projectPath, config };
}

/** One of the caller's live direct helpers, by id or (case-insensitive) name. */
async function resolveOwnHelper(caller: Caller, ref: string): Promise<DurableAgentConfig> {
  const helpers = await agentConfig.listHelpers(caller.projectPath, caller.config.id);
  const byId = helpers.find((h) => h.id === ref);
  if (byId) return byId;
  const lower = ref.toLowerCase();
  const byName = helpers.filter((h) => h.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new HelperToolError(`More than one of your helpers is named "${ref}". Use its id.`);
  throw new HelperToolError(`"${ref}" is not one of your helpers. Call list_helpers to see them.`);
}

// ── Messages to agents ───────────────────────────────────────────────────

type Delivery = 'delivered' | 'not_running' | 'stopping';

/**
 * Deliver text to a running agent's input, as Clubhouse MCP send_message
 * does. A terminal agent that is shutting down refuses the text (its runtime
 * throws AgentStoppingError), which comes back as 'stopping'.
 */
async function deliverToAgent(targetId: string, text: string): Promise<Delivery> {
  const runtime = getAgentRuntime(targetId);
  if (!runtime) return 'not_running';
  try {
    await runtime.sendMessage(text, { source: 'mcp', taskId: `helper_${Date.now().toString(36)}` });
  } catch (err) {
    if (isAgentStoppingError(err)) return 'stopping';
    throw err;
  }
  return 'delivered';
}

/** Tell an orchestrator what happened to a helper. Never throws. */
async function notifyOrchestrator(orchestratorId: string, text: string): Promise<void> {
  try {
    const delivery = await deliverToAgent(orchestratorId, `[Clubhouse] ${text}`);
    if (delivery === 'delivered') return;
    appLog('core:mcp', 'warn', 'Helper update not delivered: the orchestrator is not running', {
      meta: { orchestratorId, delivery },
    });
  } catch (err) {
    // telemetry-exempt: logged; an undelivered update must not fail the start
    appLog('core:mcp', 'warn', 'Helper update not delivered', {
      meta: { orchestratorId, error: errorText(err) },
    });
  }
}

// ── Start state ──────────────────────────────────────────────────────────

/**
 * Helpers a start or wake is spawning (from start_helper's record write, or
 * wake's check, until the spawn settles), and the reason for a spawn that
 * failed (the creation records its own failures). Both live only for this
 * run; list_helpers reads them, and a helper in `spawning` is never spawned
 * twice.
 */
const spawning = new Set<string>();
const spawnFailures = new Map<string, string>();
/** Background starts still running, for tests. */
const inflight = new Set<Promise<void>>();

/**
 * Start requests run one at a time across the app, from the limit check to
 * the helper's record being written, so two starts can't both pass the
 * per-orchestrator limit or the global cap.
 */
let startChain: Promise<unknown> = Promise.resolve();

async function withStartLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = startChain.catch((): undefined => undefined).then(fn);
  startChain = run.catch((): undefined => undefined);
  return run;
}

/** At most one needs-approval notification per orchestrator per minute. */
const APPROVAL_NOTICE_INTERVAL_MS = 60_000;
const lastApprovalNotice = new Map<string, number>();

/** Resolve a helper's launch settings now, for the CLI it will run. */
async function resolveLaunchFor(
  projectPath: string,
  orchestratorId: string,
  provider: string | undefined,
  requested: string | undefined,
): Promise<HelperLaunch> {
  const resolved = await resolveHelperLaunchSettings(projectPath, orchestratorId, provider ? { helperProvider: provider } : {});
  return rankHelperLaunch(resolved, requested, provider);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/**
 * Why a ready helper must not be spawned now, or null. Checked right before
 * the spawn, with nothing awaited after it: the helper is still this
 * orchestrator's and not disposed, and the orchestrator still runs in this
 * project with orchestration on.
 */
function spawnBlocker(projectPath: string, orchestratorId: string, helper: DurableAgentConfig | null): string | null {
  if (!helper) return 'it no longer exists';
  if (helper.parentAgentId !== orchestratorId) return 'it is no longer your helper';
  if (isDisposedAgent(helper)) return 'it was disposed';
  const registration = agentRegistry.get(orchestratorId);
  if (!registration || !samePath(registration.projectPath, projectPath)) return 'its orchestrator stopped';
  if (!isOrchestrationEnabled(orchestratorId)) return 'orchestration was turned off for its orchestrator';
  return null;
}

function helperMission(orchestratorName: string, task: string): string {
  return `[FROM:${orchestratorName}] ${task}\n\n---\n` +
    `You are a helper agent started by ${orchestratorName}. Use the message_parent tool ` +
    `to send ${orchestratorName} your progress, questions and results.`;
}

function pickColor(helperCount: number): string {
  return AGENT_COLORS[helperCount % AGENT_COLORS.length].id;
}

/** Put an undelivered task back on a helper. Never throws. */
async function restoreTask(projectPath: string, helperId: string, task: string): Promise<void> {
  try {
    await agentConfig.setHelperStartFields(projectPath, helperId, { pendingTask: task });
  } catch (err) {
    // telemetry-exempt: logged; the orchestrator is told the helper didn't start
    appLog('core:mcp', 'warn', 'Could not save a helper\'s undelivered task', { meta: { helperId, error: errorText(err) } });
  }
}

/**
 * The background half of start_helper: wait for the worktree, then spawn
 * the helper with its task and tell the orchestrator. The task is saved on
 * the helper until a spawn delivers it, so a helper left asleep (a restart,
 * a failed spawn, a check below) gets it on its next wake. Everything that
 * decides the spawn is read again here, after the wait: the helper's
 * config (a persona may have changed its CLI), the orchestrator's gate and
 * liveness, and the access, ranked for the helper's CLI. The helper is in
 * `spawning` from the record write until this settles. Never throws.
 */
async function finishHelperStart(
  projectPath: string,
  orchestrator: DurableAgentConfig,
  helperId: string,
  helperName: string,
  task: string,
  requestedAccess: string | undefined,
  done: Promise<'ready' | 'failed' | 'cancelled'>,
): Promise<void> {
  let taskTaken = false;
  try {
    const outcome = await done;
    if (outcome === 'cancelled') {
      await notifyOrchestrator(orchestrator.id, `Helper "${helperName}" (${helperId}) was cancelled before it started.`);
      return;
    }
    let config = await agentConfig.getDurableConfig(projectPath, helperId).catch((): null => null);
    if (outcome === 'failed' || !config || config.creation) {
      const reason = config?.creation?.reason ?? 'its worktree could not be created.';
      await notifyOrchestrator(orchestrator.id, `Helper "${helperName}" (${helperId}) failed to start: ${reason}`);
      return;
    }

    // The task and the requested level stay on the helper: a helper left
    // asleep gets the task on its next wake, and no wake goes above the level.
    const asked = requestedAccess && isAccessLevel(requestedAccess) ? requestedAccess : null;
    await agentConfig.setHelperStartFields(projectPath, helperId, { pendingTask: task, requestedAccess: asked });
    const provider = config.orchestrator ?? orchestrator.orchestrator;
    const launch = await resolveLaunchFor(projectPath, orchestrator.id, provider, requestedAccess);
    config = await agentConfig.getDurableConfig(projectPath, helperId).catch((): null => null);
    // A persona applied during creation may have switched the CLI: rank again for it.
    const finalProvider = config?.orchestrator ?? provider;
    const finalLaunch = finalProvider === provider
      ? launch
      : await resolveLaunchFor(projectPath, orchestrator.id, finalProvider, requestedAccess);

    // Taken off before the spawn, so a wake can't deliver it a second time;
    // put back below if the helper doesn't start.
    await agentConfig.setHelperStartFields(projectPath, helperId, { pendingTask: null });
    taskTaken = true;

    // The last read: nothing is awaited between it, the checks and the spawn.
    config = await agentConfig.getDurableConfig(projectPath, helperId).catch((): null => null);
    const blocker = spawnBlocker(projectPath, orchestrator.id, config)
      ?? ((config?.orchestrator ?? provider) !== finalProvider ? 'its CLI changed while it was starting' : null);
    if (blocker) {
      appLog('core:mcp', 'info', 'start_helper: helper left asleep', {
        meta: { orchestratorId: orchestrator.id, helperId, reason: blocker },
      });
      if (config) await restoreTask(projectPath, helperId, task);
      taskTaken = false;
      await notifyOrchestrator(orchestrator.id,
        `Helper "${helperName}" (${helperId}) is ready but was not started because ${blocker}. ` +
        'Its task is saved: wake_helper delivers it.');
      return;
    }

    broadcastToAllWindows(IPC.AGENT.AGENT_WAKING, helperId);
    await agentSystem.spawnAgent({
      agentId: helperId,
      projectPath,
      cwd: config.worktreePath || projectPath,
      kind: 'durable',
      model: config.model,
      mission: helperMission(orchestrator.name, task),
      orchestrator: finalProvider as OrchestratorId | undefined,
      // Both explicitly: an unset mode would be filled from project settings
      // at spawn, and a persona may have written freeAgentMode on the config.
      freeAgentMode: finalLaunch.freeAgentMode,
      permissionMode: finalLaunch.permissionMode,
    });
    taskTaken = false;
    spawning.delete(helperId);
    appLog('core:mcp', 'info', 'start_helper: helper started', {
      meta: { orchestratorId: orchestrator.id, helperId, access: finalLaunch.level },
    });
    const branch = config.branch ? ` on branch ${config.branch}` : '';
    await notifyOrchestrator(orchestrator.id,
      `Helper "${helperName}" (${helperId}) is ready${branch} with ${finalLaunch.level} access and has started its task.`);
  } catch (err) {
    // telemetry-exempt: the failure reaches the orchestrator and list_helpers
    const reason = errorText(err);
    if (taskTaken) await restoreTask(projectPath, helperId, task);
    spawnFailures.set(helperId, reason);
    broadcastToAllWindows(IPC.AGENT.AGENT_WAKE_FAILED, helperId, reason);
    appLog('core:mcp', 'warn', 'start_helper: helper spawn failed', {
      meta: { orchestratorId: orchestrator.id, helperId, error: reason },
    });
    await notifyOrchestrator(orchestrator.id,
      `Helper "${helperName}" (${helperId}) was created but failed to start: ${reason} Its task is saved: wake_helper delivers it.`);
  } finally {
    spawning.delete(helperId);
  }
}

// ── start_helper ─────────────────────────────────────────────────────────

/** Check start_helper's arguments. Throws McpArgError. */
function validateStartArgs(args: HelperStartArgs): void {
  if (args.access && args.access !== 'same' && !isAccessLevel(args.access)) {
    throw new McpArgError(`access must be one of: same, ${ACCESS_LEVELS.join(', ')}`);
  }
  if (args.cli && !getProvider(args.cli as OrchestratorId)) {
    throw new McpArgError(`Unknown cli "${args.cli}". Available: ${getAllProviders().map((p) => p.id).join(', ')}`);
  }
}

function parseStartArgs(args: Record<string, unknown>): HelperStartArgs {
  const parsed: HelperStartArgs = { name: requireText(args, 'name'), task: requireText(args, 'task') };
  for (const key of ['persona', 'cli', 'model', 'access', 'branchFrom', 'folder'] as const) {
    const value = optionalText(args, key);
    if (value) parsed[key] = value;
  }
  validateStartArgs(parsed);
  return parsed;
}

type StartOutcome =
  /** `message` for the orchestrator's tool result; `reason` to follow "because" in an approval's answer. */
  | { kind: 'refused'; message: string; reason: string }
  | { kind: 'too_many'; waiting: number }
  | { kind: 'needs_approval'; control: OrchestrationControl; request: HelperStartRequest; reused: boolean }
  | { kind: 'starting'; helperId: string; name: string; branch?: string; launch: HelperLaunch };

/** A sentence as the tail of "…because <reason>": its first letter lowered unless it starts an acronym or name. */
function asReason(text: string): string {
  const trimmed = text.trim();
  return /^[A-Z][a-z]/.test(trimmed) ? trimmed[0].toLowerCase() + trimmed.slice(1) : trimmed;
}

function refused(message: string): StartOutcome {
  return { kind: 'refused', message, reason: asReason(message) };
}

/** Raise the desktop notice for a held start, at most once a minute per orchestrator. */
function noticeApprovalNeeded(orchestrator: DurableAgentConfig, args: HelperStartArgs): void {
  const now = Date.now();
  const last = lastApprovalNotice.get(orchestrator.id);
  if (last !== undefined && now - last < APPROVAL_NOTICE_INTERVAL_MS) return;
  lastApprovalNotice.set(orchestrator.id, now);
  broadcastToAllWindows(IPC.APP.AGENT_ATTENTION, orchestrator.id, {
    title: `${orchestrator.name} wants to start a helper`,
    message: `Helper "${args.name}": ${args.task}`.slice(0, 240),
  });
}

/**
 * The start path, for start_helper and for a start the user approved
 * (#2234). Every check runs both ways: orchestration on and the orchestrator
 * running, the limits under the start lock, the name, folder and branch rules
 * of the creation, and access clamped to the orchestrator's ceiling and to
 * what was asked. `approvedIn` (the request's project) skips only the
 * control-level gate, and requires the orchestrator to run in that project.
 */
async function runHelperStart(orchestratorId: string, args: HelperStartArgs, approvedIn?: string): Promise<StartOutcome> {
  validateStartArgs(args);
  if (approvedIn !== undefined) {
    const registration = agentRegistry.get(orchestratorId);
    if (!registration || !samePath(registration.projectPath, approvedIn)) {
      return refused('its orchestrator is not running in this project.');
    }
  }
  if (!isOrchestrationEnabled(orchestratorId)) return refused('orchestration is off for its orchestrator.');
  const { projectPath, config: orchestrator } = await resolveCaller(orchestratorId);
  const { name, task, persona, cli, model, access, branchFrom, folder } = args;

  return withStartLock(async (): Promise<StartOutcome> => {
    // Read again under the lock: a turn-off may have run while this waited.
    if (!isOrchestrationEnabled(orchestratorId)) return refused('orchestration is off for its orchestrator.');
    const limit = await checkHelperLimitFor(projectPath, orchestratorId);
    if (limit.ok === false) {
      appLog('core:mcp', 'info', 'start_helper refused by the helper limit', {
        meta: { agentId: orchestratorId, reason: limit.reason, helperCount: limit.helperCount, maxHelpers: limit.maxHelpers },
      });
      return refused(limit.message);
    }

    if (approvedIn === undefined) {
      const policy = await getOrchestrationPolicy(projectPath, orchestratorId);
      if (policy && policy.control !== 'hands-off') {
        // Refuse now what the start would refuse after approval (a bad or taken
        // name, folder or branch), so the user is never asked about one that
        // can't start. Approving runs every check again.
        try {
          await agentConfig.checkDurableCreation(projectPath, {
            name,
            color: pickColor(limit.helperCount),
            parentAgentId: orchestratorId,
            disposable: true,
            ...(folder && { folderName: folder }),
            ...(branchFrom && { branchFrom }),
          });
        } catch (err) {
          // telemetry-exempt: the refusal reaches the calling agent as the tool result
          return { kind: 'refused', message: `Could not start helper "${name}": ${errorText(err)}`, reason: asReason(errorText(err)) };
        }
        const recorded = recordStartRequest(projectPath, orchestratorId, orchestrator.name, args);
        if (recorded.ok === false) return { kind: 'too_many', waiting: recorded.waiting };
        noticeApprovalNeeded(orchestrator, args);
        appLog('core:mcp', 'info', 'start_helper needs user approval', {
          meta: { agentId: orchestratorId, control: policy.control, requestId: recorded.request.requestId, reused: recorded.reused },
        });
        return { kind: 'needs_approval', control: policy.control, request: recorded.request, reused: recorded.reused };
      }
    }

    const helperProvider = cli ?? orchestrator.orchestrator ?? agentRegistry.get(orchestratorId)?.orchestrator;
    const launch = await resolveLaunchFor(projectPath, orchestratorId, helperProvider, access);

    let started: Awaited<ReturnType<typeof startDurableCreation>>;
    try {
      started = await startDurableCreation(projectPath, {
        name,
        color: pickColor(limit.helperCount),
        ...(model && { model }),
        ...(helperProvider && { orchestrator: helperProvider as OrchestratorId }),
        freeAgentMode: launch.freeAgentMode,
        ...(persona && { persona }),
        parentAgentId: orchestratorId,
        disposable: true,
        ...(folder && { folderName: folder }),
        ...(branchFrom && { branchFrom }),
      }, {
        inject: persona
          ? async (created) => {
            if (!created.worktreePath) return;
            try {
              await applyPersonaToAgent(projectPath, created.id, persona, { appendToExisting: true });
            } catch (err) {
              // telemetry-exempt: logged; the helper starts without the persona
              appLog('core:mcp', 'warn', 'start_helper: persona not applied', {
                meta: { helperId: created.id, persona, error: errorText(err) },
              });
            }
          }
          : undefined,
      });
    } catch (err) {
      // telemetry-exempt: the refusal reaches the calling agent as the tool result
      // Refused up front: a bad or taken name, folder, branch or base.
      return { kind: 'refused', message: `Could not start helper "${name}": ${errorText(err)}`, reason: asReason(errorText(err)) };
    }

    const { agentId: helperId, config, done } = started;
    // Before anything is awaited: no wake may spawn it while this start owns it.
    spawning.add(helperId);
    const background = finishHelperStart(projectPath, orchestrator, helperId, name, task, access, done)
      .catch((err) => {
        appLog('core:mcp', 'error', 'start_helper: background start failed', { meta: { helperId, error: errorText(err) } });
      });
    inflight.add(background);
    void background.finally(() => inflight.delete(background));

    appLog('core:mcp', 'info', 'start_helper: creating helper', {
      meta: { agentId: orchestratorId, helperId, access: launch.level, clamped: launch.clamped, approved: approvedIn !== undefined },
    });
    return { kind: 'starting', helperId, name: config.name, ...(config.branch && { branch: config.branch }), launch };
  });
}

const PENDING_NOTE =
  'Waiting requests are kept in memory only: each expires after 24 hours and all are cleared when ' +
  'Clubhouse quits or your orchestration is turned off. If you hear nothing, ask the user or call start_helper again.';

async function startHelper(agentId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const outcome = await runHelperStart(agentId, parseStartArgs(args));
  switch (outcome.kind) {
    case 'refused':
      return textResult(outcome.message, true);
    case 'too_many':
      return textResult(
        `You already have ${outcome.waiting} helper starts waiting for the user's approval. ` +
        'Wait for an answer before asking for another.',
        true,
      );
    case 'needs_approval':
      return jsonResult({
        state: 'needs_approval',
        requestId: outcome.request.requestId,
        control: outcome.control,
        ...(outcome.reused && { reused: true }),
        expiresAt: outcome.request.expiresAt,
        message:
          (outcome.reused ? 'You already asked for this start, and it is still waiting. ' : '') +
          'This agent is set to ask the user before starting helpers, so nothing was created yet. ' +
          'The request is waiting for the user in Clubhouse, and you will get a message when they approve ' +
          `or decline it. ${PENDING_NOTE}`,
      });
    case 'starting':
      return jsonResult({
        helperId: outcome.helperId,
        name: outcome.name,
        state: 'starting',
        ...(outcome.branch && { branch: outcome.branch }),
        access: outcome.launch.level,
        ...(outcome.launch.clamped && { accessNote: `Access lowered to ${outcome.launch.level}: a helper never gets more than you run with or than its CLI allows at that level.` }),
        message:
          `Helper "${outcome.name}" is being created. Its worktree can take up to a minute; ` +
          'you will get a message when it has started its task, or why it failed. Its access is checked again at start.',
      });
  }
}

// ── Start approvals (#2234) ──────────────────────────────────────────────

const NOT_WAITING = 'That helper start is no longer waiting in this project. It was answered, expired or dropped.';

/**
 * Why an approval can't run yet, checked without awaiting anything: the
 * orchestrator must be running in the request's project with orchestration
 * on. A refusal here leaves the request waiting, so the user can wake the
 * orchestrator and approve again.
 */
function approvalBlocker(request: HelperStartRequest): string | null {
  const registration = agentRegistry.get(request.orchestratorId);
  if (!registration || !samePath(registration.projectPath, request.projectPath)) {
    return `Wake ${request.orchestratorName} to approve this start. It isn't running, so the request is still waiting.`;
  }
  if (!isOrchestrationEnabled(request.orchestratorId)) {
    return `Orchestration is off for ${request.orchestratorName}, so this start can't be approved.`;
  }
  return null;
}

/**
 * The user approved a held start. The orchestrator must be running with
 * orchestration on, else the request stays waiting. Then the request is used
 * up (nothing is awaited between the check and the take), so it runs once,
 * and the normal start path runs with every check but the control level. The
 * orchestrator is told the outcome in a fixed message built from what main
 * recorded.
 */
export async function approveHelperStart(projectPath: string, requestId: string): Promise<HelperStartDecisionResult> {
  const waiting = peekStartRequest(projectPath, requestId);
  if (!waiting) return { ok: false, message: NOT_WAITING };
  const blocker = approvalBlocker(waiting);
  if (blocker) return { ok: false, message: blocker };
  const request = takeStartRequest(projectPath, requestId);
  if (!request) return { ok: false, message: NOT_WAITING };
  const { orchestratorId, args } = request;
  let outcome: StartOutcome;
  try {
    outcome = await runHelperStart(orchestratorId, args, request.projectPath);
  } catch (err) {
    // telemetry-exempt: the reason reaches the user and the orchestrator
    outcome = refused(errorText(err));
  }
  const what = `helper "${args.name}" (request ${request.requestId})`;
  if (outcome.kind === 'starting') {
    await notifyOrchestrator(orchestratorId,
      `The user approved starting ${what}. It is being created as ${outcome.helperId} with ` +
      `${outcome.launch.level} access. You will get a message when it has started its task, or why it failed.`);
    return { ok: true, message: `Starting ${outcome.name}`, helperId: outcome.helperId };
  }
  const reason = outcome.kind === 'refused' ? outcome.reason : 'it could not be started.';
  appLog('core:mcp', 'info', 'Approved helper start refused', { meta: { orchestratorId, requestId, reason } });
  await notifyOrchestrator(orchestratorId, `The user approved starting ${what}, but it was not started because ${reason}`);
  return { ok: false, message: `Couldn’t start ${args.name} because ${reason}` };
}

/** The user declined a held start. Used up once; the orchestrator is told. */
export async function declineHelperStart(projectPath: string, requestId: string): Promise<HelperStartDecisionResult> {
  const request = takeStartRequest(projectPath, requestId);
  if (!request) return { ok: false, message: NOT_WAITING };
  appLog('core:mcp', 'info', 'Helper start declined', { meta: { orchestratorId: request.orchestratorId, requestId } });
  await notifyOrchestrator(request.orchestratorId,
    `The user declined your request to start helper "${request.args.name}" (request ${request.requestId}). Nothing was created.`);
  return { ok: true, message: 'Declined' };
}

/** Drop an orchestrator's held starts once it no longer orchestrates, or is disposed or deleted. Never throws. */
async function pruneStartRequests(projectPath: string, orchestratorId: string): Promise<void> {
  try {
    const config = await agentConfig.getDurableConfig(projectPath, orchestratorId);
    const policy = config && !isDisposedAgent(config) ? await getOrchestrationPolicy(projectPath, orchestratorId) : null;
    if (policy?.orchestrate) return;
    const dropped = dropStartRequestsFor(orchestratorId, projectPath);
    if (dropped.length > 0) {
      appLog('core:mcp', 'info', 'Held helper starts dropped', {
        meta: { orchestratorId, count: dropped.length, reason: !config ? 'deleted' : isDisposedAgent(config) ? 'disposed' : 'orchestration off' },
      });
    }
  } catch (err) {
    // telemetry-exempt: logged; an approve still runs every check
    appLog('core:mcp', 'warn', 'Could not check held helper starts', { meta: { orchestratorId, error: errorText(err) } });
  }
}

let unwatchStartRequests: (() => void) | null = null;

/**
 * Keep held starts in step with the app: `send` forwards added and closed
 * requests to the main window, and an orchestrator's requests are dropped
 * when its config changes or its gate closes and it no longer orchestrates.
 * Calling it again replaces the earlier watch. Returns the unwatch function.
 */
export function watchHelperStartRequests(send: (channel: string, payload: unknown) => void): () => void {
  unwatchStartRequests?.();
  const offChanges = onStartRequestsChanged((change) => {
    if (change.kind === 'added') send(IPC.AGENT.HELPER_START_REQUEST, change.request);
    else send(IPC.AGENT.HELPER_START_REQUESTS_CLOSED, change.requestIds);
  });
  const offConfig = agentConfig.onAgentConfigChanged((projectPath) => {
    for (const o of orchestratorsWithRequests()) {
      if (samePath(o.projectPath, projectPath)) void pruneStartRequests(o.projectPath, o.orchestratorId);
    }
  });
  const offGate = onOrchestrationGateChange((agentId) => {
    if (isOrchestrationEnabled(agentId)) return;
    for (const o of orchestratorsWithRequests()) {
      if (o.orchestratorId === agentId) void pruneStartRequests(o.projectPath, o.orchestratorId);
    }
  });
  const unwatch = () => {
    offChanges();
    offConfig();
    offGate();
    if (unwatchStartRequests === unwatch) unwatchStartRequests = null;
  };
  unwatchStartRequests = unwatch;
  return unwatch;
}

// ── list_helpers ─────────────────────────────────────────────────────────

type HelperStatus = 'creating' | 'starting' | 'failed' | 'stopping' | 'sleeping' | 'idle' | 'running'
  | 'waiting_permission' | 'waiting_input' | 'error';

function helperStatus(helper: DurableAgentConfig): { status: HelperStatus; reason?: string } {
  if (helper.creation?.state === 'creating') return { status: 'creating' };
  if (helper.creation?.state === 'failed') return { status: 'failed', reason: helper.creation.reason };
  if (spawning.has(helper.id)) return { status: 'starting' };
  // Told to sleep and not exited yet: neither running nor asleep.
  if (agentSystem.isAgentStopping(helper.id)) return { status: 'stopping' };
  if (agentSystem.isAgentRunning(helper.id)) {
    // Only a chat runtime knows its turn state; a terminal is just running.
    const runtime = getAgentRuntime(helper.id);
    const state = runtime?.kind === 'chat' ? runtime.getState() : 'running';
    return { status: state === 'sleeping' ? 'running' : state };
  }
  const failure = spawnFailures.get(helper.id);
  if (failure) return { status: 'failed', reason: failure };
  return { status: 'sleeping' };
}

/** The latest time Clubhouse saw the helper do anything: a session, a sleep, its creation. */
function lastActivity(helper: DurableAgentConfig): string | undefined {
  const times = [
    helper.createdAt,
    helper.creation?.heartbeatAt,
    helper.lastSleep?.at,
    ...(helper.sessionHistory ?? []).map((s) => s.lastActiveAt),
  ].filter((t): t is string => !!t && !Number.isNaN(Date.parse(t)));
  if (times.length === 0) return undefined;
  return times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

async function describeHelper(helper: DurableAgentConfig): Promise<Record<string, unknown>> {
  const { status, reason } = helperStatus(helper);
  const out: Record<string, unknown> = {
    helperId: helper.id,
    name: helper.name,
    status,
    ...(reason && { reason }),
    ...(helper.orchestrator && { cli: helper.orchestrator }),
    ...(helper.persona && { persona: helper.persona }),
    branch: helper.branch ?? null,
    lastActivity: lastActivity(helper) ?? null,
    ...(helper.pendingTask && !spawning.has(helper.id) && {
      taskPending: true,
      note: 'It never received its task (Clubhouse restarted or the start was stopped). wake_helper delivers it.',
    }),
  };
  if (!helper.creation && helper.worktreePath) {
    try {
      const git = await getGitInfo(helper.worktreePath);
      if (git.hasGit) {
        out.branch = git.branch || out.branch;
        // Against the branch's remote: commits not pushed, and not pulled.
        out.ahead = git.ahead;
        out.behind = git.behind;
        // Clubhouse's own config in the worktree is not the helper's work.
        out.dirty = (await withoutClubhouseOwnedChanges(helper.worktreePath, git.status)).length;
        if (git.log[0]) out.lastCommit = { subject: git.log[0].subject, when: git.log[0].date };
      }
    } catch (err) {
      // telemetry-exempt: the error is returned in the helper's entry
      out.gitError = errorText(err);
    }
  }
  return out;
}

async function listOwnHelpers(agentId: string): Promise<McpToolResult> {
  const caller = await resolveCaller(agentId);
  const helpers = (await agentConfig.listHelpers(caller.projectPath, agentId)).filter((h) => !isDisposedAgent(h));
  const described = await Promise.all(helpers.map(describeHelper));
  return jsonResult({ helpers: described });
}

// ── sleep_helper / wake_helper ───────────────────────────────────────────

async function sleepHelper(agentId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const ref = requireText(args, 'helper');
  const caller = await resolveCaller(agentId);
  const helper = await resolveOwnHelper(caller, ref);
  if (helper.creation) {
    throw new HelperToolError(helper.creation.state === 'creating'
      ? `${helper.name} is still being created.`
      : `${helper.name} failed to create: ${helper.creation.reason ?? 'unknown reason'}`);
  }
  if (!agentSystem.isAgentRunning(helper.id)) {
    return jsonResult({ helperId: helper.id, name: helper.name, status: 'already_sleeping' });
  }
  // Returns once the process has exited, so list_helpers and wake_helper see
  // it asleep. A sleep already under way (from here or the app) is waited on.
  if (agentSystem.isAgentStopping(helper.id)) {
    await agentSystem.waitForAgentStopped(helper.id);
  } else {
    await agentSystem.killAgent(helper.id, caller.projectPath, helper.orchestrator, 'agent_tool', { by: caller.config.name, waitForExit: true });
  }
  if (agentSystem.isAgentRunning(helper.id)) {
    appLog('core:mcp', 'warn', 'sleep_helper: helper has not exited', { meta: { agentId, helperId: helper.id } });
    return jsonResult({
      helperId: helper.id, name: helper.name, status: 'stopping',
      note: 'It was told to stop but has not exited yet. Check list_helpers before waking it.',
    });
  }
  broadcastToAllWindows(IPC.AGENT.AGENT_SLEEPING, helper.id);
  appLog('core:mcp', 'info', 'sleep_helper: helper put to sleep', { meta: { agentId, helperId: helper.id } });
  return jsonResult({ helperId: helper.id, name: helper.name, status: 'sleeping' });
}

/** The wake result for a helper that is still exiting: nothing was sent and nothing started. */
function stillStopping(helper: DurableAgentConfig, message: string | undefined): McpToolResult {
  return jsonResult({
    helperId: helper.id, name: helper.name, status: 'stopping',
    ...(message && { messageDelivered: false }),
    note: 'It is still shutting down. Call wake_helper again once list_helpers shows it sleeping.',
  });
}

async function wakeHelper(agentId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const ref = requireText(args, 'helper');
  const message = optionalText(args, 'message');
  const caller = await resolveCaller(agentId);
  let helper = await resolveOwnHelper(caller, ref);
  if (agentSystem.isAgentStopping(helper.id)) {
    // Asleep in a moment: wait for the exit, then wake it for real, so the
    // message goes to a new session instead of the one that is exiting.
    if (!(await agentSystem.waitForAgentStopped(helper.id))) return stillStopping(helper, message);
    // Re-read: the exit just saved the session id the wake resumes.
    helper = await resolveOwnHelper(caller, helper.id);
  }
  if (helper.creation) {
    throw new HelperToolError(helper.creation.state === 'creating'
      ? `${helper.name} is still being created. You will get a message when it has started.`
      : `${helper.name} failed to create: ${helper.creation.reason ?? 'unknown reason'}`);
  }
  if (spawning.has(helper.id)) {
    return jsonResult({
      helperId: helper.id, name: helper.name, status: 'starting',
      ...(message && { messageDelivered: false, note: 'It is still starting; send the message once it is running.' }),
    });
  }
  if (agentSystem.isAgentRunning(helper.id)) {
    // A sleep that began while the helper was re-read.
    if (agentSystem.isAgentStopping(helper.id)) return stillStopping(helper, message);
    const delivery = message ? await deliverToAgent(helper.id, `[FROM:${caller.config.name}] ${message}`) : undefined;
    if (delivery === 'stopping') return stillStopping(helper, message);
    const delivered = delivery === 'delivered';
    return jsonResult({ helperId: helper.id, name: helper.name, status: 'already_running', ...(message && { messageDelivered: delivered }) });
  }

  // Claimed before anything is awaited, so a parallel wake (or a start) can't spawn it too.
  spawning.add(helper.id);
  spawnFailures.delete(helper.id);
  const fromCaller = message ? `[FROM:${caller.config.name}] ${message}` : undefined;
  // A task start_helper never got to deliver goes first (#2227 restart recovery).
  const mission = helper.pendingTask
    ? [helperMission(caller.config.name, helper.pendingTask), fromCaller].filter(Boolean).join('\n\n')
    : fromCaller;
  const resume = !!helper.lastSessionId;
  let launch: HelperLaunch;
  let taskTaken = false;
  try {
    const provider = helper.orchestrator ?? caller.config.orchestrator;
    // Never above what start_helper asked for.
    launch = await resolveLaunchFor(caller.projectPath, agentId, provider, helper.requestedAccess);
    if (helper.pendingTask) {
      // Taken off first so it is delivered once; put back if the spawn fails.
      await agentConfig.setHelperStartFields(caller.projectPath, helper.id, { pendingTask: null });
      taskTaken = true;
    }
    broadcastToAllWindows(IPC.AGENT.AGENT_WAKING, helper.id);
    await agentSystem.spawnAgent({
      agentId: helper.id,
      projectPath: caller.projectPath,
      cwd: helper.worktreePath || caller.projectPath,
      kind: 'durable',
      model: helper.model,
      ...(mission && { mission }),
      orchestrator: provider,
      freeAgentMode: launch.freeAgentMode,
      permissionMode: launch.permissionMode,
      resume,
      ...(resume && { sessionId: helper.lastSessionId }),
    });
  } catch (err) {
    const reason = errorText(err);
    if (taskTaken && helper.pendingTask) await restoreTask(caller.projectPath, helper.id, helper.pendingTask);
    spawnFailures.set(helper.id, reason);
    broadcastToAllWindows(IPC.AGENT.AGENT_WAKE_FAILED, helper.id, reason);
    throw new HelperToolError(`Could not wake ${helper.name}: ${reason}`);
  } finally {
    spawning.delete(helper.id);
  }
  appLog('core:mcp', 'info', 'wake_helper: helper woken', { meta: { agentId, helperId: helper.id, resume, access: launch.level } });
  return jsonResult({
    helperId: helper.id, name: helper.name, status: 'running', resumed: resume, access: launch.level,
    ...(helper.pendingTask && { taskDelivered: true }),
  });
}

// ── message_parent ───────────────────────────────────────────────────────

async function messageParent(agentId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  // `message` is what send_message and wake_helper call it; take it too (#2366).
  const text = optionalText(args, 'text') ?? optionalText(args, 'message');
  if (!text) throw new McpArgError('Missing required argument: text (the message for your parent).');
  const registration = agentRegistry.get(agentId);
  const self = registration ? await agentConfig.getDurableConfig(registration.projectPath, agentId) : null;
  if (!registration || !self?.parentAgentId) {
    throw new HelperToolError('message_parent is only for helper agents, and you have no parent agent.');
  }
  const parent = await agentConfig.getDurableConfig(registration.projectPath, self.parentAgentId);
  if (!parent || isDisposedAgent(parent)) throw new HelperToolError('Your parent agent no longer exists.');
  const delivery = await deliverToAgent(parent.id, `[FROM HELPER:${self.name} (${self.id})] ${text}`);
  if (delivery === 'stopping') {
    throw new HelperToolError(`${parent.name} is shutting down, so the message was not delivered.`);
  }
  if (delivery !== 'delivered') throw new HelperToolError(`${parent.name} is asleep, so the message was not delivered.`);
  appLog('core:mcp', 'info', 'message_parent: delivered', { meta: { agentId, parentId: parent.id, length: text.length } });
  return textResult(`Message sent to ${parent.name}.`);
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerHelperTools(): void {
  registerGlobalTool(
    'start_helper',
    {
      description:
        'Start a helper agent of your own, in its own worktree, and give it a task. Returns at once ' +
        'with the helper id in the "starting" state: making the worktree can take up to a minute. ' +
        'You get a message when the helper has started its task, or why it failed. The helper can ' +
        'reply with message_parent, and you can message it over the wire Clubhouse adds between you. ' +
        'Its access is never more than yours. If you are set to ask the user before starting helpers, ' +
        'it returns "needs_approval" with a requestId instead, and you get a message when the user ' +
        'approves or declines.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The helper\'s name (also its default folder).' },
          task: { type: 'string', description: 'The task, sent as the helper\'s first message.' },
          persona: { type: 'string', description: 'Optional persona id to apply.' },
          cli: { type: 'string', description: 'Optional CLI provider id (e.g. claude-code, codex-cli, copilot-cli). Defaults to yours.' },
          model: { type: 'string', description: 'Optional model for the helper.' },
          access: { type: 'string', enum: ['same', ...ACCESS_LEVELS], description: 'Access level: same (default) or a lower one. Never more than yours.' },
          branchFrom: { type: 'string', description: 'Optional branch or commit the helper\'s branch starts from. Defaults to HEAD.' },
          folder: { type: 'string', description: 'Optional folder name under .clubhouse/agents/. Defaults to the name.' },
        },
        required: ['name', 'task'],
      },
    },
    (agentId, args) => guarded('start_helper', agentId, () => startHelper(agentId, args)),
    { group: 'orchestration' },
  );

  registerGlobalTool(
    'list_helpers',
    {
      description:
        'List your helpers: status (creating, starting, running, idle, waiting, stopping, sleeping or failed), ' +
        'branch, commits ahead of and behind its remote branch, uncommitted files, last commit and last activity.',
      inputSchema: { type: 'object', properties: {} },
    },
    (agentId) => guarded('list_helpers', agentId, () => listOwnHelpers(agentId)),
    { group: 'orchestration' },
  );

  registerGlobalTool(
    'sleep_helper',
    {
      description: 'Put one of your helpers to sleep. Returns once it has stopped. Its worktree and session stay; wake_helper resumes it.',
      inputSchema: {
        type: 'object',
        properties: { helper: { type: 'string', description: 'The helper\'s id or name.' } },
        required: ['helper'],
      },
    },
    (agentId, args) => guarded('sleep_helper', agentId, () => sleepHelper(agentId, args)),
    { group: 'orchestration' },
  );

  registerGlobalTool(
    'wake_helper',
    {
      description:
        'Wake one of your sleeping helpers, resuming its last session, optionally with a message. ' +
        'A running helper just gets the message.',
      inputSchema: {
        type: 'object',
        properties: {
          helper: { type: 'string', description: 'The helper\'s id or name.' },
          message: { type: 'string', description: 'Optional message for the helper.' },
        },
        required: ['helper'],
      },
    },
    (agentId, args) => guarded('wake_helper', agentId, () => wakeHelper(agentId, args)),
    { group: 'orchestration' },
  );

  registerGlobalTool(
    'message_parent',
    {
      description:
        'For helper agents: send a message to the agent that started you (your parent), such as ' +
        'progress, a question or your result. Agents without a parent get an error.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message.' },
          message: { type: 'string', description: 'Same as text, for callers that use that name.' },
        },
      },
    },
    (agentId, args) => guarded('message_parent', agentId, () => messageParent(agentId, args)),
  );
}

/** For testing: wait for every background start, then forget the start state. */
export async function _settleHelperStartsForTesting(): Promise<void> {
  while (inflight.size > 0) await Promise.all([...inflight]);
}

export function _resetHelperToolsForTesting(): void {
  unwatchStartRequests?.();
  spawning.clear();
  spawnFailures.clear();
  inflight.clear();
  startChain = Promise.resolve();
  lastApprovalNotice.clear();
}
