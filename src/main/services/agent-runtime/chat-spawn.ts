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
import { driverPausedReason, probeDriver, recordDriverFailure, recordDriverSuccess } from './chat-driver-health';
import { cliLabel, evaluateCliVersion } from './chat-version-policy';
import { ChatAgentRuntime } from './chat-runtime';
import { registerChatRuntime, unregisterChatRuntime } from './index';
import { readChatTranscript } from './chat-transcript';

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

/** Tell the user (toast) and the log why an agent didn't get the chat it asked for. */
function notifyFallback(agentId: string, notice: ChatRuntimeNotice): void {
  appLog('core:chat', 'warn', notice.message, { meta: { agentId, code: notice.code } });
  broadcastToAllWindows(IPC.CHAT.RUNTIME_NOTICE, agentId, notice);
}

interface DriverCheck {
  ok: boolean;
  /** Why the driver was skipped. */
  reason?: string;
  /** Notes for the transcript when it is used (e.g. an untested CLI version). */
  notices: ChatRuntimeNotice[];
}

/** Paused after repeated failures, handshake, then version policy. Never spends tokens. */
async function checkDriver(driver: ChatDriver, binaryPath: string, env?: Record<string, string>): Promise<DriverCheck> {
  const paused = driverPausedReason(driver.id);
  if (paused) return { ok: false, reason: `${driverLabel(driver)} chat is paused after repeated failures (${paused})`, notices: [] };
  const probe = await probeDriver(driver, binaryPath, env);
  if (!probe.handshakeOk) {
    return { ok: false, reason: `${driverLabel(driver)} handshake failed: ${probe.error ?? 'unknown error'}`, notices: [] };
  }
  const verdict = evaluateCliVersion(driver.id, driver.provider, probe.cliVersion);
  if (verdict.status === 'known_bad' || verdict.status === 'below_min') {
    return { ok: false, reason: verdict.message, notices: [] };
  }
  const notices: ChatRuntimeNotice[] = verdict.status === 'untested' && verdict.message
    ? [{ level: 'info', code: 'untested_cli_version', message: verdict.message }]
    : [];
  return { ok: true, notices };
}

/**
 * Try to start the agent in chat. Returns true when it did; false means the
 * caller should fall back to the terminal.
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
): Promise<boolean> {
  // Only durable agents get chat for now; quick agents stay fire-and-forget.
  if (params.kind !== 'durable') return false;
  const resolved = resolveRuntimeMode(provider.id, durableConfig?.runtimeMode);
  if (resolved.mode !== 'chat') return false;
  const candidates = chatDriverCandidates(provider.id, resolved.driver);
  if (candidates.length === 0) {
    appLog('core:chat', 'info', 'No chat driver registered for provider; using the terminal', {
      meta: { agentId: params.agentId, provider: provider.id },
    });
    return false;
  }
  if (!provider.getBinaryPath) return false;
  let binaryPath: string;
  try {
    binaryPath = provider.getBinaryPath();
  } catch (err) {
    appLog('core:chat', 'warn', 'CLI binary not found for chat; using the terminal', {
      meta: { agentId: params.agentId, provider: provider.id, error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }

  const skipped: string[] = [];
  const usable: Array<{ driver: ChatDriver; notices: ChatRuntimeNotice[] }> = [];
  for (const driver of candidates) {
    const check = await checkDriver(driver, binaryPath, profileEnv);
    if (check.ok) usable.push({ driver, notices: check.notices });
    else skipped.push(check.reason ?? `${driverLabel(driver)} is unavailable`);
  }
  if (usable.length === 0) {
    notifyFallback(params.agentId, { level: 'warn', code: 'fallback', message: `Opened in the terminal: ${skipped.join('; ')}` });
    return false;
  }

  const nonce = randomUUID();
  agentRegistry.setNonce(params.agentId, nonce);
  agentRegistry.setRuntime(params.agentId, 'chat');

  // Clubhouse MCP bridge + project servers, as for terminal agents.
  const mcpEnabled = isMcpEnabled(params.projectPath, durableConfig?.mcpOverride);
  const mcpJsonPath = path.join(params.cwd, provider.conventions.mcpConfigFile || '.mcp.json');
  if (mcpEnabled) configPipeline.snapshotFile(params.agentId, mcpJsonPath);
  let mcpPort = 0;
  try {
    mcpPort = await waitMcpBridgeReady();
    await injectClubhouseMcp(params.cwd, params.agentId, mcpPort, nonce, provider.conventions);
  } catch (err) {
    appLog('core:mcp', 'warn', 'MCP bridge injection skipped for chat agent', {
      meta: { agentId: params.agentId, error: err instanceof Error ? err.message : String(err) },
    });
  }
  const mcpServers = {
    ...(mcpEnabled ? await resolveProjectMcpServers(params.projectPath, durableConfig ?? undefined) : {}),
    ...(mcpPort > 0 ? { clubhouse: buildClubhouseMcpDef(mcpPort, params.agentId, nonce) } : {}),
  };

  const env: Record<string, string> = {
    ...profileEnv,
    CLUBHOUSE_AGENT_ID: params.agentId,
    CLUBHOUSE_HOOK_NONCE: nonce,
    ...(mcpPort > 0 ? { CLUBHOUSE_MCP_PORT: String(mcpPort) } : {}),
  };

  const level = levelForFreeAgent(params.freeAgentMode, params.permissionMode);
  const resumeNativeSessionId = params.resume ? params.sessionId : undefined;
  const continued = resumeNativeSessionId ? await findChatSessionFor(params.agentId, resumeNativeSessionId) : undefined;

  for (const { driver, notices } of usable) {
    const fellBack = skipped.length > 0;
    const startNotices: ChatRuntimeNotice[] = [
      ...(fellBack ? [{ level: 'warn' as const, code: 'fallback', message: `Using ${driverLabel(driver)}: ${skipped.join('; ')}` }] : []),
      ...notices,
    ];
    const error = await startChatRuntime(driver, startNotices);
    if (!error) {
      recordDriverSuccess(driver.id);
      if (fellBack) notifyFallback(params.agentId, startNotices[0]);
      return true;
    }
    recordDriverFailure(driver.id, `session start failed: ${error}`);
    skipped.push(`${driverLabel(driver)} failed to start: ${error}`);
  }

  agentRegistry.setRuntime(params.agentId, 'pty');
  configPipeline.restoreForAgent(params.agentId);
  notifyFallback(params.agentId, { level: 'warn', code: 'fallback', message: `Opened in the terminal: ${skipped.join('; ')}` });
  return false;

  /** Start the agent on one driver. Resolves to undefined on success, or the error message. */
  async function startChatRuntime(driver: ChatDriver, startNotices: ChatRuntimeNotice[]): Promise<string | undefined> {
    const cleanup = (reason: SessionEndReason, exitCode: number) => {
      configPipeline.restoreForAgent(params.agentId);
      unregisterChatRuntime(params.agentId, runtime);
      untrackAgent(params.agentId);
      appLog('core:chat', 'info', 'Chat session ended', { meta: { agentId: params.agentId, reason, exitCode } });
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
      startSession: (resumeId) => driver.start({
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
      }),
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
      meta: { agentId: params.agentId, provider: provider.id, driver: driver.id, level, resumed: !!resumeNativeSessionId },
    });

    registerChatRuntime(runtime);
    try {
      await runtime.start(params.mission);
      return undefined;
    } catch (err) {
      // Close the chat CLI without firing onEnded: a fallback reuses this
      // agent id, and a late untrack/exit broadcast would hit it.
      await runtime.abandon();
      unregisterChatRuntime(params.agentId, runtime);
      const message = err instanceof Error ? err.message : String(err);
      appLog('core:chat', 'warn', 'Chat start failed', { meta: { agentId: params.agentId, driver: driver.id, error: message } });
      return message;
    }
  }
}
