import * as path from 'path';
import { randomUUID } from 'crypto';
import { getProvider, getAllProviders, OrchestratorId, OrchestratorProvider, isHookCapable, isHeadlessCapable, isSessionCapable, isStructuredCapable } from '../orchestrators';
import { waitReady as waitHookServerReady } from './hook-server';
import * as ptyManager from './pty-manager';
import { appLog } from './log-service';
import * as headlessManager from './headless-manager';
import * as headlessSettings from './headless-settings';
import * as freeAgentSettings from './free-agent-settings';
import * as clubhouseModeSettings from './clubhouse-mode-settings';
import * as configPipeline from './config-pipeline';
import { getDurableConfig, addSessionEntry } from './agent-config';
import { materializeAgent, cleanupStaleJsonInTomlConfigs } from './materialization-service';
import * as profileSettings from './profile-settings';
import { readProjectAgentDefaults, readLaunchWrapper, readDefaultMcps } from './agent-settings-service';
import * as structuredManager from './structured-manager';
import { applyLaunchWrapper } from '../orchestrators/shared';
import type { LaunchWrapperConfig, FreeAgentPermissionMode } from '../../shared/types';
import { agentRegistry, resolveOrchestrator, untrackAgent, readProjectOrchestrator, DEFAULT_ORCHESTRATOR } from './agent-registry';
import { waitReady as waitMcpBridgeReady } from './clubhouse-mcp/bridge-server';
import { injectClubhouseMcp } from './clubhouse-mcp/injection';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { isMcpEnabled } from './mcp-settings';

// Re-export registry functions for backward compatibility
export { getAgentProjectPath, getAgentOrchestrator, getAgentNonce, untrackAgent, resolveOrchestrator } from './agent-registry';

export interface SpawnAgentParams {
  agentId: string;
  projectPath: string;
  cwd: string;
  kind: 'durable' | 'quick' | 'companion';
  model?: string;
  mission?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  orchestrator?: OrchestratorId;
  maxTurns?: number;
  maxBudgetUsd?: number;
  freeAgentMode?: boolean;
  /** When true, spawn this agent in structured mode instead of PTY */
  structuredMode?: boolean;
  /** When true, attempt to resume the previous CLI session instead of starting fresh */
  resume?: boolean;
  /** Specific session ID to resume (provider-specific format) */
  sessionId?: string;
  /** Plugin ID that owns this companion agent (required when kind === 'companion'). @since 0.9 */
  pluginOwner?: string;
  /** Path to companion workspace (auto-set for companion agents). @since 0.9 */
  companionWorkspace?: string;
  /** Permission mode override for resume (preserves pre-restart mode) */
  permissionMode?: FreeAgentPermissionMode;
}

export function isHeadlessAgent(agentId: string): boolean {
  return headlessManager.isHeadless(agentId);
}

export function isStructuredAgent(agentId: string): boolean {
  return structuredManager.isStructuredSession(agentId);
}

export async function spawnAgent(params: SpawnAgentParams): Promise<void> {
  const provider = await resolveOrchestrator(params.projectPath, params.orchestrator);

  // Resolve profile env early so it can be passed to checkAvailability.
  // This ensures auth checks (e.g. CLAUDE_CONFIG_DIR) use the correct
  // config directory when a profile is active.
  const profileEnv = await resolveProfileEnv(params.projectPath, provider.id);

  // Read project-level command prefix for shell environment setup
  const projectDefaults = await readProjectAgentDefaults(params.projectPath);
  const commandPrefix = projectDefaults?.commandPrefix || undefined;

  // Pre-flight: verify the orchestrator CLI is available before spawning.
  // This catches missing binaries and auth issues early with clear errors,
  // rather than letting the PTY start and exit immediately.
  const availability = await provider.checkAvailability(profileEnv);
  if (!availability.available) {
    const msg = availability.error || `${provider.displayName} CLI is not available`;
    appLog('core:agent', 'error', `Pre-flight check failed for ${provider.id}`, {
      meta: { agentId: params.agentId, error: msg },
    });
    throw new Error(msg);
  }

  agentRegistry.register(params.agentId, {
    projectPath: params.projectPath,
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

    // Clubhouse Mode: materialize project defaults into worktree before spawn
    if (params.kind === 'durable' && clubhouseModeSettings.isClubhouseModeEnabled(params.projectPath)) {
      try {
        const config = await getDurableConfig(params.projectPath, params.agentId);
        if (config && !config.clubhouseModeOverride && config.worktreePath) {
          await materializeAgent({ projectPath: params.projectPath, agent: config, provider });
        }
      } catch (err) {
        appLog('core:agent', 'warn', 'Clubhouse mode materialization failed, continuing spawn', {
          meta: { agentId: params.agentId, error: err instanceof Error ? err.message : String(err) },
        });
      }
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

    // Resolve the free-agent permission mode (auto vs skip-all) from settings,
    // but honour an explicit override (e.g. from session resume)
    const permissionMode = params.permissionMode ?? freeAgentSettings.getPermissionMode(params.projectPath);

    // Try structured path when enabled and provider supports it
    // Quick agents use structured mode based on project spawn mode setting.
    // Durable agents opt in via per-agent structuredMode config flag.
    // TODO: Apply launch wrapper transform to structured path once adapter architecture supports external binary override
    const spawnMode = headlessSettings.getSpawnMode(params.projectPath);
    const useStructured = (spawnMode === 'structured' && params.kind === 'quick') || params.structuredMode;
    const hasMission = !!params.mission && params.mission.trim() !== '';
    // For durable agents in structured mode without a mission, use a default open-ended prompt.
    // This allows the structured UI to launch and accept messages interactively.
    const structuredMission = hasMission ? params.mission! :
      (useStructured && params.kind === 'durable'
        ? 'You are ready for interactive work. Wait for instructions from the user.'
        : '');
    const canLaunchStructured = useStructured && (hasMission || params.kind === 'durable');
    if (useStructured && !canLaunchStructured) {
      appLog('core:agent', 'warn', 'Structured mode requested but mission is empty — falling back to PTY', {
        meta: { agentId: params.agentId, kind: params.kind },
      });
    }
    if (canLaunchStructured && isStructuredCapable(provider)) {
      appLog('core:agent', 'info', `Spawning ${params.kind} agent in structured mode`, {
        meta: {
          agentId: params.agentId,
          orchestrator: provider.id,
          cwd: params.cwd,
          model: params.model,
          allowedTools: allowedTools?.join(',') || 'none',
          commandPrefix: commandPrefix || 'none',
          freeAgentMode: params.freeAgentMode,
          permissionMode,
        },
      });
      agentRegistry.setRuntime(params.agentId, 'structured');
      const adapter = provider.createStructuredAdapter();
      await structuredManager.startStructuredSession(params.agentId, adapter, {
        mission: structuredMission,
        systemPrompt: params.systemPrompt,
        model: params.model,
        cwd: params.cwd,
        env: profileEnv,
        allowedTools,
        freeAgentMode: params.freeAgentMode,
        permissionMode,
        commandPrefix,
      }, (exitAgentId) => {
        if (params.kind !== 'durable') bindingManager.unbindAgent(exitAgentId);
        untrackAgent(exitAgentId);
      });
      return;
    }

    // Try headless path for quick agents when enabled
    if (spawnMode === 'headless' && params.kind === 'quick' && isHeadlessCapable(provider)) {
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
        // Apply launch wrapper transform if configured
        let { binary: headlessBin, args: headlessArgs } = headlessResult;
        if (wrapperConfig && wrapperConfig.orchestratorMap[provider.id]) {
          const wrapped = applyLaunchWrapper(wrapperConfig, provider.id, headlessBin, headlessArgs, resolvedMcpIds);
          headlessBin = wrapped.binary;
          headlessArgs = wrapped.args;
        }
        const spawnEnv = { ...headlessResult.env, ...profileEnv, ...wrapperConfig?.env, CLUBHOUSE_AGENT_ID: params.agentId };
        await headlessManager.spawnHeadless(
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
          },
          commandPrefix,
        );
        return;
      }
    }

    // Fall back to PTY mode
    await spawnPtyAgent(params, provider, allowedTools, profileEnv, commandPrefix, wrapperConfig, resolvedMcpIds);
  } catch (err) {
    untrackAgent(params.agentId);
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
): Promise<void> {
  const nonce = randomUUID();
  agentRegistry.setNonce(params.agentId, nonce);

  // Snapshot hooks config before writing so we can restore on exit
  const hookConfigPath = configPipeline.getHooksConfigPath(provider, params.cwd);
  if (hookConfigPath) {
    configPipeline.snapshotFile(params.agentId, hookConfigPath);
  }

  // Snapshot MCP config before injection so we can restore on exit
  // Only snapshot when the MCP feature is enabled
  const mcpJsonPath = path.join(params.cwd, provider.conventions.mcpConfigFile || '.mcp.json');
  let agentMcpOverride: boolean | undefined;
  if (params.kind === 'durable') {
    try {
      const agentConfig = await getDurableConfig(params.projectPath, params.agentId);
      agentMcpOverride = agentConfig?.mcpOverride;
    } catch { /* config not available */ }
  }
  const mcpEnabledForSpawn = isMcpEnabled(params.projectPath, agentMcpOverride);
  // Snapshot MCP config for all formats — TOML injection is now supported
  // and the config-pipeline restore logic handles both JSON and TOML files.
  if (mcpEnabledForSpawn) {
    configPipeline.snapshotFile(params.agentId, mcpJsonPath);
  }

  // Resolve the free-agent permission mode (auto vs skip-all) from settings,
  // but honour an explicit override (e.g. from session resume)
  const permissionMode = params.permissionMode ?? freeAgentSettings.getPermissionMode(params.projectPath);

  // Run hook server setup, MCP bridge setup, and command building in parallel.
  let mcpPort = 0;
  const [, , spawnCmd] = await Promise.all([
    waitHookServerReady().then(async (port) => {
      if (isHookCapable(provider)) {
        const hookUrl = `http://127.0.0.1:${port}/hook`;
        await provider.writeHooksConfig(params.cwd, hookUrl);
      }
    }),
    waitMcpBridgeReady().then(async (port) => {
      mcpPort = port;
      await injectClubhouseMcp(params.cwd, params.agentId, port, nonce, provider.conventions);
    }).catch(() => {
      // MCP bridge not started (feature disabled) — continue without it
    }),
    provider.buildSpawnCommand({
      cwd: params.cwd,
      model: params.model,
      mission: params.mission,
      systemPrompt: params.systemPrompt,
      allowedTools,
      agentId: params.agentId,
      freeAgentMode: params.freeAgentMode,
      permissionMode,
      resume: params.resume,
      sessionId: params.sessionId,
    }),
  ]);

  // Inject MCP args for providers that need CLI-based MCP config (e.g. Copilot CLI)
  let { binary, args } = spawnCmd;
  const { env } = spawnCmd;
  if (mcpPort > 0 && provider.buildMcpArgs) {
    const { buildClubhouseMcpDef } = await import('./clubhouse-mcp/injection');
    const serverDef = buildClubhouseMcpDef(mcpPort, params.agentId, nonce);
    args = [...args, ...provider.buildMcpArgs(serverDef)];
  }

  // Apply launch wrapper transform if configured
  if (wrapperConfig && wrapperConfig.orchestratorMap[provider.id]) {
    const wrapped = applyLaunchWrapper(wrapperConfig, provider.id, binary, args, mcpIds || []);
    binary = wrapped.binary;
    args = wrapped.args;
  }

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

  const spawnEnv: Record<string, string> = {
    ...env,
    ...profileEnv,
    ...wrapperConfig?.env,
    CLUBHOUSE_AGENT_ID: params.agentId,
    CLUBHOUSE_HOOK_NONCE: nonce,
    ...(mcpPort > 0 ? { CLUBHOUSE_MCP_PORT: String(mcpPort) } : {}),
  };

  if (profileEnv) {
    appLog('core:agent', 'info', 'Profile env injected', {
      meta: { agentId: params.agentId, profileKeys: Object.keys(profileEnv).join(',') },
    });
  }

  await ptyManager.spawn(params.agentId, params.cwd, binary, args, spawnEnv, (exitAgentId, _exitCode, buffer) => {
    configPipeline.restoreForAgent(exitAgentId);
    if (params.kind !== 'durable') bindingManager.unbindAgent(exitAgentId);
    untrackAgent(exitAgentId);

    // Capture session ID for durable agents — works for all providers
    if (params.kind === 'durable') {
      try {
        // Try provider-specific session ID extraction first, then fall back to generated UUID
        let sessionId: string | null = null;
        if (buffer && isSessionCapable(provider)) {
          sessionId = provider.extractSessionId(buffer);
        }
        if (!sessionId) {
          sessionId = randomUUID();
        }
        const now = new Date().toISOString();
        void addSessionEntry(params.projectPath, exitAgentId, {
          sessionId,
          startedAt: now,
          lastActiveAt: now,
        }).then(() => {
          appLog('core:agent', 'info', 'Captured session ID on exit', {
            meta: { agentId: exitAgentId, sessionId },
          });
        }).catch((entryErr) => {
          appLog('core:agent', 'warn', 'Failed to persist session entry', {
            meta: { agentId: exitAgentId, sessionId, error: entryErr instanceof Error ? entryErr.message : String(entryErr) },
          });
        });
      } catch (err) {
        appLog('core:agent', 'warn', 'Failed to capture session ID', {
          meta: { agentId: exitAgentId, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }, commandPrefix);
}

export async function killAgent(agentId: string, projectPath: string, orchestrator?: OrchestratorId): Promise<void> {
  appLog('core:agent', 'info', 'Killing agent', { meta: { agentId } });
  try {
    const tracked = agentRegistry.get(agentId);

    if (tracked?.runtime === 'structured' || (!tracked && structuredManager.isStructuredSession(agentId))) {
      untrackAgent(agentId);
      await structuredManager.cancelSession(agentId);
      return;
    }
    if (tracked?.runtime === 'headless' || (!tracked && headlessManager.isHeadless(agentId))) {
      untrackAgent(agentId);
      headlessManager.kill(agentId);
      return;
    }
    const provider = await resolveOrchestrator(projectPath, tracked?.orchestrator || orchestrator);
    const exitCmd = provider.getExitCommand();
    ptyManager.gracefulKill(agentId, exitCmd);
  } catch (err) {
    appLog('core:agent', 'warn', 'killAgent failed (process may already be dead)', {
      meta: { agentId, error: err instanceof Error ? err.message : String(err) },
    });
  }
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

  // Add Clubhouse-only sessions (not found by provider)
  for (const s of clubhouseHistory) {
    if (!merged.has(s.sessionId)) {
      merged.set(s.sessionId, s);
    }
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
    conventions: {
      configDir: p.conventions.configDir,
      localInstructionsFile: p.conventions.localInstructionsFile,
      legacyInstructionsFile: p.conventions.legacyInstructionsFile,
      mcpConfigFile: p.conventions.mcpConfigFile,
      skillsDir: p.conventions.skillsDir,
      agentTemplatesDir: p.conventions.agentTemplatesDir,
      localSettingsFile: p.conventions.localSettingsFile,
    },
  }));
}
