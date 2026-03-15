import * as path from 'path';
import * as fsp from 'fs/promises';
import { getProvider, OrchestratorId, OrchestratorProvider } from '../orchestrators';
import { appLog } from './log-service';

export const DEFAULT_ORCHESTRATOR: OrchestratorId = 'claude-code';

export type AgentRuntime = 'pty' | 'headless' | 'structured';

export interface AgentRegistration {
  projectPath: string;
  orchestrator: OrchestratorId;
  runtime: AgentRuntime;
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

  setRuntime(agentId: string, runtime: AgentRuntime): void {
    const registration = this.registrations.get(agentId);
    if (!registration) return;
    registration.runtime = runtime;
  }

  untrack(agentId: string): void {
    this.registrations.delete(agentId);
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
