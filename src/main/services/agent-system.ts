import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { getProvider, getAllProviders, OrchestratorId, OrchestratorProvider } from '../orchestrators';
import { waitReady as waitHookServerReady } from './hook-server';
import * as ptyManager from './pty-manager';
import { appLog } from './log-service';
import * as headlessManager from './headless-manager';
import * as headlessSettings from './headless-settings';
import * as clubhouseModeSettings from './clubhouse-mode-settings';
import * as configPipeline from './config-pipeline';
import { getDurableConfig } from './agent-config';
import { materializeAgent } from './materialization-service';
import * as profileSettings from './profile-settings';
import { readProjectAgentDefaults } from './agent-settings-service';

const DEFAULT_ORCHESTRATOR: OrchestratorId = 'claude-code';

/** Track agentId → projectPath for hook event routing */
const agentProjectMap = new Map<string, string>();
/** Track agentId → orchestratorId override */
const agentOrchestratorMap = new Map<string, OrchestratorId>();
/** Track agentId → hook nonce for authenticating hook events */
const agentNonceMap = new Map<string, string>();
/** Track which agents are running in headless mode */
const headlessAgentSet = new Set<string>();

export function getAgentProjectPath(agentId: string): string | undefined {
  return agentProjectMap.get(agentId);
}

export function getAgentOrchestrator(agentId: string): OrchestratorId | undefined {
  return agentOrchestratorMap.get(agentId);
}

export function getAgentNonce(agentId: string): string | undefined {
  return agentNonceMap.get(agentId);
}

export function untrackAgent(agentId: string): void {
  agentProjectMap.delete(agentId);
  agentOrchestratorMap.delete(agentId);
  agentNonceMap.delete(agentId);
  headlessAgentSet.delete(agentId);
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
  return headlessAgentSet.has(agentId) || headlessManager.isHeadless(agentId);
}

export async function spawnAgent(params: SpawnAgentParams): Promise<void> {
  const provider = resolveOrchestrator(params.projectPath, params.orchestrator);

  // Resolve profile env early so it can be passed to checkAvailability.
  // This ensures auth checks (e.g. CLAUDE_CONFIG_DIR) use the correct
  // config directory when a profile is active.
  const profileEnv = resolveProfileEnv(params.projectPath, provider.id);

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

  agentProjectMap.set(params.agentId, params.projectPath);
  if (params.orchestrator) {
    agentOrchestratorMap.set(params.agentId, params.orchestrator);
  }

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

  // Try headless path for quick agents when enabled
  const spawnMode = headlessSettings.getSpawnMode(params.projectPath);
  if (spawnMode === 'headless' && params.kind === 'quick' && provider.buildHeadlessCommand) {
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
      headlessAgentSet.add(params.agentId);
      const spawnEnv = { ...headlessResult.env, ...profileEnv, CLUBHOUSE_AGENT_ID: params.agentId };
      headlessManager.spawnHeadless(
        params.agentId,
        params.cwd,
        headlessResult.binary,
        headlessResult.args,
        spawnEnv,
        headlessResult.outputKind || 'stream-json',
        (exitAgentId) => {
          configPipeline.restoreForAgent(exitAgentId);
        },
      );
      return;
    }
  }

  // Fall back to PTY mode
  await spawnPtyAgent(params, provider, allowedTools, profileEnv);
}

async function spawnPtyAgent(
  params: SpawnAgentParams,
  provider: OrchestratorProvider,
  allowedTools: string[] | undefined,
  profileEnv: Record<string, string> | undefined,
): Promise<void> {
  const nonce = randomUUID();
  agentNonceMap.set(params.agentId, nonce);

  // Snapshot hooks config before writing so we can restore on exit
  const hookConfigPath = configPipeline.getHooksConfigPath(provider, params.cwd);
  if (hookConfigPath) {
    configPipeline.snapshotFile(params.agentId, hookConfigPath);
  }

  // Run hook server setup and command building in parallel — they're independent.
  const [, { binary, args, env }] = await Promise.all([
    waitHookServerReady().then(async (port) => {
      const hookUrl = `http://127.0.0.1:${port}/hook`;
      await provider.writeHooksConfig(params.cwd, hookUrl);
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
    },
  });

  const spawnEnv = { ...env, ...profileEnv, CLUBHOUSE_AGENT_ID: params.agentId, CLUBHOUSE_HOOK_NONCE: nonce };

  if (profileEnv) {
    appLog('core:agent', 'info', 'Profile env injected', {
      meta: { agentId: params.agentId, profileKeys: Object.keys(profileEnv).join(',') },
    });
  }

  ptyManager.spawn(params.agentId, params.cwd, binary, args, spawnEnv, (exitAgentId) => {
    configPipeline.restoreForAgent(exitAgentId);
  });
}

export async function killAgent(agentId: string, projectPath: string, orchestrator?: OrchestratorId): Promise<void> {
  appLog('core:agent', 'info', 'Killing agent', { meta: { agentId } });
  if (headlessAgentSet.has(agentId) || headlessManager.isHeadless(agentId)) {
    headlessManager.kill(agentId);
    headlessAgentSet.delete(agentId);
    return;
  }
  const provider = resolveOrchestrator(projectPath, orchestrator);
  const exitCmd = provider.getExitCommand();
  ptyManager.gracefulKill(agentId, exitCmd);
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
