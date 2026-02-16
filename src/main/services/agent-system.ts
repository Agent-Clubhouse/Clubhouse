import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { getProvider, getAllProviders, OrchestratorId, OrchestratorProvider } from '../orchestrators';
import { waitReady as waitHookServerReady } from './hook-server';
import * as ptyManager from './pty-manager';
import { appLog } from './log-service';

const DEFAULT_ORCHESTRATOR: OrchestratorId = 'claude-code';

/** Track agentId → projectPath for hook event routing */
const agentProjectMap = new Map<string, string>();
/** Track agentId → orchestratorId override */
const agentOrchestratorMap = new Map<string, OrchestratorId>();
/** Track agentId → hook nonce for authenticating hook events */
const agentNonceMap = new Map<string, string>();

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
}

export async function spawnAgent(params: SpawnAgentParams): Promise<void> {
  const provider = resolveOrchestrator(params.projectPath, params.orchestrator);

  agentProjectMap.set(params.agentId, params.projectPath);
  if (params.orchestrator) {
    agentOrchestratorMap.set(params.agentId, params.orchestrator);
  }

  const nonce = randomUUID();
  agentNonceMap.set(params.agentId, nonce);

  const port = await waitHookServerReady();
  const hookUrl = `http://127.0.0.1:${port}/hook`;
  await provider.writeHooksConfig(params.cwd, hookUrl);

  const allowedTools = params.allowedTools
    || (params.kind === 'quick' ? provider.getDefaultPermissions('quick') : undefined);

  const { binary, args, env } = await provider.buildSpawnCommand({
    cwd: params.cwd,
    model: params.model,
    mission: params.mission,
    systemPrompt: params.systemPrompt,
    allowedTools,
    agentId: params.agentId,
  });

  appLog('core:agent', 'info', `Spawning ${params.kind} agent`, {
    meta: {
      agentId: params.agentId,
      orchestrator: provider.id,
      binary,
      cwd: params.cwd,
      model: params.model,
    },
  });

  const spawnEnv = { ...env, CLUBHOUSE_AGENT_ID: params.agentId, CLUBHOUSE_HOOK_NONCE: nonce };
  ptyManager.spawn(params.agentId, params.cwd, binary, args, spawnEnv);
}

export async function killAgent(agentId: string, projectPath: string, orchestrator?: OrchestratorId): Promise<void> {
  appLog('core:agent', 'info', 'Killing agent', { meta: { agentId } });
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

export function getAvailableOrchestrators(): Array<{ id: string; displayName: string; badge?: string }> {
  return getAllProviders().map((p) => ({ id: p.id, displayName: p.displayName, badge: p.badge }));
}
