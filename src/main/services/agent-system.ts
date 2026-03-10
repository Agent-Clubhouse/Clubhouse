import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { getProvider, getAllProviders, OrchestratorId, OrchestratorProvider, isHookCapable, isHeadlessCapable, isSessionCapable, isStructuredCapable } from '../orchestrators';
import { waitReady as waitHookServerReady } from './hook-server';
import * as ptyManager from './pty-manager';
import { appLog } from './log-service';
import * as headlessManager from './headless-manager';
import * as headlessSettings from './headless-settings';
import * as clubhouseModeSettings from './clubhouse-mode-settings';
import * as configPipeline from './config-pipeline';
import { getDurableConfig, addSessionEntry } from './agent-config';
import { materializeAgent } from './materialization-service';
import * as profileSettings from './profile-settings';
import { readProjectAgentDefaults, readLaunchWrapper, readDefaultMcps } from './agent-settings-service';
import * as structuredManager from './structured-manager';
import { applyLaunchWrapper } from '../orchestrators/shared';
import type { LaunchWrapperConfig } from '../../shared/types';

const DEFAULT_ORCHESTRATOR: OrchestratorId = 'claude-code';

interface AgentRegistration {
  projectPath: string;
  orchestrator: OrchestratorId;
  nonce?: string;
}

class AgentRegistry {
  private readonly registrations = new Map<string, AgentRegistration>();

  register(agentId: string, registration: AgentRegistration): void {
    this.registrations.set(agentId, registration);
  }

  get(agentId: string): AgentRegistration | undefined {
    return this.registrations.get(agentId);
  }

  setNonce(agentId: string, nonce: string): void {
    const registration = this.registrations.get(agentId);
    if (!registration) return;
    registration.nonce = nonce;
  }

  untrack(agentId: string): void {
    this.registrations.delete(agentId);
  }
}

const agentRegistry = new AgentRegistry();

export function getAgentProjectPath(agentId: string): string | undefined {
  return agentRegistry.get(agentId)?.projectPath;
}

export function getAgentOrchestrator(agentId: string): OrchestratorId | undefined {
  return agentRegistry.get(agentId)?.orchestrator;
}

export function getAgentNonce(agentId: string): string | undefined {
  return agentRegistry.get(agentId)?.nonce;
}

export function untrackAgent(agentId: string): void {
  agentRegistry.untrack(agentId);
}

/** Read the project-level orchestrator setting from .clubhouse/settings.json */
function readProjectOrchestrator(projectPath: string): OrchestratorId | undefined {
  try {
    const settingsPath = path.join(projectPath, '.clubhouse', 'settings.json');
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    return raw.orchestrator as OrchestratorId | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve which orchestrator to use with cascading priority:
 * 1. Agent-level override (if provided)
 * 2. Project-level setting
 * 3. App default ('claude-code')
 */
export function resolveOrchestrator(
  projectPath: string,
  agentOrchestrator?: OrchestratorId
): OrchestratorProvider {
  const id = agentOrchestrator
    || readProjectOrchestrator(projectPath)
    || DEFAULT_ORCHESTRATOR;

  const provider = getProvider(id);
  if (!provider) {
    appLog('core:agent', 'error', `Unknown orchestrator requested: ${id}`, {
      meta: { orchestratorId: id, projectPath },
    });
    throw new Error(`Unknown orchestrator: ${id}`);
  }
  return provider;
}

export interface SpawnAgentParams {
  agentId: string;
  projectPath: string;
  cwd: string;
  kind: 'durable' | 'quick';
  model?: string;
  mission?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  orchestrator?: OrchestratorId;
  maxTurns?: number;
  maxBudgetUsd?: number;
  freeAgentMode?: boolean;
  /** When true, attempt to resume the previous CLI session instead of starting fresh */
  resume?: boolean;
  /** Specific session ID to resume (provider-specific format) */
  sessionId?: string;
}

export function isHeadlessAgent(agentId: string): boolean {
  return headlessManager.isHeadless(agentId);
}

export function isStructuredAgent(agentId: string): boolean {
  return structuredManager.isStructuredSession(agentId);
}

export async function spawnAgent(params: SpawnAgentParams): Promise<void> {
  const provider = resolveOrchestrator(params.projectPath, params.orchestrator);

  // Resolve profile env early so it can be passed to checkAvailability.
  // This ensures auth checks (e.g. CLAUDE_CONFIG_DIR) use the correct
  // config directory when a profile is active.
  const profileEnv = resolveProfileEnv(params.projectPath, provider.id);

  // Read project-level command prefix for shell environment setup
  const projectDefaults = readProjectAgentDefaults(params.projectPath);
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
  });

  try {
    // Clubhouse Mode: materialize project defaults into worktree before spawn
    if (params.kind === 'durable' && clubhouseModeSettings.isClubhouseModeEnabled(params.projectPath)) {
      try {
        const config = getDurableConfig(params.projectPath, params.agentId);
        if (config && !config.clubhouseModeOverride && config.worktreePath) {
          materializeAgent({ projectPath: params.projectPath, agent: config, provider });
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
    const wrapperConfig = readLaunchWrapper(params.projectPath);
    let resolvedMcpIds: string[] = [];
    if (wrapperConfig) {
      if (params.kind === 'durable') {
        const config = getDurableConfig(params.projectPath, params.agentId);
        resolvedMcpIds = config?.mcpIds || readDefaultMcps(params.projectPath);
      } else {
        resolvedMcpIds = readDefaultMcps(params.projectPath);
      }
    }

    // Try structured path when enabled and provider supports it
    // TODO: Apply launch wrapper transform to structured path once adapter architecture supports external binary override
    const spawnMode = headlessSettings.getSpawnMode(params.projectPath);
    if (spawnMode === 'structured' && params.kind === 'quick' && isStructuredCapable(provider)) {
      const adapter = provider.createStructuredAdapter();
      await structuredManager.startStructuredSession(params.agentId, adapter, {
        mission: params.mission || '',
        systemPrompt: params.systemPrompt,
        model: params.model,
        cwd: params.cwd,
        env: profileEnv,
        allowedTools,
        freeAgentMode: params.freeAgentMode,
        commandPrefix,
      }, (exitAgentId) => {
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
      });

      if (headlessResult) {
        // Apply launch wrapper transform if configured
        let { binary: headlessBin, args: headlessArgs } = headlessResult;
        if (wrapperConfig && wrapperConfig.orchestratorMap[provider.id]) {
          const wrapped = applyLaunchWrapper(wrapperConfig, provider.id, headlessBin, headlessArgs, resolvedMcpIds);
          headlessBin = wrapped.binary;
          headlessArgs = wrapped.args;
        }
        const spawnEnv = { ...headlessResult.env, ...profileEnv, ...wrapperConfig?.env, CLUBHOUSE_AGENT_ID: params.agentId };
        headlessManager.spawnHeadless(
          params.agentId,
          params.cwd,
          headlessBin,
          headlessArgs,
          spawnEnv,
          headlessResult.outputKind || 'stream-json',
          (exitAgentId) => {
            configPipeline.restoreForAgent(exitAgentId);
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

  // Run hook server setup and command building in parallel — they're independent.
  const [, spawnCmd] = await Promise.all([
    waitHookServerReady().then(async (port) => {
      if (isHookCapable(provider)) {
        const hookUrl = `http://127.0.0.1:${port}/hook`;
        await provider.writeHooksConfig(params.cwd, hookUrl);
      }
    }),
    provider.buildSpawnCommand({
      cwd: params.cwd,
      model: params.model,
      mission: params.mission,
      systemPrompt: params.systemPrompt,
      allowedTools,
      agentId: params.agentId,
      freeAgentMode: params.freeAgentMode,
      resume: params.resume,
      sessionId: params.sessionId,
    }),
  ]);

  // Apply launch wrapper transform if configured
  let { binary, args } = spawnCmd;
  const { env } = spawnCmd;
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

  const spawnEnv = { ...env, ...profileEnv, ...wrapperConfig?.env, CLUBHOUSE_AGENT_ID: params.agentId, CLUBHOUSE_HOOK_NONCE: nonce };

  if (profileEnv) {
    appLog('core:agent', 'info', 'Profile env injected', {
      meta: { agentId: params.agentId, profileKeys: Object.keys(profileEnv).join(',') },
    });
  }

  ptyManager.spawn(params.agentId, params.cwd, binary, args, spawnEnv, (exitAgentId, _exitCode, buffer) => {
    configPipeline.restoreForAgent(exitAgentId);
    untrackAgent(exitAgentId);

    // Capture session ID for durable agents
    if (params.kind === 'durable' && buffer && isSessionCapable(provider)) {
      try {
        const sessionId = provider.extractSessionId(buffer);
        if (sessionId) {
          const now = new Date().toISOString();
          addSessionEntry(params.projectPath, exitAgentId, {
            sessionId,
            startedAt: now,
            lastActiveAt: now,
          });
          appLog('core:agent', 'info', 'Captured session ID on exit', {
            meta: { agentId: exitAgentId, sessionId },
          });
        }
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
    if (structuredManager.isStructuredSession(agentId)) {
      untrackAgent(agentId);
      await structuredManager.cancelSession(agentId);
      return;
    }
    if (headlessManager.isHeadless(agentId)) {
      untrackAgent(agentId);
      headlessManager.kill(agentId);
      return;
    }
    const tracked = agentRegistry.get(agentId)?.orchestrator;
    const provider = resolveOrchestrator(projectPath, tracked || orchestrator);
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
  const id = orchestrator || (projectPath ? readProjectOrchestrator(projectPath) : undefined) || DEFAULT_ORCHESTRATOR;
  const provider = getProvider(id);
  if (!provider) {
    return { available: false, error: `Unknown orchestrator: ${id}` };
  }
  const profileEnv = projectPath ? resolveProfileEnv(projectPath, id) : undefined;
  return provider.checkAvailability(profileEnv);
}

/**
 * Resolve the profile env vars for an agent spawn.
 * Uses project-level profileId, then looks up the orchestrator-specific entry.
 * If the orchestrator is not configured in the profile, logs a warning and returns undefined.
 */
export function resolveProfileEnv(projectPath: string, orchestratorId: string): Record<string, string> | undefined {
  const defaults = readProjectAgentDefaults(projectPath);
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
  const config = getDurableConfig(projectPath, agentId);
  if (!config) return [];

  const provider = resolveOrchestrator(projectPath, orchestratorId || config.orchestrator);
  const cwd = config.worktreePath || projectPath;

  // Get Clubhouse-tracked session history (includes friendly names)
  const clubhouseHistory = getSessionHistory(projectPath, agentId);
  const nameMap = new Map(
    clubhouseHistory
      .filter((s) => s.friendlyName)
      .map((s) => [s.sessionId, s.friendlyName!])
  );

  // Try to get provider-discovered sessions
  let providerSessions: Array<{ sessionId: string; startedAt: string; lastActiveAt: string }> = [];
  if (isSessionCapable(provider)) {
    try {
      const profileEnv = resolveProfileEnv(projectPath, provider.id);
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
