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
 * Every tool is scoped to the caller's direct children: one orchestrator
 * never sees or touches another's helpers.
 */

import * as path from 'path';
import { registerGlobalTool } from '../tool-registry';
import { isOrchestrationEnabled } from '../orchestration-gate';
import type { McpToolResult } from '../types';
import * as agentConfig from '../../agent-config';
import { agentRegistry } from '../../agent-registry';
import { startDurableCreation } from '../../agent-creation';
import * as agentSystem from '../../agent-system';
import { getAgentRuntime } from '../../agent-runtime';
import { getGitInfo } from '../../git-service';
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
} from '../../../../shared/orchestration-policy';
import type { DurableAgentConfig } from '../../../../shared/types';
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

/**
 * Deliver text to a running agent's input, as Clubhouse MCP send_message
 * does. Returns false when the agent isn't running.
 */
async function deliverToAgent(targetId: string, text: string): Promise<boolean> {
  const runtime = getAgentRuntime(targetId);
  if (!runtime) return false;
  await runtime.sendMessage(text, { source: 'mcp', taskId: `helper_${Date.now().toString(36)}` });
  return true;
}

/** Tell an orchestrator what happened to a helper. Never throws. */
async function notifyOrchestrator(orchestratorId: string, text: string): Promise<void> {
  try {
    if (await deliverToAgent(orchestratorId, `[Clubhouse] ${text}`)) return;
    appLog('core:mcp', 'warn', 'Helper update not delivered: the orchestrator is not running', {
      meta: { orchestratorId },
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

async function startHelper(agentId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const name = requireText(args, 'name');
  const task = requireText(args, 'task');
  const persona = optionalText(args, 'persona');
  const cli = optionalText(args, 'cli');
  const model = optionalText(args, 'model');
  const access = optionalText(args, 'access');
  const branchFrom = optionalText(args, 'branchFrom');
  const folder = optionalText(args, 'folder');
  if (access && access !== 'same' && !isAccessLevel(access)) {
    throw new McpArgError(`access must be one of: same, ${ACCESS_LEVELS.join(', ')}`);
  }
  if (cli && !getProvider(cli as OrchestratorId)) {
    throw new McpArgError(`Unknown cli "${cli}". Available: ${getAllProviders().map((p) => p.id).join(', ')}`);
  }

  const caller = await resolveCaller(agentId);
  const { projectPath, config: orchestrator } = caller;

  return withStartLock(async () => {
    const limit = await checkHelperLimitFor(projectPath, agentId);
    if (limit.ok === false) {
      appLog('core:mcp', 'info', 'start_helper refused by the helper limit', {
        meta: { agentId, reason: limit.reason, helperCount: limit.helperCount, maxHelpers: limit.maxHelpers },
      });
      return textResult(limit.message, true);
    }

    const policy = await getOrchestrationPolicy(projectPath, agentId);
    if (policy && policy.control !== 'hands-off') {
      // TODO(#2232): a pending approval the user can accept from the
      // Orchestrate card. There is no approve/deny round trip in main yet,
      // so the start is refused and the user is notified through the
      // existing Needs-you notification, at most once a minute.
      const now = Date.now();
      const last = lastApprovalNotice.get(agentId);
      if (last === undefined || now - last >= APPROVAL_NOTICE_INTERVAL_MS) {
        lastApprovalNotice.set(agentId, now);
        broadcastToAllWindows(IPC.APP.AGENT_ATTENTION, agentId, {
          title: `${orchestrator.name} wants to start a helper`,
          message: `Helper "${name}": ${task}`.slice(0, 240),
        });
      }
      appLog('core:mcp', 'info', 'start_helper needs user approval', { meta: { agentId, control: policy.control } });
      return jsonResult({
        state: 'needs_approval',
        control: policy.control,
        message:
          'This agent is set to ask the user before starting helpers, and the user has been notified. ' +
          'Clubhouse cannot take that approval yet: ask the user in your conversation, and they can ' +
          'start the helper themselves or set your Control level to hands-off.',
      });
    }

    const helperProvider = cli ?? orchestrator.orchestrator ?? agentRegistry.get(agentId)?.orchestrator;
    const launch = await resolveLaunchFor(projectPath, agentId, helperProvider, access);

    let started: Awaited<ReturnType<typeof startDurableCreation>>;
    try {
      started = await startDurableCreation(projectPath, {
        name,
        color: pickColor(limit.helperCount),
        ...(model && { model }),
        ...(helperProvider && { orchestrator: helperProvider as OrchestratorId }),
        freeAgentMode: launch.freeAgentMode,
        ...(persona && { persona }),
        parentAgentId: agentId,
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
      return textResult(`Could not start helper "${name}": ${errorText(err)}`, true);
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
      meta: { agentId, helperId, access: launch.level, clamped: launch.clamped },
    });
    return jsonResult({
      helperId,
      name: config.name,
      state: 'starting',
      ...(config.branch && { branch: config.branch }),
      access: launch.level,
      ...(launch.clamped && { accessNote: `Access lowered to ${launch.level}: a helper never gets more than you run with or than its CLI allows at that level.` }),
      message:
        `Helper "${config.name}" is being created. Its worktree can take up to a minute; ` +
        'you will get a message when it has started its task, or why it failed. Its access is checked again at start.',
    });
  });
}

// ── list_helpers ─────────────────────────────────────────────────────────

type HelperStatus = 'creating' | 'starting' | 'failed' | 'sleeping' | 'idle' | 'running'
  | 'waiting_permission' | 'waiting_input' | 'error';

function helperStatus(helper: DurableAgentConfig): { status: HelperStatus; reason?: string } {
  if (helper.creation?.state === 'creating') return { status: 'creating' };
  if (helper.creation?.state === 'failed') return { status: 'failed', reason: helper.creation.reason };
  if (spawning.has(helper.id)) return { status: 'starting' };
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
        out.dirty = git.status.length;
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
  await agentSystem.killAgent(helper.id, caller.projectPath, helper.orchestrator, 'agent_tool', { by: caller.config.name });
  broadcastToAllWindows(IPC.AGENT.AGENT_SLEEPING, helper.id);
  appLog('core:mcp', 'info', 'sleep_helper: helper put to sleep', { meta: { agentId, helperId: helper.id } });
  return jsonResult({ helperId: helper.id, name: helper.name, status: 'sleeping' });
}

async function wakeHelper(agentId: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const ref = requireText(args, 'helper');
  const message = optionalText(args, 'message');
  const caller = await resolveCaller(agentId);
  const helper = await resolveOwnHelper(caller, ref);
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
    const delivered = message ? await deliverToAgent(helper.id, `[FROM:${caller.config.name}] ${message}`) : false;
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
  const text = requireText(args, 'text');
  const registration = agentRegistry.get(agentId);
  const self = registration ? await agentConfig.getDurableConfig(registration.projectPath, agentId) : null;
  if (!registration || !self?.parentAgentId) {
    throw new HelperToolError('message_parent is only for helper agents, and you have no parent agent.');
  }
  const parent = await agentConfig.getDurableConfig(registration.projectPath, self.parentAgentId);
  if (!parent || isDisposedAgent(parent)) throw new HelperToolError('Your parent agent no longer exists.');
  const delivered = await deliverToAgent(parent.id, `[FROM HELPER:${self.name} (${self.id})] ${text}`);
  if (!delivered) throw new HelperToolError(`${parent.name} is asleep, so the message was not delivered.`);
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
        'Its access is never more than yours.',
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
        'List your helpers: status (creating, starting, running, idle, waiting, sleeping or failed), ' +
        'branch, commits ahead of and behind its remote branch, uncommitted files, last commit and last activity.',
      inputSchema: { type: 'object', properties: {} },
    },
    (agentId) => guarded('list_helpers', agentId, () => listOwnHelpers(agentId)),
    { group: 'orchestration' },
  );

  registerGlobalTool(
    'sleep_helper',
    {
      description: 'Put one of your helpers to sleep. Its worktree and session stay; wake_helper resumes it.',
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
        properties: { text: { type: 'string', description: 'The message.' } },
        required: ['text'],
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
  spawning.clear();
  spawnFailures.clear();
  inflight.clear();
  startChain = Promise.resolve();
  lastApprovalNotice.clear();
}
