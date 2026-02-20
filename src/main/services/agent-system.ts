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
}

export function isHeadlessAgent(agentId: string): boolean {
  return headlessAgentSet.has(agentId) || headlessManager.isHeadless(agentId);
}

export async function spawnAgent(params: SpawnAgentParams): Promise<void> {
  const provider = resolveOrchestrator(params.projectPath, params.orchestrator);

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
      const spawnEnv = { ...headlessResult.env, CLUBHOUSE_AGENT_ID: params.agentId };
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
  await spawnPtyAgent(params, provider, allowedTools);
}

async function spawnPtyAgent(
  params: SpawnAgentParams,
  provider: OrchestratorProvider,
  allowedTools: string[] | undefined,
): Promise<void> {
  const nonce = randomUUID();
  agentNonceMap.set(params.agentId, nonce);

  // Snapshot hooks config before writing so we can restore on exit
  const hookConfigPath = configPipeline.getHooksConfigPath(provider, params.cwd);
  if (hookConfigPath) {
    configPipeline.snapshotFile(params.agentId, hookConfigPath);
  }

  const port = await waitHookServerReady();
  const hookUrl = `http://127.0.0.1:${port}/hook`;
  await provider.writeHooksConfig(params.cwd, hookUrl);

  const { binary, args, env } = await provider.buildSpawnCommand({
    cwd: params.cwd,
    model: params.model,
    mission: params.mission,
    systemPrompt: params.systemPrompt,
    allowedTools,
    agentId: params.agentId,
    freeAgentMode: params.freeAgentMode,
  });

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

  const spawnEnv = { ...env, CLUBHOUSE_AGENT_ID: params.agentId, CLUBHOUSE_HOOK_NONCE: nonce };
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
  return provider.checkAvailability();
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
