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
import * as profileSettings from './profile-settings';
import { readProjectAgentDefaults, readLaunchWrapper, readDefaultMcps, readMcpConfigs } from './agent-settings-service';
import { applyLaunchWrapper, validateWrapperConfig } from '../orchestrators/shared';
import type { DurableAgentConfig, LaunchWrapperConfig, FreeAgentPermissionMode } from '../../shared/types';
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
  type AgentLaunchAccess,
  type HelperLaunch,
} from '../../shared/orchestration-policy';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { IPC } from '../../shared/ipc-channels';
import * as os from 'os';
import { getAgentRuntime, isChatAgent } from './agent-runtime';
import { cancelChatStart, tryStartChatAgent, type ChatRuntimeNotice, type ChatStartFacts, type ChatStartResult } from './agent-runtime/chat-spawn';
import { clearStaleResume, isSessionNotFound, takeChatStartFailure, type StaleResumeReason } from './agent-runtime/stale-session';
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
  /** CLI agent name to load (e.g. --agent k8s-assistant) */
  agentFile?: string;
  /** Source directory for agent file (e.g. --source ~/.copilot/agents/) */
  agentSource?: string;
  /**
   * Clubhouse-managed quick agents (#2893, D25): build a quick agent from this
   * template. Its instructions go in the system prompt and its MCP servers in
   * the launch flags; nothing is written into the folder it runs in.
   */
  managedTemplate?: { id: string; agentName: string };
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
): Promise<AgentLaunchAccess> {
  let cap: Pick<HelperLaunch, 'freeAgentMode' | 'permissionMode' | 'level'>;
  try {
    const parent = await findParent(projectPath, helper);
    if (!parent) throw new Error('Orchestrator not found');
    const resolved = await resolveHelperLaunchSettings(parent.projectPath, helper.parentAgentId, { helperProvider: providerId });
    cap = rankHelperLaunch(resolved, helper.requestedAccess, providerId);
  } catch (err) {
    // telemetry-exempt: fails safe to standard and is logged; the spawn goes on.
    appLog('core:orchestration', 'warn', 'Could not resolve a helper\'s ceiling; starting it at standard', {
      meta: { agentId, orchestratorId: helper.parentAgentId, error: err instanceof Error ? err.message : String(err) },
    });
    cap = { ...launchAccessFor('standard'), level: 'standard' };
  }
  const askedLevel = providerAccessLevel(providerId, asked);
  if (!isLowerAccess(cap.level, askedLevel)) return asked;
  appLog('core:orchestration', 'info', 'Lowered a helper\'s launch access to its orchestrator\'s ceiling', {
    meta: { agentId, orchestratorId: helper.parentAgentId, asked: askedLevel, level: cap.level },
  });
  return { freeAgentMode: cap.freeAgentMode, permissionMode: cap.permissionMode };
}

export async function spawnAgent(params: SpawnAgentParams): Promise<void> {
  // Quit and update close this before stopping runtimes (#2053).
  assertLaunchesOpen();
  const spawn = withManagedActivationLaunch(params, () => isAgentRunning(params.agentId), (managed) => {
    assertProviderSelection(params.agentId, params.orchestrator);
    return spawnAgentTracked(params, managed);
  });
  inflightSpawns.add(spawn);
  try {
    await spawn;
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

  // Copilot discovers repository hooks in every runtime, even with the Clubhouse hook server off.
  if (provider.id === 'copilot-cli') await readCopilotHooksConfig(params.cwd);

  // Resolve profile env early so it can be passed to checkAvailability.
  // This ensures auth checks (e.g. CLAUDE_CONFIG_DIR) use the correct
  // config directory when a profile is active.
  const profileEnv = await resolveProfileEnv(params.projectPath, provider.id);
  facts.profileActive = profileEnv !== undefined;

  // Read project-level command prefix for shell environment setup
  const commandPrefix = await resolveCommandPrefix(params.projectPath);

  // Pre-flight: verify the orchestrator CLI is available before spawning.
  // This catches missing binaries and auth issues early with clear errors,
  // rather than letting the PTY start and exit immediately.
  await tel.step('clubhouse.provider.check_availability', async () => {
    const availability = await provider.checkAvailability(profileEnv);
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

    const allowedTools = params.allowedTools
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

    // Resolve the free-agent permission mode (auto vs skip-all) from settings,
    // but honour an explicit override (e.g. from session resume)
    let permissionMode = params.permissionMode ?? freeAgentSettings.getPermissionMode(params.projectPath);

    // For durable agents, fall back to stored config for flags that callers may
    // not pass (e.g. session resume after app update only carries a subset of
    // fields).  This ensures freeAgentMode, model and the agent file are
    // honoured even when the resume path doesn't explicitly provide them.
    let durableConfig: Awaited<ReturnType<typeof getDurableConfig>> | undefined;
    let configUnreadable = false;
    if (params.kind === 'durable') {
      try {
        durableConfig = await getDurableConfig(params.projectPath, params.agentId);
        if (durableConfig) {
          if (params.freeAgentMode === undefined) params = { ...params, freeAgentMode: durableConfig.freeAgentMode };
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
        const standard = launchAccessFor('standard');
        params = { ...params, freeAgentMode: standard.freeAgentMode, permissionMode: standard.permissionMode };
        permissionMode = standard.permissionMode;
      }
    }
    // A disposed helper keeps its row but has no worktree to run in (#2224).
    if (isDisposedAgent(durableConfig)) {
      throw tagError(new Error(`${durableConfig?.name ?? 'This agent'} was disposed and can't be started`), 'preflight_failed');
    }
    // A helper never starts above its orchestrator's ceiling, whoever wakes it.
    if (params.kind === 'durable' && durableConfig?.parentAgentId) {
      const capped = await capHelperLaunch(params.projectPath, params.agentId, { ...durableConfig, parentAgentId: durableConfig.parentAgentId }, provider.id, {
        freeAgentMode: params.freeAgentMode === true,
        permissionMode,
      });
      params = { ...params, freeAgentMode: capped.freeAgentMode, permissionMode: capped.permissionMode };
      permissionMode = capped.permissionMode;
    }
    if (params.kind === 'durable') await prepareMcpBridge(durableConfig);
    // The final launch access, the ceiling for this agent's helpers (#2228).
    // Every runtime below starts with exactly these values.
    agentRegistry.setLaunchCap(params.agentId, { freeAgentMode: params.freeAgentMode === true, permissionMode });
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
    // A saved id the CLI's own store doesn't have (Codex agents saved made-up
    // ids before #2113, #2132), or another CLI's session (#2593; Claude Code has
    // no store check, so it would be asked and quit): start fresh instead of
    // resuming nothing.
    if (params.kind === 'durable' && params.resume && params.sessionId) {
      const madeBy = durableConfig?.sessionHistory?.find((s) => s.sessionId === params.sessionId)?.orchestrator;
      const exists = madeBy && madeBy !== provider.id ? false
        : isSessionCapable(provider) && provider.hasSession ? await provider.hasSession(params.sessionId, profileEnv).catch((): undefined => undefined)
          : undefined;
      if (params.strictResume && (exists === false || madeBy !== provider.id)) throw new AgentResumeError('resume_unverified');
      if (exists === false) {
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
    // entry check, then reach its runtime after shutdown began (#2053).
    assertLaunchesOpen();
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
          resume: p.resume,
          strictResume: p.strictResume,
          sessionId: p.sessionId,
          interactive: p.interactive,
        }, provider, profileEnv, commandPrefix, durableConfig, () => { chatStartMs = Date.now(); }, chatFacts));
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
        chatStart = await startChat(params);
        recordResumeOutcome(provider.id, params.agentId, 'fresh_not_found', chatStart === 'chat' ? 'chat' : 'pty');
      }
    }
    // Killed, or replaced by a newer start for this agent: that one owns the
    // agent now, so this spawn opens nothing (in particular no terminal).
    if (chatStart === 'cancelled') return;
    if (chatStart === 'chat') {
      facts.runtime = 'chat';
      broadcastToAllWindows(IPC.AGENT.AGENT_AWOKE, params.agentId);
      return;
    }

    // Try headless path for quick agents when enabled
    if (spawnMode === 'headless' && params.kind === 'quick' && !params.interactive && isHeadlessCapable(provider)) {
      const headlessResult = await provider.buildHeadlessCommand({
        cwd: params.cwd,
        model: params.model,
        mission: params.mission,
        systemPrompt: params.systemPrompt,
        allowedTools,
        agentId: params.agentId,
        noSessionPersistence: true,
        freeAgentMode: params.freeAgentMode,
        permissionMode,
      });

      if (headlessResult) {
        agentRegistry.setRuntime(params.agentId, 'headless');
        facts.runtime = 'headless';
        // Apply launch wrapper transform if configured and validation passes.
        // Plugin-enabled lookup is treated as always-true: plugins live renderer-side,
        // main has no real-time view. Binary-on-PATH check still catches the common case.
        let { binary: headlessBin, args: headlessArgs } = headlessResult;
        // A quick agent's template servers (D25), as the terminal path passes them. Only
        // CLIs with launch flags have any here (quickLaunchFor empties them otherwise),
        // and their headless commands take options after the prompt.
        if (quickManaged && provider.buildMcpArgs && Object.keys(quickManaged.servers).length > 0) {
          headlessArgs = [...headlessArgs, ...provider.buildMcpArgs(quickManaged.servers)];
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
        const mcpPort = await waitMcpBridgeReady().catch(() => 0);
        const spawnEnv: Record<string, string> = {
          ...headlessResult.env,
          ...profileEnv,
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
        broadcastToAllWindows(IPC.AGENT.AGENT_AWOKE, params.agentId);
        return;
      }
    }

    // Fall back to PTY mode
    facts.runtime = 'pty';
    await spawnPtyAgent(params, provider, allowedTools, profileEnv, commandPrefix, wrapperConfig, resolvedMcpIds, resolvedMcpConfigs, facts, managed, quickManaged);
    if (!managed || ptyManager.isRunning(params.agentId)) broadcastToAllWindows(IPC.AGENT.AGENT_AWOKE, params.agentId);
  } catch (err) {
    if (!(err instanceof ProcessStartedReceiptError)) untrackAgent(params.agentId);
    throw err;
  }
}

async function spawnPtyAgent(
  params: SpawnAgentParams,
  provider: OrchestratorProvider,
  allowedTools: string[] | undefined,
  profileEnv: Record<string, string> | undefined,
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
      resume: params.resume,
      sessionId: params.sessionId,
      agentFile: params.agentFile,
      agentSource: params.agentSource ? expandHome(params.agentSource) : undefined,
      interactive: params.kind === 'durable',
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
    if (Object.keys(servers).length > 0) args = [...args, ...provider.buildMcpArgs(servers)];
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

  const spawnEnv: Record<string, string> = {
    ...env,
    ...profileEnv,
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

  if (profileEnv) {
    appLog('core:agent', 'info', 'Profile env injected', {
      meta: { agentId: params.agentId, profileKeys: Object.keys(profileEnv).join(',') },
    });
  }

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
        exitCode, buffer, killed: killed === true, runMs: Date.now() - spawnedAt, profileEnv, assignedId: spawnCmd.sessionId,
      });
      if (capture) trackSessionCapture(exitAgentId, capture);
    }
  }, commandPrefix];
  if (managed) spawnArgs.push({ beforeCreate: () => { assertLaunchesOpen(); managed.assertCanCreate(); }, onCreated: (identity: string) => { createdIdentity = identity; }, onObservedExit: () => { managedExitConfirmed = true; } });
  try {
    assertLaunchesOpen();
    await tel.step('clubhouse.pty.spawn', () => withErrorType('pty_spawn_failed', () => ptyManager.spawn(...spawnArgs)));
  } catch (err) {
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
  exit: { exitCode: number; buffer?: string; killed: boolean; runMs: number; profileEnv?: Record<string, string>; assignedId?: string },
): Promise<void> {
  // Async: the id may come from the CLI's own session files (it never rejects; failures are logged).
  return captureSession(params, provider, agentId, exit);
}

async function captureSession(
  params: SpawnAgentParams,
  provider: OrchestratorProvider,
  agentId: string,
  { exitCode, buffer, killed, runMs, profileEnv, assignedId }: { exitCode: number; buffer?: string; killed: boolean; runMs: number; profileEnv?: Record<string, string>; assignedId?: string },
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
      const has = await provider.hasSession(id, profileEnv).catch((): undefined => undefined);
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
      const ours = await provider.hasSessionForCwd(id, params.cwd, profileEnv).catch((): undefined => undefined);
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
      sessionId = await provider.findRunSession({ cwd: params.cwd, startedAt: endedAt - runMs, endedAt, resumedId, profileEnv });
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
  const profileEnv = projectPath ? await resolveProfileEnv(projectPath, id) : undefined;
  return provider.checkAvailability(profileEnv);
}

/** Shared by actual launch and an explicit handshake check. */
export async function resolveCommandPrefix(projectPath: string): Promise<string | undefined> {
  return (await readProjectAgentDefaults(projectPath))?.commandPrefix || undefined;
}

/**
 * Resolve the profile env vars for an agent spawn.
 * Uses project-level profileId, then looks up the orchestrator-specific entry.
 * If the orchestrator is not configured in the profile, logs a warning and returns undefined.
 */
export async function resolveProfileEnv(projectPath: string, orchestratorId: string): Promise<Record<string, string> | undefined> {
  const defaults = await readProjectAgentDefaults(projectPath);
  const profileId = defaults?.profileId;
  if (!profileId) return undefined;

  const profile = profileSettings.getProfile(profileId);
  if (!profile) return undefined;

  const resolved = profileSettings.resolveProfileEnv(profile, orchestratorId);
  if (!resolved) {
    appLog('core:agent', 'warn', `Profile "${profile.name}" has no config for orchestrator "${orchestratorId}" — spawning without profile env`, {
      meta: { profileId, orchestratorId },
    });
    return undefined;
  }

  return resolved;
}

/**
 * List available sessions for a durable agent.
 * Merges provider-discovered sessions with Clubhouse-tracked history.
 */
export async function listSessions(
  projectPath: string,
  agentId: string,
  orchestratorId?: OrchestratorId,
): Promise<Array<{ sessionId: string; startedAt: string; lastActiveAt: string; friendlyName?: string }>> {
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
      const profileEnv = await resolveProfileEnv(projectPath, provider.id);
      providerSessions = await provider.listSessions(cwd, profileEnv);
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
      const profileEnv = await resolveProfileEnv(projectPath, provider.id);
      const has = await provider.hasSession(s.sessionId, profileEnv).catch((): undefined => undefined);
      if (has === false) {
        missing.push(s.sessionId);
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

  // Sort by most recently active
  const result = Array.from(merged.values());
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
      agentTemplatesDir: p.conventions.agentTemplatesDir,
      localSettingsFile: p.conventions.localSettingsFile,
      permissionRules: p.conventions.permissionRules,
    },
  }));
}
