import { readCopilotHooksConfig } from '../orchestrators/copilot-hooks-config';
import { AgentResumeError, assertProviderSelection } from './agent-transition';
import { withManagedActivationLaunch } from './managed-activation';
import type { ManagedLaunchLease } from './managed-activation/service';
import { ManagedActivationError, ProcessStartedReceiptError } from './managed-activation/types';
import { cleanupManagedReceiptFailure, recordManagedProcessStart } from './managed-activation/runtime-start';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getProvider, getAllProviders, OrchestratorId, OrchestratorProvider, isHookCapable, isHeadlessCapable, isSessionCapable } from '../orchestrators';
import { waitReady as waitHookServerReady, portEnv as hookPortEnv } from './hook-server';
import * as ptyManager from './pty-manager';
import { appLog } from './log-service';
import { recordBreadcrumb } from './breadcrumbs';
import * as headlessManager from './headless-manager';
import * as headlessSettings from './headless-settings';
import * as freeAgentSettings from './free-agent-settings';
import * as orchestratorSettings from './orchestrator-settings';
import * as configPipeline from './config-pipeline';
import { getDurableConfig, addSessionEntry, updateDurableConfig } from './agent-config';
import type { QuickManagedLaunch } from './managed-agents/delivery';
import { isDisposedAgent, isEffortValue } from '../../shared/agent-helpers';
import { cleanupStaleJsonInTomlConfigs } from './toml-config-cleanup';
import { readProjectAgentDefaults, readLaunchWrapper, readDefaultMcps, readMcpConfigs } from './agent-settings-service';
import { applyLaunchWrapper, validateWrapperConfig } from '../orchestrators/shared';
import type { DurableAgentConfig, LaunchWrapperConfig, FreeAgentPermissionMode, QuickTemplateChoice } from '../../shared/types';
import type { RoutedMessagePart } from '../../shared/chat';
import { agentRegistry, resolveOrchestrator, untrackAgent, readProjectOrchestrator, DEFAULT_ORCHESTRATOR } from './agent-registry';
import { waitReady as waitMcpBridgeReady } from './clubhouse-mcp/bridge-server';
import { injectClubhouseMcp } from './clubhouse-mcp/injection';
import { syncDispatcherGate } from './clubhouse-mcp/dispatcher-gate';
import { setMcpCaller, setMcpCallerQuick, setMcpCallerUnreadable } from './clubhouse-mcp/mcp-call-gate';
import { isDispatcherPath } from './dispatcher/dispatcher-paths';
import { dispatcherEnablement } from './dispatcher/dispatcher-settings';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { ensureMcpBridge } from './mcp-bridge-starter';
import { resolveHelperLaunchSettings, syncOrchestrationGate } from './orchestration-policy';
import { findParent } from './helper-index';
import {
  isLowerAccess,
  launchAccessFor,
  providerAccessLevel,
  rankHelperLaunch,
  type AgentAccessLevel,
  type AgentLaunchAccess,
  type HelperLaunch,
} from '../../shared/orchestration-policy';
import {
  ACCESS_LEVELS, accessForLegacyToggle, accessFromLegacy, accessLabel, isAccessLevel, legacyLaunchFor, quickToolsForAccess, savedAccess, startableAccess, type AccessLevel,
} from '../../shared/agent-access';

/** The lower of two levels. */
function lowerAccess(a: AccessLevel, b: AccessLevel): AccessLevel {
  return ACCESS_LEVELS.indexOf(a) <= ACCESS_LEVELS.indexOf(b) ? a : b;
}
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { publishAppEvent } from './app-event-bus';
import { beginQuickAgentRun, finishQuickAgentRun, noteQuickAgentStop } from './quick-agent-events';
import type { QuickAgentOwner } from '../../shared/types';
import { IPC } from '../../shared/ipc-channels';
import * as os from 'os';
import { getAgentRuntime, isChatAgent } from './agent-runtime';
import { cancelChatStart, tryStartChatAgent, type ChatRuntimeNotice, type ChatStartFacts, type ChatStartResult } from './agent-runtime/chat-spawn';
import { clearStaleResume, isSessionNotFound, noteNextStartNotice, takeChatStartFailure, takeNextStartNotices, type StaleResumeReason } from './agent-runtime/stale-session';
import { removedProfileStateDirs } from './provider-profiles-removed';
import { noteKillRequest, recordSleep, sleepInfoForExit, takeKillRequest } from './agent-runtime/sleep-reason';
import { onAgentExit } from './agent-exit-broadcast';
import { sessionCaptureFor, trackSessionCapture, noteSessionCaptureFailure } from './session-capture-barrier';
import { assertLaunchesOpen } from './launch-gate';
import { ATTR } from '../../shared/telemetry/attributes';
import { tel, tagError, withErrorType } from '../telemetry/facade';
import { contextWindowForLaunch } from './context-window';
import { agentKillRequested, clearSpawnKind, noteSpawnKind } from '../telemetry/agent-telemetry';
import { recordChatStart, recordSpawn, spawnAttrs, type SpawnFacts } from '../telemetry/spawn-telemetry';
import {
  recordResumeOutcome, recordSessionCapture, recordStaleSessionCleared,
  type SessionCaptureResult, type SessionCaptureSource, type SessionResumeResult, type SessionStaleReason,
} from '../telemetry/session-telemetry';

/** Expand leading `~` or `~/` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Re-export registry functions for backward compatibility
export { getAgentProjectPath, getAgentOrchestrator, getAgentNonce, untrackAgent, resolveOrchestrator } from './agent-registry';

export interface SpawnAgentParams {
  agentId: string;
  projectPath: string;
  cwd: string;
  kind: 'durable' | 'quick' | 'companion';
  name?: string;
  parentAgentId?: string;
  /** Main-process launch provenance, set before a process can emit events. */
  quickOwner?: QuickAgentOwner;
  chain?: string[];
  model?: string;
  /** Filled in from a durable agent's config, once checked for this launch (#2660). */
  contextWindow?: string;
  /** Why the saved choice wasn't used for this launch. */
  contextWindowNotice?: ChatRuntimeNotice;
  /** Read from a durable agent's config here, so every start and wake gets it (#2671). */
  effort?: string;
  mission?: string;
  /** Who sent the mission, for chat to show. The mission text itself is what the agent gets. */
  missionRouted?: RoutedMessagePart[];
  systemPrompt?: string;
  allowedTools?: string[];
  orchestrator?: OrchestratorId;
  maxTurns?: number;
  maxBudgetUsd?: number;
  freeAgentMode?: boolean;
  /** Access (#2761): the level to start at. Wins over `freeAgentMode` and `permissionMode`, which are derived from it. */
  access?: AccessLevel;
  /** When true, attempt to resume the previous CLI session instead of starting fresh */
  resume?: boolean;
  /** Guided resume must fail rather than substitute a fresh conversation. */
  strictResume?: boolean;
  /** Specific session ID to resume (provider-specific format) */
  sessionId?: string;
  /** Plugin ID that owns this companion agent (required when kind === 'companion'). @since 0.9 */
  pluginOwner?: string;
  /** Path to companion workspace (auto-set for companion agents). @since 0.9 */
  companionWorkspace?: string;
  /** Permission mode override for resume (preserves pre-restart mode) */
  permissionMode?: FreeAgentPermissionMode;
  /**
   * Started for a person to talk to, e.g. from a phone. A quick agent then
   * follows the provider's Chat / CLI setting like a durable one,
   * instead of the project's headless spawn mode.
   */
  interactive?: boolean;
  /**
   * A quick agent no one is watching (an Action's step, #3033): it runs
   * headless whatever the project's spawn mode, and fails to start rather
   * than open a terminal where it could stop at a prompt.
   */
  headless?: boolean;
  /** CLI agent name to load (e.g. --agent k8s-assistant) */
  agentFile?: string;
  /** Source directory for agent file (e.g. --source ~/.copilot/agents/) */
  agentSource?: string;
  /**
   * Clubhouse-managed quick agents (#2893, D25): build a quick agent from this
   * template. Its instructions go in the system prompt and its MCP servers in
   * the launch flags; nothing is written into the folder it runs in.
   */
  managedTemplate?: QuickTemplateChoice;
}

export function isHeadlessAgent(agentId: string): boolean {
  return headlessManager.isHeadless(agentId);
}

/**
 * Whether an agent currently has a live session in the main process — a PTY or
 * a headless run. Live sessions outlive the renderer window, so this is the
 * source of truth when a reopened window reconciles status (see
 * `getRunningAgentIds`).
 */
export function isAgentRunning(agentId: string): boolean {
  return ptyManager.isRunning(agentId) || isHeadlessAgent(agentId) || isChatAgent(agentId);
}

/**
 * Whether an agent was told to stop and its PTY has not exited yet. Such an
 * agent still counts as running, but anything written to it is lost.
 */
export function isAgentStopping(agentId: string): boolean {
  return ptyManager.isStopping(agentId);
}

/**
 * Wait for an agent that is stopping to exit, and for the session id its exit
 * captures, so a wake right after resumes the right session. Resolves true
 * once the agent has no live session, false if it is still alive after the
 * kill timeout.
 */
export async function waitForAgentStopped(agentId: string): Promise<boolean> {
  if (ptyManager.isRunning(agentId)) {
    // Registered before the check below can yield, so the exit can't slip past.
    const exited = waitForAgentExit(agentId);
    await settleKill(agentId, exited);
  } else {
    // Exited already; its session capture may still be in flight.
    while (sessionCaptureFor(agentId)) await sessionCaptureFor(agentId);
  }
  return !isAgentRunning(agentId);
}

/**
 * Given a set of candidate agent IDs, return those with a live session. Used by
 * the renderer to reconcile durable-agent status on window reopen so genuinely
 * running agents don't briefly show as 'sleeping' until the next poll tick.
 */
export function getRunningAgentIds(agentIds: string[]): string[] {
  return agentIds.filter(isAgentRunning);
}

/** Spawns in progress; shutdown lets them settle before stopping runtimes (#2053). */
const inflightSpawns = new Set<Promise<void>>();

/** Resolves once every spawn in progress, including ones started meanwhile, has settled. */
export async function whenSpawnsSettled(): Promise<void> {
  while (inflightSpawns.size) await Promise.allSettled([...inflightSpawns]);
}

/** Why a helper didn't start: without the bridge it couldn't report to its parent (#2610). */
function helperMcpError(err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  return tagError(new Error(`This helper needs Clubhouse MCP to report to its orchestrator, and it couldn't be set up: ${detail}`), 'preflight_failed');
}

/**
 * The bridge always runs; this retries one that failed to start at app start.
 * A helper can't start without it (#2610).
 */
async function prepareMcpBridge(config: DurableAgentConfig | null | undefined): Promise<void> {
  ensureMcpBridge();
  if (!config?.parentAgentId) return;
  await waitMcpBridgeReady().catch((err: unknown) => { throw helperMcpError(err); });
}

/**
 * The launch access a helper may start with: `asked` (what the caller passed,
 * or the project's free-agent setting filled in for it), lowered to its
 * orchestrator's ceiling and the access start_helper asked for, ranked for
 * the CLI it really runs. Only ever lowers: a caller asking for less keeps it.
 *
 * Every wake goes through here, not only wake_helper: the sidebar, the
 * sleeping-agent view, the Helpers card, review, the plugin API and resume
 * pass no permission mode, so without this a helper started at Auto would
 * come back at the project's setting (possibly skip-all).
 *
 * The ceiling is the orchestrator's live level, read from the orchestrator's
 * own project, which may not be the helper's (#2513). An orchestrator that
 * isn't running (or can't be found or read) counts as standard, so a helper the user wakes
 * while its orchestrator sleeps starts at standard. That is deliberate. A
 * user can raise a chat helper afterwards from the chat level menu
 * (setUserLaunchAccess); a terminal (PTY) helper has no such path and stays
 * at its cap until it is restarted.
 */
async function capHelperLaunch(
  projectPath: string,
  agentId: string,
  helper: DurableAgentConfig & { parentAgentId: string },
  providerId: string,
  asked: AgentLaunchAccess,
): Promise<AgentLaunchAccess & { ceiling: AgentAccessLevel; ceilingAccess: AccessLevel }> {
  let cap: Pick<HelperLaunch, 'freeAgentMode' | 'permissionMode' | 'level' | 'access'>;
  let ceilingAccess: AccessLevel = 'ask';
  try {
    const parent = await findParent(projectPath, helper);
    if (!parent) throw new Error('Orchestrator not found');
    const resolved = await resolveHelperLaunchSettings(parent.projectPath, helper.parentAgentId, { helperProvider: providerId });
    cap = rankHelperLaunch(resolved, helper.requestedAccess, providerId);
    // The five-level ceiling (#3000): the orchestrator's live level, lowered to what start_helper asked.
    ceilingAccess = cap.access;
  } catch (err) {
    // telemetry-exempt: fails safe to standard and is logged; the spawn goes on.
    appLog('core:orchestration', 'warn', 'Could not resolve a helper\'s ceiling; starting it at standard', {
      meta: { agentId, orchestratorId: helper.parentAgentId, error: err instanceof Error ? err.message : String(err) },
    });
    cap = { ...launchAccessFor('standard'), level: 'standard', access: 'ask' };
  }
  const askedLevel = providerAccessLevel(providerId, asked);
  if (!isLowerAccess(cap.level, askedLevel)) return { ...asked, ceiling: cap.level, ceilingAccess };
  appLog('core:orchestration', 'info', 'Lowered a helper\'s launch access to its orchestrator\'s ceiling', {
    meta: { agentId, orchestratorId: helper.parentAgentId, asked: askedLevel, level: cap.level },
  });
  return { freeAgentMode: cap.freeAgentMode, permissionMode: cap.permissionMode, ceiling: cap.level, ceilingAccess };
}

/**
 * The Access a start uses (#2761). An explicit level wins. A legacy on/off
 * (the plugin API, an older phone, a restart entry from before #2761) keeps
 * the agent's saved level when it agrees, else maps with the old mode. A
 * durable agent otherwise starts at its saved level, and a quick agent at
 * Ask first, as with Free Agent Mode off.
 */
export function spawnAccess(
  params: Pick<SpawnAgentParams, 'access' | 'freeAgentMode' | 'permissionMode'>,
  config: { access?: unknown; freeAgentMode?: boolean } | null | undefined,
  legacyMode: FreeAgentPermissionMode,
): AccessLevel {
  if (isAccessLevel(params.access)) return params.access;
  const saved = config ? savedAccess(config, legacyMode) : 'ask';
  if (params.freeAgentMode === undefined) return saved;
  // A restart entry's mode is what the agent ran with; it wins over the saved level.
  if (params.freeAgentMode && params.permissionMode !== undefined) return accessFromLegacy(true, params.permissionMode);
  return accessForLegacyToggle(saved, params.freeAgentMode, legacyMode);
}

/** The agent is up: tell windows, and the app event bus (#2950). */
function announceAwake(agentId: string): void {
  broadcastToAllWindows(IPC.AGENT.AGENT_AWOKE, agentId);
  publishAppEvent({ type: 'agent.awake', agentId });
}

/** Shown when a wake asks to resume a quarantined session (#3240). */
export const RESUME_BLOCKED_NOTICE = "That session kept failing every turn, so it isn't resumed. A new session started instead.";

export async function spawnAgent(params: SpawnAgentParams): Promise<void> {
  // Quit and update close this before stopping runtimes (#2053).
  assertLaunchesOpen();
  const quickRun = params.kind === 'quick' ? beginQuickAgentRun(params) : undefined;
  const spawn = withManagedActivationLaunch(params, () => isAgentRunning(params.agentId), (managed) => {
    assertProviderSelection(params.agentId, params.orchestrator);
    return spawnAgentTracked(params, managed);
  });
  inflightSpawns.add(spawn);
  try {
    await spawn;
  } catch (error) {
    if (quickRun && !(error instanceof ProcessStartedReceiptError)) finishQuickAgentRun(quickRun, 'failed');
    throw error;
  } finally {
    inflightSpawns.delete(spawn);
  }
}

async function spawnAgentTracked(params: SpawnAgentParams, managed: ManagedLaunchLease | null): Promise<void> {
  const facts: SpawnFacts = { model: params.model };
  const startMs = Date.now();
  await tel.flow(
    'clubhouse.agent.spawn',
    { attrs: [ATTR.agentKind(params.kind), ATTR.agentResume(params.resume === true)] },
    async (span) => {
      try {
        await spawnAgentInner(params, facts, managed);
      } catch (err) {
        try {
          if (!(err instanceof ProcessStartedReceiptError)) clearSpawnKind(params.agentId);
          recordSpawn(params.kind, facts, startMs, err);
          span.set(...spawnAttrs(facts));
        } catch {
          // telemetry-exempt: never replace the spawn error with a telemetry one
        }
        throw err;
      }
      recordSpawn(params.kind, facts, startMs, undefined);
      span.set(...spawnAttrs(facts));
    },
    { classify: () => (facts.noPid ? { error: 'headless_no_pid' } : 'ok') },
  );
}

/**
 * A Dispatcher start with the model prepareDispatcherSessionStart gave it:
 * Behavior's (#3045), or the user's pick (#3191), which names its provider
 * too. A start on another CLI than its record or its caller had drops the
 * session it would resume, which that CLI can't read (#2593); the record
 * already dropped it.
 */
export function withDispatcherStartModel(
  params: SpawnAgentParams,
  applied: { model: string; orchestrator?: OrchestratorId; providerChanged?: boolean } | null,
): SpawnAgentParams {
  if (!applied) return params;
  const next = { ...params, model: applied.model };
  if (!applied.orchestrator) return next;
  const otherCli = applied.providerChanged === true || (params.orchestrator !== undefined && params.orchestrator !== applied.orchestrator);
  return { ...next, orchestrator: applied.orchestrator, ...(otherCli && { resume: false, sessionId: undefined }) };
}

/**
 * The Dispatcher starts only while it is on. Every way of starting one comes
 * through here, so a wake from a view, a phone, a tool or an update resume is
 * refused alike.
 */
function assertDispatcherCanStart({ kind, projectPath }: SpawnAgentParams): void {
  if (kind !== 'durable' || !isDispatcherPath(projectPath)) return;
  if (dispatcherEnablement().enabled) return;
  throw tagError(new Error('The Dispatcher is turned off.'), 'preflight_failed');
}

async function spawnAgentInner(inParams: SpawnAgentParams, facts: SpawnFacts, managed: ManagedLaunchLease | null): Promise<void> {
  let params = inParams;
  assertDispatcherCanStart(params);
  if (params.kind === 'durable' && isDispatcherPath(params.projectPath)) {
    // Either of the Dispatcher's agents starts with its memory as it is now (#3036).
    // Loaded here: dispatcher-service imports this module.
    try {
      const { prepareDispatcherSessionStart } = await import('./dispatcher/dispatcher-service');
      // Its Behavior's model (#3045), or the model and provider chosen for it (#3191), win over what the caller last saw.
      const behaviorModel = await prepareDispatcherSessionStart(params.projectPath, params.agentId);
      params = withDispatcherStartModel(params, behaviorModel);
    } catch (err) {
      // telemetry-exempt: logged; it starts with the instructions file it already has
      appLog('core:agent', 'warn', 'Could not refresh the Dispatcher\'s instructions before its start', {
        meta: { agentId: params.agentId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  // An agent still being created has no worktree yet, and a failed one never
  // will (#2226): refuse before anything touches its folder.
  // Read once here; the managed delivery step below uses the same read.
  let firstConfig: DurableAgentConfig | null = null;
  if (params.kind === 'durable') {
    let creation: DurableAgentConfig['creation'];
    try {
      firstConfig = await getDurableConfig(params.projectPath, params.agentId);
      creation = firstConfig?.creation;
    } catch {
      // telemetry-exempt: config not available; the spawn proceeds as before.
    }
    if (creation) {
      throw tagError(new Error(creation.state === 'creating'
        ? 'This agent is still being created. Start it once it is ready.'
        : `This agent could not be created: ${creation.reason ?? 'unknown reason'} Delete it and create it again.`), 'cwd_invalid');
    }
  }
  const provider = await tel.step('clubhouse.provider.resolve', () =>
    withErrorType('orchestrator_unknown', () => resolveOrchestrator(params.projectPath, params.orchestrator)),
  );
  facts.orchestrator = provider.id;
  if (!params.orchestrator) {
    // An agent with no CLI of its own runs on its project's "Agents run on" (#2975).
    appLog('core:agent', 'info', 'Agent has no CLI of its own, so it starts on the project default', {
      meta: { agentId: params.agentId, providerId: provider.id, projectDefault: (await readProjectOrchestrator(params.projectPath)) ?? null },
    });
  }

  // Copilot discovers repository hooks in every runtime, even with the Clubhouse hook server off.
  if (provider.id === 'copilot-cli') await readCopilotHooksConfig(params.cwd);

  // Read project-level command prefix for shell environment setup
  const commandPrefix = await resolveCommandPrefix(params.projectPath);

  // Pre-flight: verify the orchestrator CLI is available before spawning.
  // This catches missing binaries and auth issues early with clear errors,
  // rather than letting the PTY start and exit immediately.
  await tel.step('clubhouse.provider.check_availability', async () => {
    const availability = await provider.checkAvailability();
    if (!availability.available) {
      const msg = availability.error || `${provider.displayName} CLI is not available`;
      appLog('core:agent', 'error', `Pre-flight check failed for ${provider.id}`, {
        meta: { agentId: params.agentId, error: msg },
      });
      throw tagError(new Error(msg), 'preflight_failed');
    }
  });

  agentRegistry.register(params.agentId, {
    projectPath: params.projectPath,
    cwd: params.cwd,
    orchestrator: provider.id as OrchestratorId,
    runtime: 'pty',
  });

  try {
    // Clean up stale JSON in TOML config files (e.g. Codex .codex/config.toml)
    // This handles files created before TOML-aware guards were added.
    if (provider.conventions.settingsFormat === 'toml') {
      try {
        await cleanupStaleJsonInTomlConfigs(params.cwd, provider.conventions);
      } catch (err) {
        appLog('core:agent', 'warn', 'TOML config cleanup failed, continuing spawn', {
          meta: { agentId: params.agentId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    // Clubhouse-managed agents (#2896): write the agent's setup into its folder
    // before every start. An agent that used Clubhouse Mode or a
    // persona switches to managed first, keeping what it has, and this start is
    // its first managed one (D59). A failed switch starts it as it is.
    if (params.kind === 'durable' && !managed && firstConfig && !firstConfig.managed) {
      const { migrateAtSpawn } = await import('./managed-agents/auto-migrate');
      const migrated = await migrateAtSpawn(params.projectPath, firstConfig);
      if (migrated) firstConfig = migrated;
    }
    if (params.kind === 'durable' && !managed) {
      const config = firstConfig;
      if (config?.managed) {
        try {
          const { deliverForSpawn } = await import('./managed-agents');
          await tel.step('clubhouse.agent.materialize', () =>
            withErrorType('materialize_failed', () => deliverForSpawn(params.projectPath, config, provider)),
          );
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          appLog('core:agent', 'warn', 'Managed setup delivery failed, continuing spawn', {
            meta: { agentId: params.agentId, error: errorMessage },
          });
          broadcastToAllWindows(IPC.AGENT.AGENT_MATERIALIZATION_FAILED, params.agentId, errorMessage);
        }
      }
    }

    // A quick agent built from a template (#2893, D25): its instructions lead
    // the system prompt. A template that can't be read fails the start, since
    // the person chose it.
    let quickManaged: QuickManagedLaunch | null = null;
    if (params.kind === 'quick' && params.managedTemplate) {
      const template = params.managedTemplate;
      const { quickLaunchFor } = await import('./managed-agents');
      quickManaged = await tel.step('clubhouse.agent.materialize', () =>
        withErrorType('materialize_failed', () => quickLaunchFor(params.projectPath, params.cwd, params.agentId, template, provider)),
      );
      const instructions = quickManaged.instructions;
      params = { ...params, systemPrompt: [instructions, params.systemPrompt].filter(Boolean).join('\n\n') };
    }

    let allowedTools = params.allowedTools
      || (params.kind === 'quick' ? provider.getDefaultPermissions('quick') : undefined);

    // Resolve launch wrapper config (if any)
    const wrapperConfig = await readLaunchWrapper(params.projectPath);
    let resolvedMcpIds: string[] = [];
    if (wrapperConfig) {
      if (params.kind === 'durable') {
        const config = await getDurableConfig(params.projectPath, params.agentId);
        resolvedMcpIds = config?.mcpIds || await readDefaultMcps(params.projectPath);
      } else {
        resolvedMcpIds = await readDefaultMcps(params.projectPath);
      }
    }

    let resolvedMcpConfigs: Record<string, Record<string, string>> = {};
    if (wrapperConfig) {
      if (params.kind === 'durable') {
        const config = await getDurableConfig(params.projectPath, params.agentId);
        resolvedMcpConfigs = config?.mcpConfigs || await readMcpConfigs(params.projectPath);
      } else {
        resolvedMcpConfigs = await readMcpConfigs(params.projectPath);
      }
    }

    // The old free agent permission mode, frozen since #2761: it turns a legacy
    // on/off into a level, and is what a CLI that reads it with Free Agent Mode
    // off (Copilot) still gets, so those start exactly as before.
    const legacyMode = params.permissionMode ?? freeAgentSettings.getPermissionMode(params.projectPath);

    // For durable agents, fall back to stored config for flags that callers may
    // not pass (e.g. session resume after app update only carries a subset of
    // fields).  This ensures access, model and the agent file are
    // honoured even when the resume path doesn't explicitly provide them.
    let durableConfig: Awaited<ReturnType<typeof getDurableConfig>> | undefined;
    let configUnreadable = false;
    if (params.kind === 'durable') {
      try {
        durableConfig = await getDurableConfig(params.projectPath, params.agentId);
        if (durableConfig) {
          if (params.model === undefined && durableConfig.model) params = { ...params, model: durableConfig.model };
          if (isEffortValue(durableConfig.effort)) params = { ...params, effort: durableConfig.effort };
          if (params.agentFile === undefined && durableConfig.agentFile) params = { ...params, agentFile: durableConfig.agentFile };
          if (params.agentSource === undefined && durableConfig.agentSource) params = { ...params, agentSource: durableConfig.agentSource };
        }
      } catch (err) {
        // telemetry-exempt: fails safe to standard and is logged; the spawn goes on.
        // Unreadable config: we can't tell whether this is a helper (or a
        // disposed one), so start at standard rather than trust the caller.
        // A missing row (null) isn't an error and keeps the caller's values.
        configUnreadable = true;
        appLog('core:agent', 'warn', 'Could not read the agent\'s config; starting it at standard access', {
          meta: { agentId: params.agentId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    // Access (#2761): the level this start uses.
    let access: AccessLevel = configUnreadable ? 'ask' : spawnAccess(params, durableConfig, legacyMode);
    // An agent saved before #2761 that nobody has given a level yet starts exactly
    // as before: below Free Agent Mode with the old mode, which Copilot reads,
    // and at any level the CLI took before. Everything else starts at its level:
    // below Free Agent Mode with the mode at auto, and clamped to the levels the
    // CLI has (below, once the runtime is known).
    const legacyRecord = !configUnreadable && !isAccessLevel(params.access) && !!durableConfig && !isAccessLevel(durableConfig.access);
    // Unreadable config starts at standard with the mode pinned, as before #2761.
    let launch = configUnreadable ? launchAccessFor('standard') : legacyLaunchFor(access, legacyRecord ? legacyMode : 'auto');
    // A disposed helper keeps its row but has no worktree to run in (#2224).
    if (isDisposedAgent(durableConfig)) {
      throw tagError(new Error(`${durableConfig?.name ?? 'This agent'} was disposed and can't be started`), 'preflight_failed');
    }
    // A helper never starts above its orchestrator's ceiling, whoever wakes it.
    if (params.kind === 'durable' && durableConfig?.parentAgentId) {
      const capped = await capHelperLaunch(params.projectPath, params.agentId, { ...durableConfig, parentAgentId: durableConfig.parentAgentId }, provider.id, launch);
      if (capped.freeAgentMode !== launch.freeAgentMode || capped.permissionMode !== launch.permissionMode) {
        // Only ever lower: a level below the cap (Plan) stays.
        access = lowerAccess(access, accessFromLegacy(capped.freeAgentMode, capped.permissionMode));
        launch = { freeAgentMode: capped.freeAgentMode, permissionMode: capped.permissionMode };
      }
      // Never above its orchestrator's five-level level, nor what start_helper asked (#3000).
      access = lowerAccess(access, capped.ceilingAccess);
    }
    params = { ...params, access, freeAgentMode: launch.freeAgentMode, permissionMode: launch.permissionMode };
    const permissionMode = launch.permissionMode;
    // Every spawn retries a bridge that failed at app start; only a helper waits for it.
    await prepareMcpBridge(durableConfig);
    // The final launch access, the ceiling for this agent's helpers (#2228).
    // Every runtime below starts with exactly these values.
    agentRegistry.setLaunchCap(params.agentId, { freeAgentMode: launch.freeAgentMode, permissionMode, access });
    // A quick agent's default tools follow its level (#3007): at Plan or Ask first nothing that
    // edits or runs commands is pre-allowed, so the level picked is the level it gets. Copilot
    // runs a terminal quick agent one-shot (-p), where it can't ask: its defaults stay, as
    // they're the only way it gets anything done.
    const defaultQuickTools = params.kind === 'quick' && !params.allowedTools ? allowedTools : undefined;
    const filterQuickTools = (level: AccessLevel) => {
      if (defaultQuickTools && provider.id !== 'copilot-cli') allowedTools = quickToolsForAccess(defaultQuickTools, level);
    };
    filterQuickTools(access);
    // The orchestration tools are listed from this gate (#2228); set it before the MCP connects.
    if (params.kind === 'durable') await syncOrchestrationGate(params.projectPath, params.agentId);
    // Likewise the Dispatcher's tools (#2536), only for the Dispatcher.
    await syncDispatcherGate(params.projectPath, params.agentId);
    // Before the nonce, which the bridge needs, so no tool call can come first.
    // Its config was read above.
    if (params.kind !== 'durable') setMcpCallerQuick(params.agentId, params.projectPath);
    else if (configUnreadable) setMcpCallerUnreadable(params.agentId, params.projectPath);
    else setMcpCaller(params.agentId, params.projectPath, durableConfig);
    facts.model = params.model;
    if (params.kind === 'durable' && durableConfig?.contextWindow) {
      const { value, notice } = await contextWindowForLaunch(params.projectPath, provider.id, params.agentId, params.model, durableConfig.contextWindow);
      params = { ...params, contextWindow: value, contextWindowNotice: notice };
    }

    // The user woke it fresh although it has a session to resume.
    if (params.kind === 'durable' && !params.resume && durableConfig?.lastSessionId) {
      recordResumeOutcome(provider.id, params.agentId, 'fresh_user');
    }
    // A session that kept failing every turn (#3240) is never resumed, whichever wake path asked.
    if (params.kind === 'durable' && params.resume && params.sessionId && durableConfig?.quarantinedSessionIds?.includes(params.sessionId)) {
      appLog('core:agent', 'warn', 'Not resuming a quarantined session; starting fresh', { meta: { agentId: params.agentId, sessionId: params.sessionId } });
      // Said in the new session's chat, or by the terminal's start below.
      noteNextStartNotice(params.agentId, { level: 'warn', code: 'resume_blocked', message: RESUME_BLOCKED_NOTICE });
      params = { ...params, resume: false, sessionId: undefined };
    }
    // A saved id the CLI's own store doesn't have (Codex agents saved made-up
    // ids before #2113, #2132), or another CLI's session (#2593; Claude Code has
    // no store check, so it would be asked and quit): start fresh instead of
    // resuming nothing.
    if (params.kind === 'durable' && params.resume && params.sessionId) {
      const madeBy = durableConfig?.sessionHistory?.find((s) => s.sessionId === params.sessionId)?.orchestrator;
      const exists = madeBy && madeBy !== provider.id ? false
        : isSessionCapable(provider) && provider.hasSession ? await provider.hasSession(params.sessionId).catch((): undefined => undefined)
          : undefined;
      // A session a removed provider profile saved under its own config folder
      // (#2749): the CLI can't resume it from here, but it stays in history, and
      // resumes again if Clubhouse is started with that folder's variable set.
      const inRemovedProfile = exists !== true && !(madeBy && madeBy !== provider.id)
        && await inRemovedProfileStore(provider, params.sessionId);
      if (params.strictResume && (exists === false || inRemovedProfile || madeBy !== provider.id)) throw new AgentResumeError('resume_unverified');
      if (inRemovedProfile) {
        appLog('core:agent', 'warn', 'Saved session is in a removed provider profile\'s store; starting fresh and keeping it in history', {
          meta: { agentId: params.agentId, sessionId: params.sessionId },
        });
        recordResumeOutcome(provider.id, params.agentId, 'fresh_not_found');
        params = { ...params, resume: false, sessionId: undefined };
      } else if (exists === false) {
        appLog('core:agent', 'warn', 'Saved session is gone from the CLI store; starting fresh', {
          meta: { agentId: params.agentId, sessionId: params.sessionId },
        });
        await clearResume(params.projectPath, provider.id, params.agentId, params.sessionId, 'store_missing');
        recordResumeOutcome(provider.id, params.agentId, 'fresh_not_found');
        params = { ...params, resume: false, sessionId: undefined };
      }
    }

    const spawnMode = headlessSettings.getSpawnMode(params.projectPath);

    // Chat runtime (experimental): durable agents whose provider is set to
    // Chat and has a registered driver. Falls through to the terminal otherwise.
    let chatStartMs: number | undefined;
    let chatStart: ChatStartResult;
    const chatFacts: ChatStartFacts = { attempts: [] };
    const chatContext = { orchestrator: facts.orchestrator, resume: !!params.resume };
    takeChatStartFailure(params.agentId);
    // A kill that never produced an exit (the agent wasn't running) mustn't label this run's.
    takeKillRequest(params.agentId);
    // The last sleep's reason describes the previous run, not this one: drop it
    // before the run can end and record its own (#2104).
    if (params.kind === 'durable' && durableConfig?.lastSleep && !params.strictResume) {
      try {
        await updateDurableConfig(params.projectPath, params.agentId, { lastSleep: null });
      } catch (err) {
        // telemetry-exempt: a stale reason on the card is cosmetic; the wake goes on.
        appLog('core:agent', 'warn', 'Failed to clear the last sleep reason', {
          meta: { agentId: params.agentId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    // Again here and before each runtime start below: a spawn can pass the
    // entry check, then reach its runtime after shutdown began (#2053), or
    // after the Dispatcher was turned off while it prepared (#3110).
    assertLaunchesOpen();
    assertDispatcherCanStart(params);
    // The Dispatcher acts through the Clubhouse MCP, never by driving the app's windows (#3185).
    const desktopControlOff = isDispatcherPath(params.projectPath) ? provider.desktopControlOffArgs?.() ?? [] : [];
    const startChat = async (p: SpawnAgentParams): Promise<ChatStartResult> => {
      try {
        const result = await withErrorType('chat_start_failed', () => tryStartChatAgent({
          agentId: p.agentId,
          projectPath: p.projectPath,
          cwd: p.cwd,
          kind: p.kind,
          model: p.model,
          contextWindow: p.contextWindow,
          contextWindowNotice: p.contextWindowNotice,
          effort: p.effort,
          mission: p.mission,
          missionRouted: p.missionRouted,
          systemPrompt: p.systemPrompt,
          freeAgentMode: p.freeAgentMode,
          permissionMode,
          access: p.access,
          resume: p.resume,
          strictResume: p.strictResume,
          sessionId: p.sessionId,
          interactive: p.interactive,
          ...(desktopControlOff.length > 0 && { extraArgs: desktopControlOff }),
        }, provider, commandPrefix, durableConfig, () => { chatStartMs = Date.now(); }, chatFacts));
        recordChatStart(chatStartMs, result, chatFacts, chatContext);
        return result;
      } catch (err) {
        recordChatStart(chatStartMs, 'failed', chatFacts, chatContext);
        throw err;
      }
    };
    chatStart = managed ? 'terminal' : await startChat(params);

    // Chat couldn't resume because the session is gone: don't let anything
    // retry the same dead id (#2086). The chat runtime still works, so start a
    // fresh chat session before falling back to a fresh terminal. Without this,
    // waking a chat agent whose session expired (from the app or a phone)
    // silently lands it in the terminal.
    if (chatStart !== 'chat' && chatStart !== 'cancelled') {
      const chatFailure = takeChatStartFailure(params.agentId);
      if (params.strictResume && params.resume) throw new AgentResumeError('resume_failed');
      if (params.kind === 'durable' && params.resume && params.sessionId && isSessionNotFound(chatFailure)) {
        await clearResume(params.projectPath, provider.id, params.agentId, params.sessionId, 'chat_not_found');
        params = { ...params, resume: false, sessionId: undefined };
        assertLaunchesOpen();
        assertDispatcherCanStart(params);
        chatStart = await startChat(params);
        recordResumeOutcome(provider.id, params.agentId, 'fresh_not_found', chatStart === 'chat' ? 'chat' : 'pty');
      }
    }
    // Killed, or replaced by a newer start for this agent: that one owns the
    // agent now, so this spawn opens nothing (in particular no terminal).
    if (chatStart === 'cancelled') return;
    if (chatStart === 'chat') {
      facts.runtime = 'chat';
      announceAwake(params.agentId);
      return;
    }

    // Try headless path for quick agents when enabled
    const unattended = params.kind === 'quick' && !!params.headless && !params.interactive;
    if ((spawnMode === 'headless' || unattended) && params.kind === 'quick' && !params.interactive && isHeadlessCapable(provider)) {
      const headlessResult = await provider.buildHeadlessCommand({
        cwd: params.cwd,
        model: params.model,
        mission: params.mission,
        systemPrompt: params.systemPrompt,
        allowedTools,
        agentId: params.agentId,
        noSessionPersistence: true,
        freeAgentMode: params.freeAgentMode,
        // A headless run can't ask, so it runs on its own: below Full access at
        // Auto, where a check decides, never skipping every prompt (#2761).
        permissionMode: params.access === 'full_access' ? 'skip-all' : 'auto',
        access: params.access,
      });

      if (headlessResult) {
        agentRegistry.setRuntime(params.agentId, 'headless');
        facts.runtime = 'headless';
        // Apply launch wrapper transform if configured and validation passes.
        // Plugin-enabled lookup is treated as always-true: plugins live renderer-side,
        // main has no real-time view. Binary-on-PATH check still catches the common case.
        let { binary: headlessBin, args: headlessArgs } = headlessResult;
        // The Clubhouse MCP always runs, so a headless quick agent gets the
        // bridge as a terminal one does: in the folder's MCP config (snapshot
        // first, restored on exit), which Claude reads, and in the launch flags
        // for CLIs that take MCP servers only that way (Codex, Copilot).
        const mcpPort = await waitMcpBridgeReady().catch(() => 0);
        if (mcpPort > 0) {
          const mcpConfigPath = path.join(params.cwd, provider.conventions.mcpConfigFile || '.mcp.json');
          configPipeline.snapshotFile(params.agentId, mcpConfigPath);
          await tel.step('clubhouse.mcp.inject', () => injectClubhouseMcp(params.cwd, params.agentId, mcpPort, provider.conventions)).catch((err) => {
            appLog('core:mcp', 'warn', 'MCP bridge injection skipped', {
              meta: { agentId: params.agentId, error: err instanceof Error ? err.message : String(err) },
            });
          });
        }
        // A quick agent's template servers (D25) and the bridge, as the terminal path
        // passes them. Only CLIs with launch flags have template servers here
        // (quickLaunchFor empties them otherwise), and their headless commands take
        // options after the prompt.
        if (provider.buildMcpArgs) {
          const { buildClubhouseMcpDef } = await import('./clubhouse-mcp/injection');
          const servers = {
            ...quickManaged?.servers,
            // The bridge is last so a template server of the same name can't shadow it.
            ...(mcpPort > 0 ? { clubhouse: buildClubhouseMcpDef(mcpPort, params.agentId) } : {}),
          };
          if (Object.keys(servers).length > 0) {
            headlessArgs = [...headlessArgs, ...provider.buildMcpArgs(servers, (message) => {
              broadcastToAllWindows(IPC.AGENT.AGENT_MATERIALIZATION_FAILED, params.agentId, message);
            })];
          }
        }
        let wrapperApplied = false;
        if (wrapperConfig) {
          const v = validateWrapperConfig(wrapperConfig, provider.id, { isPluginEnabled: () => true });
          if (v.ok === false) {
            appLog('core:agent', 'warn', `Skipping wrapper: ${v.reason}`, { meta: { agentId: params.agentId } });
          } else {
            const wrapped = applyLaunchWrapper(wrapperConfig, provider.id, headlessBin, headlessArgs, resolvedMcpIds, resolvedMcpConfigs);
            headlessBin = wrapped.binary;
            headlessArgs = wrapped.args;
            wrapperApplied = true;
          }
        }
        facts.wrapperApplied = wrapperApplied;
        // Its own nonce and identity, as a terminal quick agent gets: headless
        // Claude reads the worktree's MCP config (the parent's, for a quick
        // agent), and the bridge there takes both from this env (#2222).
        const nonce = randomUUID();
        agentRegistry.setNonce(params.agentId, nonce);
        const spawnEnv: Record<string, string> = {
          ...headlessResult.env,
          ...(wrapperApplied ? wrapperConfig?.env : undefined),
          CLUBHOUSE_AGENT_ID: params.agentId,
          CLUBHOUSE_HOOK_NONCE: nonce,
          ...hookPortEnv(),
          ...(mcpPort > 0 ? { CLUBHOUSE_MCP_PORT: String(mcpPort) } : {}),
        };
        // No bridge here: never point the agent at a port from its base env (#2620).
        if (mcpPort <= 0) delete spawnEnv.CLUBHOUSE_MCP_PORT;
        noteSpawnKind(params.agentId, params.kind);
        assertLaunchesOpen();
        await tel.step('clubhouse.headless.spawn', () => headlessManager.spawnHeadless(
          params.agentId,
          params.cwd,
          headlessBin,
          headlessArgs,
          spawnEnv,
          headlessResult.outputKind || 'stream-json',
          (exitAgentId) => {
            configPipeline.restoreForAgent(exitAgentId);
            if (params.kind !== 'durable') bindingManager.unbindAgent(exitAgentId);
            untrackAgent(exitAgentId);
            takeKillRequest(exitAgentId);
          },
          commandPrefix,
          headlessResult.createEventNormalizer,
        ));
        facts.noPid = !headlessManager.hasPid(params.agentId);
        announceAwake(params.agentId);
        return;
      }
    }

    if (unattended) {
      throw new Error(`${provider.displayName} can’t run without a window, so this quick agent can’t start unattended.`);
    }

    // Fall back to PTY mode
    facts.runtime = 'pty';
    // A terminal agent starts at the nearest level its CLI has a start flag for (#2761).
    if (!legacyRecord && !configUnreadable && params.access) {
      const startable = startableAccess(params.access, provider.id, 'terminal');
      // A helper never starts above its ceiling (#3000): a CLI with no start mode at or under it
      // (Plan, on Codex or Copilot in a terminal) can't run it, rather than run it at Ask first.
      if (durableConfig?.parentAgentId && ACCESS_LEVELS.indexOf(startable) > ACCESS_LEVELS.indexOf(params.access)) {
        throw tagError(new Error(`${provider.displayName} can't start at ${accessLabel(params.access)} in a terminal, and this helper can't go higher. Start it in chat, or on a CLI with that level.`), 'preflight_failed');
      }
      if (startable !== params.access) {
        const lowered = legacyLaunchFor(startable, 'auto');
        appLog('core:agent', 'info', 'Started a terminal agent at the nearest level its CLI has', {
          meta: { agentId: params.agentId, provider: provider.id, saved: params.access, level: startable },
        });
        params = { ...params, access: startable, freeAgentMode: lowered.freeAgentMode, permissionMode: lowered.permissionMode };
        // The tools follow the level it really starts at.
        filterQuickTools(startable);
        agentRegistry.reportLaunchAccess(params.agentId, { ...lowered, access: startable });
      }
    }
    await spawnPtyAgent(params, provider, allowedTools, commandPrefix, wrapperConfig, resolvedMcpIds, resolvedMcpConfigs, facts, managed, quickManaged);
    if (!managed || ptyManager.isRunning(params.agentId)) announceAwake(params.agentId);
  } catch (err) {
    if (!(err instanceof ProcessStartedReceiptError)) untrackAgent(params.agentId);
    throw err;
  }
}

/**
 * A managed agent starting in the terminal: its MCP servers whose variables
 * aren't set in the environment the CLI gets (the shell's plus Clubhouse's)
 * won't start. Say which by name in the terminal's setup notice, and keep them
 * for Details (D95). Never fails the start.
 */
async function noteTerminalMcpProblems(projectPath: string, agentId: string, config: DurableAgentConfig, spawnEnv: Record<string, string>, commandPrefix?: string): Promise<void> {
  try {
    // A command prefix (such as `source .env`) runs before the CLI and can set them: nothing to say then.
    if (commandPrefix) { (await import('./managed-agents')).recordMcpStartProblems(agentId, []); return; }
    const { resolveProjectMcpServers } = await import('./agent-mcp-servers');
    const { missingEnvNotice, missingMcpEnv } = await import('../../shared/mcp-start-problems');
    const { getShellEnvironment } = await import('../util/shell');
    const problems = missingMcpEnv(await resolveProjectMcpServers(projectPath, config), { ...getShellEnvironment(), ...spawnEnv });
    (await import('./managed-agents')).recordMcpStartProblems(agentId, problems);
    for (const problem of problems) broadcastToAllWindows(IPC.AGENT.AGENT_MATERIALIZATION_FAILED, agentId, missingEnvNotice(problem));
  } catch (err) {
    // telemetry-exempt: a hint only; the CLI reports the server's own failure
    appLog('core:agent', 'warn', 'Could not check managed MCP server variables', { meta: { agentId, error: err instanceof Error ? err.message : String(err) } });
  }
}

async function spawnPtyAgent(
  params: SpawnAgentParams,
  provider: OrchestratorProvider,
  allowedTools: string[] | undefined,
  commandPrefix?: string,
  wrapperConfig?: LaunchWrapperConfig,
  mcpIds?: string[],
  mcpConfigs?: Record<string, Record<string, string>>,
  facts: SpawnFacts = {},
  managed: ManagedLaunchLease | null = null,
  quickManaged: QuickManagedLaunch | null = null,
): Promise<void> {
  const nonce = randomUUID();
  agentRegistry.setNonce(params.agentId, nonce);

  // Snapshot hooks config before writing so we can restore on exit
  const hookConfigPath = configPipeline.getHooksConfigPath(provider, params.cwd);
  if (hookConfigPath && !managed) {
    configPipeline.snapshotFile(params.agentId, hookConfigPath);
  }

  // Snapshot MCP config before injection so we can restore on exit.
  // The Clubhouse MCP always runs, so every agent gets the bridge.
  const mcpJsonPath = path.join(params.cwd, provider.conventions.mcpConfigFile || '.mcp.json');
  // Reused below to resolve the project's MCP servers with agent-scoped
  // wildcards applied — fetch it once.
  let durableConfig: Awaited<ReturnType<typeof getDurableConfig>> | undefined;
  if (params.kind === 'durable') {
    try {
      durableConfig = await getDurableConfig(params.projectPath, params.agentId);
    } catch { /* config not available */ }
  }
  // Snapshot MCP config for all formats — TOML injection is now supported
  // and the config-pipeline restore logic handles both JSON and TOML files.
  if (!managed) {
    configPipeline.snapshotFile(params.agentId, mcpJsonPath);
  }

  // Resolve the free-agent permission mode (auto vs skip-all) from settings,
  // but honour an explicit override (e.g. from session resume)
  const permissionMode = params.permissionMode ?? freeAgentSettings.getPermissionMode(params.projectPath);

  // Run hook server setup, MCP bridge setup, and command building in parallel.
  let mcpPort = 0;
  const [, , spawnCmd] = await tel.step('clubhouse.agent.prepare_pty', () => Promise.all([
    managed ? Promise.resolve() : waitHookServerReady().then((port) => tel.step('clubhouse.hooks.configure', async () => {
      // Inject Clubhouse hooks only when the provider supports them AND the
      // user has opted this orchestrator into the hook server (app-level).
      // Default: on for Claude Code, off for every other orchestrator.
      facts.hooksEnabled = false;
      // An unmanaged agent with Clubhouse features off (#2893) is a plain CLI: no Clubhouse hooks.
      if (!managed && durableConfig?.clubhouseFeatures !== false && isHookCapable(provider) && orchestratorSettings.isHookServerEnabled(provider.id)) {
        facts.hooksEnabled = true;
        const hookUrl = `http://127.0.0.1:${port}/hook`;
        await provider.writeHooksConfig(params.cwd, hookUrl);
      }
    })),
    managed ? Promise.resolve() : waitMcpBridgeReady().then((port) => tel.step('clubhouse.mcp.inject', async () => {
      mcpPort = port;
      await injectClubhouseMcp(params.cwd, params.agentId, port, provider.conventions);
    })).catch((err) => {
      // A helper without the bridge couldn't report to its parent, so it doesn't start (#2610).
      if (durableConfig?.parentAgentId) throw helperMcpError(err);
      appLog('core:mcp', 'warn', 'MCP bridge injection skipped', {
        meta: { agentId: params.agentId, error: err instanceof Error ? err.message : String(err) },
      });
    }),
    tel.step('clubhouse.provider.build_command', () => provider.buildSpawnCommand({
      cwd: params.cwd,
      model: params.model,
      contextWindow: params.contextWindow,
      effort: params.effort,
      mission: params.mission,
      systemPrompt: params.systemPrompt,
      allowedTools,
      agentId: params.agentId,
      freeAgentMode: params.freeAgentMode,
      permissionMode,
      access: params.access,
      resume: params.resume,
      sessionId: params.sessionId,
      agentFile: params.agentFile,
      agentSource: params.agentSource ? expandHome(params.agentSource) : undefined,
      // A quick agent someone follows (a phone start, an action below Auto) runs as a session it can ask in, not one-shot.
      interactive: params.kind === 'durable' || !!params.interactive,
      ...(isDispatcherPath(params.projectPath) && { noDesktopControl: true }),
    })),
  ]));

  // Inject MCP args for providers that need CLI-based MCP config (e.g. Copilot CLI)
  let { binary, args } = spawnCmd;
  const { env } = spawnCmd;
  if (managed) {
    if (params.systemPrompt || args.some((arg) => ['--continue', '--resume', '--system-prompt', '--append-system-prompt', '--system-prompt-file', '--append-system-prompt-file', '--plugin-dir', '--bare', '--settings', '--setting-sources'].includes(arg))) {
      throw new ManagedActivationError('activation_unsupported');
    }
    args = [...args, '--append-system-prompt-file', managed.instructionFile,
      ...(managed.pluginDir ? ['--plugin-dir', managed.pluginDir] : [])];
  }
  // Every agent gets the bridge (the Clubhouse MCP always runs) and its MCP
  // servers: the project's, a managed agent's setup (#2896), or a quick agent's
  // template servers in place of the project's (D25).
  const bridgeOn = mcpPort > 0;
  if (provider.buildMcpArgs) {
    const { buildClubhouseMcpDef } = await import('./clubhouse-mcp/injection');
    const { resolveProjectMcpServers } = await import('./agent-mcp-servers');

    // Codex and Copilot read MCP only from their own user-level config, so the
    // project MCP file materialised into the worktree never reaches them.
    // Launch flags are the only path — hand over the project's servers here
    // alongside the Clubhouse bridge.
    const projectServers = quickManaged
      ? quickManaged.servers
      : await resolveProjectMcpServers(params.projectPath, durableConfig ?? undefined, (message) => {
        broadcastToAllWindows(IPC.AGENT.AGENT_MATERIALIZATION_FAILED, params.agentId, message);
      });
    const servers = {
      ...projectServers,
      // The bridge is last so a project server of the same name can't shadow it.
      ...(bridgeOn ? { clubhouse: buildClubhouseMcpDef(mcpPort, params.agentId) } : {}),
    };
    if (Object.keys(servers).length > 0) {
      args = [...args, ...provider.buildMcpArgs(servers, (message) => {
        broadcastToAllWindows(IPC.AGENT.AGENT_MATERIALIZATION_FAILED, params.agentId, message);
      })];
    }
  }
  // trailingArgs (e.g. Codex's bare mission prompt) must come after any
  // dynamically-injected flags above, not before — see SpawnCommandResult.
  if (spawnCmd.trailingArgs && spawnCmd.trailingArgs.length > 0) {
    args = [...args, ...spawnCmd.trailingArgs];
  }

  // Apply launch wrapper transform if configured and validation passes.
  // Plugin-enabled lookup is treated as always-true: plugins live renderer-side,
  // main has no real-time view. Binary-on-PATH check still catches the common case.
  let wrapperApplied = false;
  if (wrapperConfig) {
    const v = validateWrapperConfig(wrapperConfig, provider.id, { isPluginEnabled: () => true });
    if (v.ok === false) {
      appLog('core:agent', 'warn', `Skipping wrapper: ${v.reason}`, { meta: { agentId: params.agentId } });
    } else {
      const wrapped = applyLaunchWrapper(wrapperConfig, provider.id, binary, args, mcpIds || [], mcpConfigs);
      binary = wrapped.binary;
      args = wrapped.args;
      wrapperApplied = true;
    }
  }
  facts.wrapperApplied = wrapperApplied;

  appLog('core:agent', 'info', `Spawning ${params.kind} agent`, {
    meta: {
      agentId: params.agentId,
      orchestrator: provider.id,
      binary,
      args: args.join(' '),
      cwd: params.cwd,
      model: params.model,
      hookConfigPath: hookConfigPath || 'none',
      allowedTools: allowedTools?.join(',') || 'none',
      commandPrefix: commandPrefix || 'none',
    },
  });

  // A terminal has no chat to carry the notice; the desktop shows it as other runtime notices.
  if (params.contextWindowNotice) broadcastToAllWindows(IPC.CHAT.RUNTIME_NOTICE, params.agentId, params.contextWindowNotice);
  // Notices a chat start would have written into its session, such as a blocked resume (#3240).
  for (const notice of takeNextStartNotices(params.agentId)) broadcastToAllWindows(IPC.CHAT.RUNTIME_NOTICE, params.agentId, notice);

  const spawnEnv: Record<string, string> = {
    ...env,
    ...(wrapperApplied ? wrapperConfig?.env : undefined),
    CLUBHOUSE_AGENT_ID: params.agentId,
    // The only place the nonce goes: hooks and the MCP bridge read it from
    // this env, never from the worktree's config files (#2222).
    CLUBHOUSE_HOOK_NONCE: nonce,
    ...hookPortEnv(),
    ...(mcpPort > 0 ? { CLUBHOUSE_MCP_PORT: String(mcpPort) } : {}),
  };
  // No bridge here: never point the agent at a port from its base env (#2620).
  if (mcpPort <= 0) delete spawnEnv.CLUBHOUSE_MCP_PORT;

  // A managed agent's MCP server whose variables aren't set won't start: say which, by name (D95).
  if (params.kind === 'durable' && durableConfig?.managed) await noteTerminalMcpProblems(params.projectPath, params.agentId, durableConfig, spawnEnv, commandPrefix);

  noteSpawnKind(params.agentId, params.kind);
  const spawnedAt = Date.now();
  let createdIdentity: string | undefined;
  let managedExitConfirmed = false;
  if (managed) {
    await managed.beforeStart(binary);
    // Freeze PATH/symlink resolution to the exact installed binary that supplied flag evidence.
    binary = managed.binary;
  }
  const spawnArgs: Parameters<typeof ptyManager.spawn> = [params.agentId, params.cwd, binary, args, spawnEnv, (exitAgentId, exitCode, buffer, killed) => {
    if (managed) {
      void managed.exited().catch(() => {
        // telemetry-exempt: failed receipt bookkeeping cannot change the observed runtime exit.
        appLog('core:agent', 'warn', 'Could not record managed process exit', { meta: { agentId: exitAgentId } });
      });
    } else configPipeline.restoreForAgent(exitAgentId);
    if (params.kind !== 'durable') bindingManager.unbindAgent(exitAgentId);
    untrackAgent(exitAgentId);
    // A terminal agent's run ended: a non-zero exit nobody asked for is an error (#2098).
    recordBreadcrumb(exitCode !== 0 && killed !== true ? 'error' : 'event', exitCode !== 0 && killed !== true ? 'pty.exit_error' : 'pty.exit', exitCode);

    const kill = takeKillRequest(exitAgentId);
    if (params.kind === 'durable') {
      // A kill nobody asked for through killAgent is Clubhouse's own (quitting): no reason to show.
      if (kill || !killed) void recordSleep(params.projectPath, exitAgentId, sleepInfoForExit(kill, exitCode));
      const capture = captureSessionOnExit(params, provider, exitAgentId, {
        exitCode, buffer, killed: killed === true, runMs: Date.now() - spawnedAt, assignedId: spawnCmd.sessionId,
      });
      if (capture) trackSessionCapture(exitAgentId, capture);
    }
  }, commandPrefix];
  if (managed) spawnArgs.push({ beforeCreate: () => { assertLaunchesOpen(); managed.assertCanCreate(); }, onCreated: (identity: string) => { createdIdentity = identity; }, onObservedExit: () => { managedExitConfirmed = true; } });
  try {
    assertLaunchesOpen();
    assertDispatcherCanStart(params);
    await tel.step('clubhouse.pty.spawn', () => withErrorType('pty_spawn_failed', () => ptyManager.spawn(...spawnArgs)));
  } catch (err) {
    // Refused before a process existed (the Dispatcher turned off, #3110): no exit will restore the files injected above.
    if (!managed && !createdIdentity && !isAgentRunning(params.agentId)) void configPipeline.restoreForAgent(params.agentId);
    if (managed && !createdIdentity) {
      try { await managed.notCreated(); } catch {
        // telemetry-exempt: preserve the known pre-creation error; unresolved durable intent stays fail-closed.
        appLog('core:agent', 'warn', 'Could not record managed pre-creation rejection', { meta: { agentId: params.agentId } });
      }
    }
    if (managed && createdIdentity) {
      await cleanupManagedReceiptFailure(managed, new ProcessStartedReceiptError(managed.attemptId, createdIdentity), {
        requestIfCurrent: (identity) => ptyManager.stopCreatedProcessIfCurrent(params.agentId, identity),
        waitForExit: async () => { await waitForAgentStopped(params.agentId); },
        exitConfirmed: () => managedExitConfirmed,
      });
    }
    throw err;
  }
  if (managed) {
    if (!createdIdentity) throw new ManagedActivationError('activation_start_failed');
    await recordManagedProcessStart(managed, createdIdentity, {
      requestIfCurrent: (identity) => ptyManager.stopCreatedProcessIfCurrent(params.agentId, identity),
      waitForExit: async () => { await waitForAgentStopped(params.agentId); },
      exitConfirmed: () => managedExitConfirmed,
    });
  }
}

/** A resume that exits non-zero this soon on its own, without printing a session id, never got going. */
const RESUME_EARLY_EXIT_MS = 10_000;
/** How much of the exit buffer to search for the CLI's "no such session" error. */
const RESUME_ERROR_TAIL = 2_000;

/**
 * Record the CLI session a durable agent's terminal run ended on, so the next
 * wake can resume it. Only an id the CLI actually reported is saved (#2086):
 * the one it printed, the one its own store recorded for this run (Codex
 * prints none, #2132), or the one it was resumed with when it exited cleanly.
 * A resume that failed (the CLI said the session is gone, or it quit right
 * away on its own) clears the resume id instead, so the next wake starts fresh.
 * Resolves once the config write, if any, is done.
 */
function captureSessionOnExit(
  params: SpawnAgentParams,
  provider: OrchestratorProvider,
  agentId: string,
  exit: { exitCode: number; buffer?: string; killed: boolean; runMs: number; assignedId?: string },
): Promise<void> {
  // Async: the id may come from the CLI's own session files (it never rejects; failures are logged).
  return captureSession(params, provider, agentId, exit);
}

async function captureSession(
  params: SpawnAgentParams,
  provider: OrchestratorProvider,
  agentId: string,
  { exitCode, buffer, killed, runMs, assignedId }: { exitCode: number; buffer?: string; killed: boolean; runMs: number; assignedId?: string },
): Promise<void> {
  const resumedId = params.resume ? params.sessionId : undefined;
  // Only a resume that quit on its own with an error can have failed to resume.
  const failedResume = !!resumedId && exitCode !== 0 && !killed;
  // Telemetry (#2305): the run's capture outcome, and its resume outcome if it resumed.
  let resumeResult: SessionResumeResult = 'resumed';
  let rejected: SessionCaptureResult | undefined;
  let source: SessionCaptureSource = 'none';
  const record = (result: SessionCaptureResult) =>
    recordSessionCapture({ orchestrator: provider.id, agentId, runtime: 'pty', result, source, exitCode });
  try {
    // The tail only: a long session's own conversation may mention such errors.
    if (failedResume && isSessionNotFound(buffer?.slice(-RESUME_ERROR_TAIL))) {
      appLog('core:agent', 'warn', 'Resume failed: the CLI has no such session', {
        meta: { agentId, sessionId: resumedId, exitCode },
      });
      resumeResult = 'failed_not_found';
      record('resume_failed_no_session');
      return await clearResume(params.projectPath, provider.id, agentId, resumedId, 'exit_not_found');
    }
    // Never save an id the CLI's own store doesn't have (#2156): a scraped UUID
    // can come from the conversation text, and a clean exit doesn't prove the
    // resumed id existed. undefined (can't tell) keeps the id.
    // `assigned`: the run's own id, which the CLI may simply not have created yet; not a bad id.
    const exists = async (id: string | null, assigned = false): Promise<string | null> => {
      if (!id || !isSessionCapable(provider) || !provider.hasSession) return id;
      const has = await provider.hasSession(id).catch((): undefined => undefined);
      if (has === false) {
        appLog('core:agent', 'warn', 'Ignoring a session id the CLI store does not have', { meta: { agentId, sessionId: id } });
        if (!assigned) rejected = 'ignored_not_in_store';
        return null;
      }
      return id;
    };
    // A scraped UUID must also be this agent's session, where the CLI can say
    // so: the conversation can mention a real session from another cwd.
    const scraped = async (id: string | null): Promise<string | null> => {
      if (!id || !isSessionCapable(provider) || !provider.hasSessionForCwd) return exists(id);
      const ours = await provider.hasSessionForCwd(id, params.cwd).catch((): undefined => undefined);
      if (ours === false) {
        appLog('core:agent', 'warn', 'Ignoring a scraped session id that is not this agent\'s', { meta: { agentId, sessionId: id } });
        rejected = 'ignored_foreign';
        return null;
      }
      return id;
    };
    // The id Clubhouse gave a fresh session (Copilot's --session-id) is the
    // run's own; it's checked too, as the CLI may have quit before creating it.
    let sessionId: string | null = assignedId ? await exists(assignedId, true) : null;
    if (sessionId) source = 'assigned';
    if (!sessionId && buffer && isSessionCapable(provider)) {
      sessionId = await scraped(provider.extractSessionId(buffer));
      if (sessionId) source = 'output_scrape';
    }
    // A resume that failed wrote no session of its own, so there's nothing to look up.
    if (!sessionId && !failedResume && isSessionCapable(provider) && provider.findRunSession) {
      const endedAt = Date.now();
      sessionId = await provider.findRunSession({ cwd: params.cwd, startedAt: endedAt - runMs, endedAt, resumedId });
      if (sessionId) source = 'run_store';
    }
    if (!sessionId && resumedId && exitCode === 0) {
      sessionId = await exists(resumedId);
      if (sessionId) source = 'resumed_id';
    }
    if (!sessionId) {
      if (failedResume && runMs < RESUME_EARLY_EXIT_MS) {
        appLog('core:agent', 'warn', 'Resume failed: the CLI exited right away', {
          meta: { agentId, sessionId: resumedId, exitCode, runMs },
        });
        resumeResult = 'failed_early_exit';
        record('resume_failed_early_exit');
        return await clearResume(params.projectPath, provider.id, agentId, resumedId, 'exit_early');
      }
      appLog('core:agent', 'info', 'No session ID on exit; keeping the previous one', {
        meta: { agentId, exitCode, resumedSessionId: resumedId ?? null },
      });
      // A rejected id is still the previous one kept, but it's the signal of a made-up id (#2086).
      record(rejected ?? 'kept_previous');
      return undefined;
    }
    const capturedId = sessionId;
    const now = new Date().toISOString();
    return await addSessionEntry(params.projectPath, agentId, {
      sessionId: capturedId,
      startedAt: now,
      lastActiveAt: now,
      orchestrator: provider.id,
    }).then(() => {
      appLog('core:agent', 'info', 'Captured session ID on exit', {
        meta: { agentId, sessionId: capturedId, exitCode },
      });
      record('captured');
    }).catch((entryErr) => {
      appLog('core:agent', 'warn', 'Failed to persist session entry', {
        meta: { agentId, sessionId: capturedId, error: entryErr instanceof Error ? entryErr.message : String(entryErr) },
      });
      noteSessionCaptureFailure(agentId);
      record('persist_failed');
    });
  } catch (err) {
    // telemetry-exempt: best-effort bookkeeping on exit; logged and recorded as capture_failed.
    appLog('core:agent', 'warn', 'Failed to capture session ID', {
      meta: { agentId, error: err instanceof Error ? err.message : String(err) },
    });
    noteSessionCaptureFailure(agentId);
    record('capture_failed');
    return undefined;
  } finally {
    if (resumedId) recordResumeOutcome(provider.id, agentId, resumeResult, 'pty');
  }
}

/**
 * Clear a dead resume id (#2113). `reason` is where it was found dead; only a
 * resume that quit right away is `exited_early` to the user.
 */
/**
 * Whether `sessionId` may be in a removed provider profile's store (#2749): the
 * CLAUDE_CONFIG_DIR, CODEX_HOME or COPILOT_HOME a saved profile gave this
 * provider, read-only. "Can't tell" counts as yes, so nothing is erased on a guess.
 */
async function inRemovedProfileStore(provider: OrchestratorProvider, sessionId: string): Promise<boolean> {
  if (!isSessionCapable(provider) || !provider.hasSessionInStore) return false;
  for (const dir of await removedProfileStateDirs(provider.id)) {
    if (await provider.hasSessionInStore(sessionId, dir).catch((): undefined => undefined) !== false) return true;
  }
  return false;
}

async function clearResume(projectPath: string, orchestrator: string, agentId: string, sessionId: string, reason: SessionStaleReason): Promise<void> {
  const userReason: StaleResumeReason = reason === 'exit_early' ? 'exited_early' : 'not_found';
  try {
    if (await clearStaleResume(projectPath, agentId, sessionId, userReason)) recordStaleSessionCleared(orchestrator, agentId, reason);
  } catch (err) {
    // telemetry-exempt: best-effort bookkeeping on exit; logged, and the next wake still works.
    appLog('core:agent', 'warn', 'Failed to clear stale resume id', {
      meta: { agentId, sessionId, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** Past gracefulKill's SIGKILL step (9s), so a timeout means the exit was lost. */
const KILL_WAIT_TIMEOUT_MS = 12_000;

export interface KillAgentOptions {
  /**
   * Resolve only once the PTY has exited and its session id is persisted.
   * For restarts that resume (runtime switch): without it the respawn reads
   * a stale lastSessionId, and replacing the live PTY drops its exit capture.
   */
  waitForExit?: boolean;
  /** Surface stop failures to callers that must not acknowledge or delete yet. */
  throwOnFailure?: boolean;
  /** Main-process override for a known plain shell, which uses exit, not /exit. */
  exitCommand?: string;
  /** For an agent_tool kill: the name of the agent that asked, shown as the sleep reason. */
  by?: string;
}

export async function killAgent(
  agentId: string,
  projectPath: string,
  orchestrator?: OrchestratorId,
  trigger: 'user' | 'agent_tool' = 'user',
  opts: KillAgentOptions = {},
): Promise<void> {
  appLog('core:agent', 'info', 'Killing agent', { meta: { agentId, trigger, waitForExit: opts.waitForExit === true } });
  agentKillRequested(agentId, trigger);
  noteKillRequest(agentId, { trigger, ...(opts.by ? { by: opts.by } : {}) });
  // Headless finalization knows whether the process had already exited when
  // stop was requested. Do not turn a completed run with held pipes into a cancellation.
  if (agentRegistry.get(agentId)?.runtime !== 'headless' && !headlessManager.isHeadless(agentId)) noteQuickAgentStop(agentId);
  try {
    // A chat start in progress is cancelled (and its runtime stopped) here.
    if (await cancelChatStart(agentId, { throwOnFailure: opts.throwOnFailure })) return;
    const tracked = agentRegistry.get(agentId);

    if (tracked?.runtime === 'chat' || isChatAgent(agentId)) {
      const runtime = getAgentRuntime(agentId);
      if (opts.throwOnFailure) await runtime?.stop({ throwOnFailure: true });
      else await runtime?.stop();
      return;
    }
    if (tracked?.runtime === 'headless' || (!tracked && headlessManager.isHeadless(agentId))) {
      const exited = opts.waitForExit && headlessManager.isHeadless(agentId) ? waitForAgentExit(agentId) : undefined;
      if (!exited) untrackAgent(agentId);
      headlessManager.kill(agentId);
      if (exited) {
        const didExit = await exited;
        if (didExit) untrackAgent(agentId);
        else if (opts.throwOnFailure) throw new Error('Timed out waiting for agent exit');
      }
      return;
    }
    const exitCmd = opts.exitCommand ?? (await resolveOrchestrator(projectPath, tracked?.orchestrator || orchestrator)).getExitCommand();
    const exited = opts.waitForExit && ptyManager.isRunning(agentId) ? waitForAgentExit(agentId) : undefined;
    ptyManager.gracefulKill(agentId, exitCmd);
    if (exited) {
      const didExit = await settleKill(agentId, exited);
      if (!didExit && opts.throwOnFailure) throw new Error('Timed out waiting for agent exit');
    }
  } catch (err) {
    appLog('core:agent', 'warn', 'killAgent failed (process may already be dead)', {
      meta: { agentId, error: err instanceof Error ? err.message : String(err) },
    });
    if (opts.throwOnFailure) throw err;
  }
}

function waitForAgentExit(agentId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve(false); }, KILL_WAIT_TIMEOUT_MS);
    const off = onAgentExit((id) => {
      if (id !== agentId) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
}

/** Await the PTY exit, then the session id it captured. */
async function settleKill(agentId: string, exited: Promise<boolean>): Promise<boolean> {
  const startedAt = Date.now();
  const didExit = await exited;
  // The exit callback runs in the same tick as the exit broadcast (before it
  // on a normal exit, after it on SIGKILL), so the capture is registered by now.
  // A restart that resumes must wait for it, or it reads the previous lastSessionId.
  const capture = sessionCaptureFor(agentId);
  if (capture) await capture;
  appLog('core:agent', didExit ? 'info' : 'warn', didExit ? 'Agent exited after kill' : 'Timed out waiting for agent exit after kill', {
    meta: { agentId, waitedMs: Date.now() - startedAt, sessionCaptured: capture !== undefined },
  });
  return didExit;
}

export async function checkAvailability(
  projectPath?: string,
  orchestrator?: OrchestratorId
): Promise<{ available: boolean; error?: string }> {
  const id = orchestrator || (projectPath ? await readProjectOrchestrator(projectPath) : undefined) || DEFAULT_ORCHESTRATOR;
  const provider = getProvider(id);
  if (!provider) {
    return { available: false, error: `Unknown orchestrator: ${id}` };
  }
  return provider.checkAvailability();
}

/** Shared by actual launch and an explicit handshake check. */
export async function resolveCommandPrefix(projectPath: string): Promise<string | undefined> {
  return (await readProjectAgentDefaults(projectPath))?.commandPrefix || undefined;
}

/**
 * List available sessions for a durable agent.
 * Merges provider-discovered sessions with Clubhouse-tracked history.
 */
export async function listSessions(
  projectPath: string,
  agentId: string,
  orchestratorId?: OrchestratorId,
): Promise<Array<{ sessionId: string; startedAt: string; lastActiveAt: string; friendlyName?: string; blocked?: boolean }>> {
  const { getDurableConfig, getSessionHistory } = await import('./agent-config');
  const config = await getDurableConfig(projectPath, agentId);
  if (!config) return [];

  const provider = await resolveOrchestrator(projectPath, orchestratorId || config.orchestrator);
  const cwd = config.worktreePath || projectPath;

  // Get Clubhouse-tracked session history (includes friendly names)
  const clubhouseHistory = await getSessionHistory(projectPath, agentId);
  const nameMap = new Map(
    clubhouseHistory
      .filter((s: { friendlyName?: string }) => s.friendlyName)
      .map((s: { sessionId: string; friendlyName?: string }) => [s.sessionId, s.friendlyName!])
  );

  // Try to get provider-discovered sessions
  let providerSessions: Array<{ sessionId: string; startedAt: string; lastActiveAt: string }> = [];
  if (isSessionCapable(provider)) {
    try {
      providerSessions = await provider.listSessions(cwd);
    } catch (err) {
      appLog('core:agent', 'warn', 'Failed to list provider sessions', {
        meta: { agentId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  // Merge: provider sessions take priority for timestamps, Clubhouse adds names
  const merged = new Map<string, { sessionId: string; startedAt: string; lastActiveAt: string; friendlyName?: string }>();

  // Add provider sessions first
  for (const s of providerSessions) {
    merged.set(s.sessionId, { ...s, friendlyName: nameMap.get(s.sessionId) });
  }

  // Add Clubhouse-only sessions (not found by provider), except ones the
  // CLI's store says don't exist: those were saved by earlier builds that
  // recorded made-up or wrong ids (#2086, #2156). They're pruned from history.
  const missing: string[] = [];
  for (const s of clubhouseHistory) {
    if (merged.has(s.sessionId)) continue;
    // Another CLI's session: not this one's to offer, and not missing either (#2593).
    if (s.orchestrator && s.orchestrator !== provider.id) continue;
    if (isSessionCapable(provider) && provider.hasSession) {
      const has = await provider.hasSession(s.sessionId).catch((): undefined => undefined);
      if (has === false) {
        // Saved under a removed provider profile's own store (#2749): not offered, since it can't
        // resume from here, but never pruned.
        if (!(await inRemovedProfileStore(provider, s.sessionId))) missing.push(s.sessionId);
        continue;
      }
    }
    merged.set(s.sessionId, s);
  }
  if (missing.length) {
    const { removeSessionEntries } = await import('./agent-config');
    await removeSessionEntries(projectPath, agentId, missing).catch((err: unknown) => {
      appLog('core:agent', 'warn', 'Failed to prune missing sessions from history', {
        meta: { agentId, error: err instanceof Error ? err.message : String(err) },
      });
    });
  }

  // Sort by most recently active. A quarantined session (#3240) is listed, marked: choosing it starts fresh.
  const quarantined = new Set(config.quarantinedSessionIds ?? []);
  const result = Array.from(merged.values(), (s) => (quarantined.has(s.sessionId) ? { ...s, blocked: true } : s));
  result.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
  return result;
}

export function getAvailableOrchestrators() {
  return getAllProviders().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    shortName: p.shortName,
    badge: p.badge,
    capabilities: p.getCapabilities(),
    // MCP servers can be handed over at launch, not only through the folder's MCP file.
    mcpLaunchFlags: !!p.buildMcpArgs,
    conventions: {
      configDir: p.conventions.configDir,
      localInstructionsFile: p.conventions.localInstructionsFile,
      legacyInstructionsFile: p.conventions.legacyInstructionsFile,
      mcpConfigFile: p.conventions.mcpConfigFile,
      skillsDir: p.conventions.skillsDir,
      ...(p.conventions.skillsRoot && { skillsRoot: p.conventions.skillsRoot }),
      agentTemplatesDir: p.conventions.agentTemplatesDir,
      localSettingsFile: p.conventions.localSettingsFile,
      permissionRules: p.conventions.permissionRules,
    },
  }));
}
