import * as path from 'path';
import * as fsp from 'fs/promises';
import { getProvider, OrchestratorId, OrchestratorProvider } from '../orchestrators';
import { appLog } from './log-service';

export const DEFAULT_ORCHESTRATOR: OrchestratorId = 'claude-code';

export type AgentRuntime = 'pty' | 'headless' | 'chat';

export interface AgentRegistration {
  projectPath: string;
  /** Worktree path for the agent — where hook/MCP configs are written. */
  cwd?: string;
  orchestrator: OrchestratorId;
  runtime: AgentRuntime;
  nonce?: string;
}

/** Called when an agent's nonce changes or it is untracked. */
export type AgentAuthListener = (agentId: string) => void;

class AgentRegistry {
  private readonly registrations = new Map<string, AgentRegistration>();
  private readonly authListeners = new Set<AgentAuthListener>();

  /** Listen for nonce changes and untracking; returns an unsubscribe. */
  onAuthChange(listener: AgentAuthListener): () => void {
    this.authListeners.add(listener);
    return () => { this.authListeners.delete(listener); };
  }

  private emitAuthChange(agentId: string): void {
    for (const listener of [...this.authListeners]) listener(agentId);
  }

  register(agentId: string, registration: AgentRegistration): void {
    this.registrations.set(agentId, registration);
  }

  get(agentId: string): AgentRegistration | undefined {
    return this.registrations.get(agentId);
  }

  setNonce(agentId: string, nonce: string): void {
    const registration = this.registrations.get(agentId);
    if (!registration) return;
    const changed = registration.nonce !== nonce;
    registration.nonce = nonce;
    if (changed) this.emitAuthChange(agentId);
  }

  setRuntime(agentId: string, runtime: AgentRuntime): void {
    const registration = this.registrations.get(agentId);
    if (!registration) return;
    registration.runtime = runtime;
  }

  untrack(agentId: string): void {
    if (this.registrations.delete(agentId)) this.emitAuthChange(agentId);
  }

  getAllRegistrations(): Map<string, AgentRegistration> {
    return new Map(this.registrations);
  }
}

export const agentRegistry = new AgentRegistry();

export function getAgentProjectPath(agentId: string): string | undefined {
  return agentRegistry.get(agentId)?.projectPath;
}

export function getAgentOrchestrator(agentId: string): OrchestratorId | undefined {
  return agentRegistry.get(agentId)?.orchestrator;
}

export function getAgentNonce(agentId: string): string | undefined {
  return agentRegistry.get(agentId)?.nonce;
}

export function getAgentCwd(agentId: string): string | undefined {
  return agentRegistry.get(agentId)?.cwd;
}

export function untrackAgent(agentId: string): void {
  agentRegistry.untrack(agentId);
}

/** Read the project-level orchestrator setting from .clubhouse/settings.json */
export async function readProjectOrchestrator(projectPath: string): Promise<OrchestratorId | undefined> {
  try {
    const settingsPath = path.join(projectPath, '.clubhouse', 'settings.json');
    const raw = JSON.parse(await fsp.readFile(settingsPath, 'utf-8'));
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
export async function resolveOrchestrator(
  projectPath: string,
  agentOrchestrator?: OrchestratorId
): Promise<OrchestratorProvider> {
  const id = agentOrchestrator
    || await readProjectOrchestrator(projectPath)
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
