import * as path from 'path';
import * as fs from 'fs';
import { getProvider, getAllProviders, OrchestratorId, OrchestratorProvider, NormalizedHookEvent } from '../orchestrators';
import { waitReady as waitHookServerReady } from './hook-server';
import * as ptyManager from './pty-manager';

const DEFAULT_ORCHESTRATOR: OrchestratorId = 'claude-code';

/** Track agentId → projectPath for hook event normalization */
const agentProjectMap = new Map<string, string>();
/** Track agentId → orchestratorId override */
const agentOrchestratorMap = new Map<string, OrchestratorId>();

export function getAgentProjectPath(agentId: string): string | undefined {
  return agentProjectMap.get(agentId);
}

export function getAgentOrchestrator(agentId: string): OrchestratorId | undefined {
  return agentOrchestratorMap.get(agentId);
}

export function untrackAgent(agentId: string): void {
  agentProjectMap.delete(agentId);
  agentOrchestratorMap.delete(agentId);
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

  // Track the agent so we can resolve the orchestrator for hook events
  agentProjectMap.set(params.agentId, params.projectPath);
  if (params.orchestrator) {
    agentOrchestratorMap.set(params.agentId, params.orchestrator);
  }

  // Set up hooks
  const port = await waitHookServerReady();
  const hookUrl = `http://127.0.0.1:${port}/hook/${params.agentId}`;
  await provider.writeHooksConfig(params.cwd, hookUrl, {
    allowedTools: params.allowedTools,
  });

  // Build the spawn command via the provider
  const { binary, args } = await provider.buildSpawnCommand({
    cwd: params.cwd,
    model: params.model,
    mission: params.mission,
    systemPrompt: params.systemPrompt,
  });

  // Spawn via PTY manager with pre-built shell command
  ptyManager.spawn(params.agentId, params.cwd, binary, args);
}

export async function killAgent(agentId: string, projectPath: string, orchestrator?: OrchestratorId): Promise<void> {
  const provider = resolveOrchestrator(projectPath, orchestrator);
  const exitCmd = provider.getExitCommand();
  ptyManager.gracefulKill(agentId, exitCmd);
}

export function readInstructions(worktreePath: string, projectPath: string, orchestrator?: OrchestratorId): string {
  const provider = resolveOrchestrator(projectPath, orchestrator);
  return provider.readInstructions(worktreePath);
}

export function writeInstructions(worktreePath: string, content: string, projectPath: string, orchestrator?: OrchestratorId): void {
  const provider = resolveOrchestrator(projectPath, orchestrator);
  provider.writeInstructions(worktreePath, content);
}

export function getModelOptions(projectPath: string, orchestrator?: OrchestratorId): Array<{ id: string; label: string }> {
  const provider = resolveOrchestrator(projectPath, orchestrator);
  return provider.getModelOptions();
}

export function getToolVerb(toolName: string, projectPath: string, orchestrator?: OrchestratorId): string {
  const provider = resolveOrchestrator(projectPath, orchestrator);
  return provider.toolVerb(toolName) || `Using ${toolName}`;
}

export function parseHookEvent(
  raw: unknown,
  projectPath: string,
  orchestrator?: OrchestratorId
): NormalizedHookEvent | null {
  const provider = resolveOrchestrator(projectPath, orchestrator);
  return provider.parseHookEvent(raw);
}

export function buildSummaryInstruction(agentId: string, projectPath: string, orchestrator?: OrchestratorId): string {
  const provider = resolveOrchestrator(projectPath, orchestrator);
  return provider.buildSummaryInstruction(agentId);
}

export async function readQuickSummary(
  agentId: string,
  projectPath: string,
  orchestrator?: OrchestratorId
): Promise<{ summary: string | null; filesModified: string[] } | null> {
  const provider = resolveOrchestrator(projectPath, orchestrator);
  return provider.readQuickSummary(agentId);
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

export function getAvailableOrchestrators(): Array<{ id: string; displayName: string }> {
  return getAllProviders().map((p) => ({ id: p.id, displayName: p.displayName }));
}
