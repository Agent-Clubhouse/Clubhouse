import * as path from 'path';
import * as fsp from 'fs/promises';
import { getProvider, OrchestratorId, OrchestratorProvider } from '../orchestrators';
import { appLog } from './log-service';
import type { FreeAgentPermissionMode } from '../../shared/types';
import { ACCESS_LEVELS, accessLevelOf, launchAccessFor } from '../../shared/orchestration-policy';
import { setOrchestrationEnabled } from './clubhouse-mcp/orchestration-gate';
import { setDispatcherAgent } from './clubhouse-mcp/dispatcher-gate';

export const DEFAULT_ORCHESTRATOR: OrchestratorId = 'claude-code';

export type AgentRuntime = 'pty' | 'headless' | 'chat';

export interface AgentRegistration {
  projectPath: string;
  /** Worktree path for the agent — where hook/MCP configs are written. */
  cwd?: string;
  orchestrator: OrchestratorId;
  runtime: AgentRuntime;
  nonce?: string;
  /**
   * What the agent runs with now (#2228): Free Agent Mode plus the resolved
   * permission mode, the ceiling for its helpers. Unset means unknown, which
   * reads as standard access. Written only through setLaunchCap,
   * setUserLaunchAccess and reportLaunchAccess.
   */
  launchAccess?: LaunchAccess;
  /** What the agent was spawned with (#2228). Set once per registration and never raised. */
  launchCap?: Readonly<LaunchAccess>;
  /** The last level the user set in chat (#2228); the only thing that may lift the record above `launchCap`. */
  userAccess?: Readonly<LaunchAccess>;
}

export interface LaunchAccess {
  freeAgentMode: boolean;
  permissionMode?: FreeAgentPermissionMode;
}

function rankOf(access: LaunchAccess | undefined): number {
  return ACCESS_LEVELS.indexOf(accessLevelOf(access));
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

  /**
   * The spawn-time launch access (#2228): the cap, and the starting record.
   * Set once per registration; a later call is ignored, so nothing the agent
   * does after spawn can lift its cap.
   */
  setLaunchCap(agentId: string, access: LaunchAccess): void {
    const registration = this.registrations.get(agentId);
    if (!registration || registration.launchCap) return;
    registration.launchCap = Object.freeze({ ...access });
    registration.launchAccess = { ...access };
  }

  /**
   * A level the user chose (chat setLevel), which may lift the record above
   * the spawn cap. `undefined` forgets it (a new session starts at the spawn
   * level again).
   */
  setUserLaunchAccess(agentId: string, access: LaunchAccess | undefined): void {
    const registration = this.registrations.get(agentId);
    if (!registration) return;
    registration.userAccess = access ? Object.freeze({ ...access }) : undefined;
    if (access) registration.launchAccess = { ...access };
  }

  /**
   * A level the agent or its CLI reported (hook payload, driver mode event).
   * Recorded as reported when it's at or below max(spawn cap, the user's
   * last level), else clamped to that bound: a report can lower the record
   * or restore it, never lift it on the agent's own word.
   */
  reportLaunchAccess(agentId: string, access: LaunchAccess): void {
    const registration = this.registrations.get(agentId);
    if (!registration) return;
    const bound = Math.max(rankOf(registration.launchCap), rankOf(registration.userAccess));
    registration.launchAccess = rankOf(access) <= bound ? { ...access } : launchAccessFor(ACCESS_LEVELS[bound]);
  }

  untrack(agentId: string): void {
    if (!this.registrations.delete(agentId)) return;
    // A gone agent keeps no orchestration tools (#2228); the next spawn re-syncs.
    setOrchestrationEnabled(agentId, false);
    setDispatcherAgent(agentId, false);
    this.emitAuthChange(agentId);
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
