/**
 * Starts an agent in the chat runtime when the experimental Chat flag is on,
 * the provider (or the agent) is set to Chat, and a chat driver is registered
 * for the provider. Otherwise returns false and the caller spawns a terminal.
 *
 * Spawn preparation mirrors the PTY path where it matters for parity: a
 * nonce, the Clubhouse MCP bridge (plus project MCP servers) and the agent
 * env. Clubhouse's own status/permission hooks are deliberately NOT injected:
 * chat agents get status and approvals from the protocol instead.
 */

import { randomUUID } from 'crypto';
import * as path from 'path';
import type { OrchestratorProvider } from '../../orchestrators';
import type { FreeAgentPermissionMode, DurableAgentConfig } from '../../../shared/types';
import type { PermissionLevel, SessionEndReason, ChatEvent } from '../../../shared/chat';
import { agentRegistry, untrackAgent } from '../agent-registry';
import * as configPipeline from '../config-pipeline';
import { waitReady as waitMcpBridgeReady } from '../clubhouse-mcp/bridge-server';
import { injectClubhouseMcp, buildClubhouseMcpDef } from '../clubhouse-mcp/injection';
import { isMcpEnabled } from '../mcp-settings';
import { resolveProjectMcpServers } from '../materialization-service';
import { updateSessionId } from '../agent-config';
import { broadcastAgentExit } from '../agent-exit-broadcast';
import { appLog } from '../log-service';
import { resolveRuntimeMode } from '../chat-runtime-settings';
import type { ChatDriver } from '../../../shared/chat';
import { IPC } from '../../../shared/ipc-channels';
import { broadcastToAllWindows } from '../../util/ipc-broadcast';
import { listChatDrivers, resolveChatDriver } from './chat-drivers';
import { driverHealthKey, driverPausedReason, probeDriver, recordDriverFailure, recordDriverSuccess } from './chat-driver-health';
import { cliLabel, evaluateCliVersion } from './chat-version-policy';
import { ChatAgentRuntime, ChatStartCancelledError } from './chat-runtime';
import { registerChatRuntime, unregisterChatRuntime } from './index';
import { readChatTranscript } from './chat-transcript';
import { captureBeforePrompt } from './checkpoint-tracker';
import { noteChatStartFailure } from './stale-session';
import { chatSleepInfo, recordSleep, takeKillRequest } from './sleep-reason';
import { waitsOnPollingGroupProject } from './idle-policy';
import { chatIdleTimeoutMs } from '../chat-idle-settings';
import { cleanSpawnEnv, getShellEnvironment, summarizeSpawnEnv } from '../../util/shell';

export interface ChatSpawnParams {
  agentId: string;
  projectPath: string;
  cwd: string;
  kind: 'durable' | 'quick' | 'companion';
  model?: string;
  mission?: string;
  systemPrompt?: string;
  freeAgentMode?: boolean;
  permissionMode: FreeAgentPermissionMode;
  resume?: boolean;
  sessionId?: string;
  extraArgs?: string[];
}

/** Free Agent Mode maps onto the permission ladder; otherwise ask first. */
export function levelForFreeAgent(freeAgentMode: boolean | undefined, permissionMode: FreeAgentPermissionMode): PermissionLevel {
  if (!freeAgentMode) return 'ask';
  return permissionMode === 'skip-all' ? 'full_access' : 'auto';
}

/** Find the Clubhouse chat session that last ran this native session, to continue its sequence. */
export async function findChatSessionFor(agentId: string, nativeSessionId: string): Promise<{ sessionId: string; lastSeq: number } | undefined> {
  const events = await readChatTranscript(agentId);
  let sessionId: string | undefined;
  for (const e of events) {
    if (e.type === 'session_started' && e.data.nativeSessionId === nativeSessionId) sessionId = e.sessionId;
  }
  if (!sessionId) return undefined;
  const lastSeq = events.filter((e: ChatEvent) => e.sessionId === sessionId).reduce((m, e) => Math.max(m, e.seq), 0);
  return { sessionId, lastSeq };
}

/** A chat runtime notice, also shown to the user when an agent falls back. */
export interface ChatRuntimeNotice {
  level: 'info' | 'warn';
  code: string;
  message: string;
}

const DRIVER_LABELS: Record<string, string> = {
  claude_agent_sdk: 'Agent SDK',
  claude_stream_json: 'stream-json',
  codex_app_server: 'app-server',
  copilot_acp: 'ACP',
  copilot_sdk: 'Copilot SDK',
  acp: 'ACP',
};

function driverLabel(driver: ChatDriver): string {
  return `${cliLabel(driver.provider)} (${DRIVER_LABELS[driver.id] ?? driver.id})`;
}

/**
 * Drivers to try for a provider, in fallback order: the preferred one (or the
 * provider default), then the provider's other drivers in registration order.
 * For Claude that is Agent SDK, then stream-json; the terminal comes last.
 */
export function chatDriverCandidates(provider: string, preferred?: ChatDriver['id']): ChatDriver[] {
  const first = resolveChatDriver(provider, preferred);
  if (!first) return [];
  return [first, ...listChatDrivers().filter((d) => d.provider === provider && d !== first)];
}

/**
 * A start failure that means "log in first": the probe can't see it (Copilot
 * advertises its login method whether or not you're logged in), so it shows
 * up as the session request failing.
 */
export function isLoginRequiredError(message: string): boolean {
  return /authentication required|not logged in|not authenticated|unauthori[sz]ed|please (run )?\S*\s*login/i.test(message);
}

/** Tell the user (toast) and the log why an agent didn't get the chat it asked for. */
function notifyFallback(agentId: string, notice: ChatRuntimeNotice): void {
  appLog('core:chat', 'warn', notice.message, { meta: { agentId, code: notice.code } });
  broadcastToAllWindows(IPC.CHAT.RUNTIME_NOTICE, agentId, notice);
}

interface DriverCheck {
  ok: boolean;
  /** Why the driver was skipped. */
  reason?: string;
  /** Set when the CLI works but the user isn't logged in; the CLI's own hint, if any. */
  login?: { hint?: string };
  /** Notes for the transcript when it is used (e.g. an untested CLI version). */
  notices: ChatRuntimeNotice[];
}

/** Paused after repeated failures, handshake, then version policy. Never spends tokens. */
async function checkDriver(driver: ChatDriver, key: string, binaryPath: string, env?: Record<string, string>, commandPrefix?: string): Promise<DriverCheck> {
  const paused = driverPausedReason(key);
  if (paused) return { ok: false, reason: `${driverLabel(driver)} chat is paused after repeated failures (${paused})`, notices: [] };
  const probe = await probeDriver(driver, binaryPath, env, commandPrefix);
  if (!probe.handshakeOk) {
    return { ok: false, reason: `${driverLabel(driver)} handshake failed: ${probe.error ?? 'unknown error'}`, notices: [] };
  }
  if (probe.needsLogin) {
    return { ok: false, reason: `${driverLabel(driver)} needs a login`, login: { hint: probe.loginHint }, notices: [] };
  }
  const verdict = evaluateCliVersion(driver.id, driver.provider, probe.cliVersion);
  if (verdict.status === 'known_bad' || verdict.status === 'below_min') {
    return { ok: false, reason: verdict.message, notices: [] };
  }
  if (verdict.status !== 'untested' || !verdict.message) return { ok: true, notices: [] };
  // Expected whenever the CLI ships before chat is retested: log it; the view
  // shows it only alongside a real problem.
  appLog('core:chat', 'info', verdict.message, { meta: { driver: driver.id, cliVersion: verdict.version } });
  return { ok: true, notices: [{ level: 'info', code: 'untested_cli_version', message: verdict.message }] };
}

/**
 * How a chat start ended: in chat; not in chat, so the caller opens the
 * terminal; or cancelled (the agent was killed, or a newer start for it took
 * over), so the caller does nothing more.
 */
export type ChatStartResult = 'chat' | 'terminal' | 'cancelled';

interface InflightStart {
  controller: AbortController;
  /** Set once the start has a runtime registered. */
  runtime?: ChatAgentRuntime;
  /** Whether prepare() ran, so there is MCP config to restore. */
  prepared: boolean;
}

/** One chat start at a time per agent. */
const inflightStarts = new Map<string, InflightStart>();

/**
 * Cancel the agent's chat start in progress, as a kill. A runtime that is
 * already registered is stopped, which ends it the usual way (config restore,
 * untrack, exit broadcast); before that, the same cleanup runs here. The
 * cancelled start then returns 'cancelled' and never falls back. Returns
 * false when no start was in progress.
 */
export async function cancelChatStart(agentId: string): Promise<boolean> {
  const start = inflightStarts.get(agentId);
  if (!start) return false;
  inflightStarts.delete(agentId);
  appLog('core:chat', 'info', 'Cancelling chat start', { meta: { agentId, reason: 'killed', runtimeRegistered: !!start.runtime } });
  start.controller.abort();
  if (start.runtime) {
    await start.runtime.stop();
  } else {
    if (start.prepared) configPipeline.restoreForAgent(agentId);
    untrackAgent(agentId);
    broadcastAgentExit(agentId, 0);
  }
  return true;
}

/** For tests. */
export function hasChatStartInFlight(agentId: string): boolean {
  return inflightStarts.has(agentId);
}

/**
 * Try to start the agent in chat. Returns 'chat' when it did; 'terminal'
 * means the caller should fall back to the terminal; 'cancelled' means the
 * start was cancelled and the caller must not start anything. `onStarting` is
 * called once a driver and CLI are found and the chat start really begins, so
 * a caller can tell a failed start (called, then 'terminal') from an agent
 * that was never chat.
 *
 * Only one start runs per agent: a new start cancels the one in progress
 * (closing its CLI without an exit broadcast), and cancelChatStart() cancels
 * it as a kill. A cancelled start, even one whose driver later times out,
 * never tries another driver, restores config or opens the terminal.
 *
 * Drivers are tried in fallback order. One is skipped when it is paused after
 * repeated failures, its handshake fails, or its CLI version is below the
 * minimum or known to be bad; a driver that fails to start counts a failure
 * and the next one is tried. Ending up on a lower driver or the terminal is
 * reported to the user with the reason.
 */
export async function tryStartChatAgent(
  params: ChatSpawnParams,
  provider: OrchestratorProvider,
  profileEnv: Record<string, string> | undefined,
  commandPrefix: string | undefined,
  durableConfig: DurableAgentConfig | null | undefined,
  onStarting?: () => void,
): Promise<ChatStartResult> {
  // Only durable agents get chat for now; quick agents stay fire-and-forget.
  if (params.kind !== 'durable') return 'terminal';
  const resolved = resolveRuntimeMode(provider.id, durableConfig?.runtimeMode);
  if (resolved.mode !== 'chat') return 'terminal';
  const candidates = chatDriverCandidates(provider.id, resolved.driver);
  if (candidates.length === 0) {
    appLog('core:chat', 'info', 'No chat driver registered for provider; using the terminal', {
      meta: { agentId: params.agentId, provider: provider.id },
    });
    return 'terminal';
  }
  if (!provider.getBinaryPath) return 'terminal';
  let binaryPath: string;
  try {
    binaryPath = provider.getBinaryPath();
  } catch (err) {
    appLog('core:chat', 'warn', 'CLI binary not found for chat; using the terminal', {
      meta: { agentId: params.agentId, provider: provider.id, error: err instanceof Error ? err.message : String(err) },
    });
    return 'terminal';
  }

  const previous = inflightStarts.get(params.agentId);
  const start: InflightStart = { controller: new AbortController(), prepared: false };
  inflightStarts.set(params.agentId, start);
  if (previous) {
    appLog('core:chat', 'info', 'Cancelling chat start', { meta: { agentId: params.agentId, reason: 'superseded', runtimeRegistered: !!previous.runtime } });
    previous.controller.abort();
    // Close the old CLI without onEnded: this start owns the agent id now.
    if (previous.runtime) {
      await previous.runtime.abandon();
      unregisterChatRuntime(params.agentId, previous.runtime);
    }
    // Undo its MCP injection now: this start snapshots the file again, and
    // the agent's one restore on exit would otherwise leave the old entry.
    if (previous.prepared) configPipeline.restoreForAgent(params.agentId);
  }
  onStarting?.();
  try {
    return await runChatStart(params, provider, profileEnv, commandPrefix, durableConfig, candidates, binaryPath, start);
  } catch (err) {
    if (!(err instanceof ChatStartCancelledError)) throw err;
    appLog('core:chat', 'info', 'Chat start cancelled; not opening the terminal', { meta: { agentId: params.agentId } });
    return 'cancelled';
  } finally {
    if (inflightStarts.get(params.agentId) === start) inflightStarts.delete(params.agentId);
  }
}

async function runChatStart(
  params: ChatSpawnParams,
  provider: OrchestratorProvider,
  profileEnv: Record<string, string> | undefined,
  commandPrefix: string | undefined,
  durableConfig: DurableAgentConfig | null | undefined,
  candidates: ChatDriver[],
  binaryPath: string,
  start: InflightStart,
): Promise<ChatStartResult> {
  const { signal } = start.controller;
  /** Called after every await: a cancelled start stops where it is. */
  const checkpoint = () => {
    if (signal.aborted) throw new ChatStartCancelledError();
  };

  // Electron's inherited PATH may not contain Node for npm CLI shims. Match
  // the terminal launch and use the same effective env for probing, health
  // keys and the actual session; profile values remain overrides.
  const launchEnv = cleanSpawnEnv({ ...getShellEnvironment(), ...profileEnv });
  const level = levelForFreeAgent(params.freeAgentMode, params.permissionMode);
  const resumeNativeSessionId = params.resume ? params.sessionId : undefined;
  appLog('core:chat', 'info', 'Chat start requested', {
    meta: {
      agentId: params.agentId,
      provider: provider.id,
      candidates: candidates.map((d) => d.id),
      resumeSessionId: resumeNativeSessionId ?? null,
      binaryPath,
      profileEnvKeys: profileEnv ? Object.keys(profileEnv) : [],
    },
  });
  let prepared: { env: Record<string, string>; mcpServers: Record<string, unknown>; continued?: { sessionId: string; lastSeq: number } } | undefined;

  // Probe lazily, in order, and stop at the first usable driver: the
  // preferred driver working means no other driver is probed or reported.
  const skipped: string[] = [];
  let login: { hint?: string } | undefined;
  for (const [index, driver] of candidates.entries()) {
    const key = driverHealthKey(driver, binaryPath, launchEnv, commandPrefix);
    const checkStartedAt = Date.now();
    const check = await checkDriver(driver, key, binaryPath, launchEnv, commandPrefix);
    checkpoint();
    appLog('core:chat', check.ok ? 'info' : 'warn', 'Chat driver check', {
      meta: {
        agentId: params.agentId,
        driver: driver.id,
        ok: check.ok,
        durationMs: Date.now() - checkStartedAt,
        ...(check.reason ? { reason: check.reason } : {}),
        ...(check.login ? { loginRequired: true } : {}),
        ...(check.notices.length ? { notices: check.notices.map((n) => n.code) } : {}),
      },
    });
    if (!check.ok) {
      skipped.push(check.reason ?? `${driverLabel(driver)} is unavailable`);
      // Every driver of a provider shares its login; don't try the next one.
      if (check.login) { login = check.login; break; }
      continue;
    }
    prepared ??= await prepare();
    checkpoint();
    const fallbackNotice: ChatRuntimeNotice | undefined = index > 0
      ? { level: 'warn', code: 'fallback', message: `Using ${driverLabel(driver)}: ${skipped.join('; ')}` }
      : undefined;
    const outcome = await startChatRuntime(driver, [...(fallbackNotice ? [fallbackNotice] : []), ...check.notices], prepared);
    // Covers a start whose driver timed out after the cancel: it never counts
    // as a driver failure, tries the next driver or falls back.
    checkpoint();
    if (!('error' in outcome)) {
      recordDriverSuccess(key);
      if (fallbackNotice) notifyFallback(params.agentId, fallbackNotice);
      return 'chat';
    }
    if (outcome.sessionStarted) {
      // The CLI may already have the mission: don't hand it to another driver.
      skipped.push(`${driverLabel(driver)} failed after its session started: ${outcome.error}`);
      break;
    }
    if (isLoginRequiredError(outcome.error)) {
      // Not the driver's fault, and every driver of a provider shares the login.
      skipped.push(`${driverLabel(driver)} needs a login: ${outcome.error}`);
      login = {};
      break;
    }
    // A stale resume id fails every driver alike; it says nothing about this one's health.
    if (!resumeNativeSessionId) recordDriverFailure(key, `session start failed: ${outcome.error}`);
    noteChatStartFailure(params.agentId, outcome.error);
    skipped.push(`${driverLabel(driver)} failed to start: ${outcome.error}`);
  }

  if (prepared) {
    agentRegistry.setRuntime(params.agentId, 'pty');
    configPipeline.restoreForAgent(params.agentId);
  }
  // The terminal is where the CLI's own login flow works.
  notifyFallback(params.agentId, login
    ? {
        level: 'info',
        code: 'login_required',
        message: `${cliLabel(provider.id)} needs you to log in. Opening the terminal so you can log in${login.hint ? ` (${login.hint})` : ''}. Chat starts next time.`,
      }
    : { level: 'warn', code: 'fallback', message: `Opened in the terminal: ${skipped.join('; ')}` });
  return 'terminal';

  /** Nonce, Clubhouse MCP bridge + project servers and env: once, before the first start attempt. */
  async function prepare(): Promise<NonNullable<typeof prepared>> {
    const nonce = randomUUID();
    agentRegistry.setNonce(params.agentId, nonce);
    agentRegistry.setRuntime(params.agentId, 'chat');
    start.prepared = true;

    const mcpEnabled = isMcpEnabled(params.projectPath, durableConfig?.mcpOverride);
    const mcpJsonPath = path.join(params.cwd, provider.conventions.mcpConfigFile || '.mcp.json');
    if (mcpEnabled) configPipeline.snapshotFile(params.agentId, mcpJsonPath);
    let mcpPort = 0;
    try {
      mcpPort = await waitMcpBridgeReady();
      // A newer start has its own nonce: don't overwrite its MCP config with this one.
      checkpoint();
      await injectClubhouseMcp(params.cwd, params.agentId, mcpPort, nonce, provider.conventions);
    } catch (err) {
      if (err instanceof ChatStartCancelledError) throw err;
      appLog('core:mcp', 'warn', 'MCP bridge injection skipped for chat agent', {
        meta: { agentId: params.agentId, error: err instanceof Error ? err.message : String(err) },
      });
    }
    const mcpServers = {
      ...(mcpEnabled ? await resolveProjectMcpServers(params.projectPath, durableConfig ?? undefined) : {}),
      ...(mcpPort > 0 ? { clubhouse: buildClubhouseMcpDef(mcpPort, params.agentId, nonce) } : {}),
    };
    const env: Record<string, string> = {
      ...launchEnv,
      CLUBHOUSE_AGENT_ID: params.agentId,
      CLUBHOUSE_HOOK_NONCE: nonce,
      ...(mcpPort > 0 ? { CLUBHOUSE_MCP_PORT: String(mcpPort) } : {}),
    };
    const continued = resumeNativeSessionId ? await findChatSessionFor(params.agentId, resumeNativeSessionId) : undefined;
    return { env, mcpServers, continued };
  }

  /**
   * Start the agent on one driver. `sessionStarted` says whether the driver
   * session was up before the failure (then the mission may have reached it).
   */
  async function startChatRuntime(
    driver: ChatDriver,
    startNotices: ChatRuntimeNotice[],
    { env, mcpServers, continued }: NonNullable<typeof prepared>,
  ): Promise<{ ok: true } | { ok: false; error: string; sessionStarted: boolean }> {
    let sessionStarted = false;
    const cleanup = (reason: SessionEndReason, exitCode: number) => {
      configPipeline.restoreForAgent(params.agentId);
      unregisterChatRuntime(params.agentId, runtime);
      untrackAgent(params.agentId);
      appLog('core:chat', 'info', 'Chat session ended', { meta: { agentId: params.agentId, reason, exitCode } });
      const sleep = chatSleepInfo(reason, exitCode, takeKillRequest(params.agentId), runtime.idleSleptAfterMs);
      if (sleep) void recordSleep(params.projectPath, params.agentId, sleep);
      broadcastAgentExit(params.agentId, exitCode);
    };

    const runtime: ChatAgentRuntime = new ChatAgentRuntime({
      agentId: params.agentId,
      provider: provider.id,
      driverId: driver.id,
      cwd: params.cwd,
      level,
      // A resumed session already has its instructions; only new sessions need them.
      systemPrompt: resumeNativeSessionId ? undefined : params.systemPrompt,
      resumeNativeSessionId,
      sessionId: continued?.sessionId,
      lastSeq: continued?.lastSeq,
      startNotices,
      idleTimeoutMs: chatIdleTimeoutMs,
      shouldIdleSleep: () => !waitsOnPollingGroupProject(params.agentId),
      startSession: async (resumeId, startSignal) => {
        const session = await driver.start({
        agentId: params.agentId,
        provider: provider.id,
        cwd: params.cwd,
        binaryPath,
        env,
        commandPrefix,
        model: params.model,
        level,
        systemPrompt: params.systemPrompt,
        resumeNativeSessionId: resumeId,
        mcpServers,
        ...(params.extraArgs?.length ? { extraArgs: params.extraArgs } : {}),
        ...(startSignal ? { signal: startSignal } : {}),
        });
        sessionStarted = true;
        return session;
      },
      beforePrompt: () => captureBeforePrompt(params.agentId),
      onNativeSessionId: (id) => {
        void updateSessionId(params.projectPath, params.agentId, id).catch((err) => {
          appLog('core:chat', 'warn', 'Failed to persist native session id', {
            meta: { agentId: params.agentId, error: err instanceof Error ? err.message : String(err) },
          });
        });
      },
      onEnded: cleanup,
    });

    appLog('core:chat', 'info', 'Starting chat agent', {
      meta: {
        agentId: params.agentId,
        provider: provider.id,
        driver: driver.id,
        level,
        resumed: !!resumeNativeSessionId,
        resumeSessionId: resumeNativeSessionId ?? null,
        continuedChatSession: continued?.sessionId ?? null,
        mcpServers: Object.keys(mcpServers),
        // What the driver's child gets: the login shell env plus overrides.
        env: summarizeSpawnEnv(env),
      },
    });

    registerChatRuntime(runtime);
    start.runtime = runtime;
    try {
      await runtime.start(params.mission);
      return { ok: true };
    } catch (err) {
      if (signal.aborted || runtime.wasStopped) {
        // Killed or replaced mid-start. stop() already ended it the usual way;
        // a replaced start is abandoned here, without onEnded.
        await runtime.abandon();
        unregisterChatRuntime(params.agentId, runtime);
        throw new ChatStartCancelledError();
      }
      // Close the chat CLI without firing onEnded: a fallback reuses this
      // agent id, and a late untrack/exit broadcast would hit it.
      await runtime.abandon();
      unregisterChatRuntime(params.agentId, runtime);
      const message = err instanceof Error ? err.message : String(err);
      appLog('core:chat', 'warn', 'Chat start failed', { meta: { agentId: params.agentId, driver: driver.id, error: message, sessionStarted } });
      return { ok: false, error: message, sessionStarted };
    }
  }
}

