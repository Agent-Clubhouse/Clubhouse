import { app } from 'electron';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { appLog } from './log-service';
import { agentRegistry } from './agent-registry';
import * as ptyManager from './pty-manager';
import { getProvider, isSessionCapable } from '../orchestrators';
import { pathExists } from './fs-utils';
import type { AgentKind, RestartSessionEntry, RestartSessionState, LiveAgentInfo, FreeAgentPermissionMode } from '../../shared/types';
import * as freeAgentSettings from './free-agent-settings';
import { isAssistantAgent } from '../../shared/assistant-utils';

const SCHEMA_VERSION = 1;
const STALENESS_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const STATE_FILENAME = 'restart-session-state.json';

function getStatePath(): string {
  return path.join(app.getPath('userData'), STATE_FILENAME);
}

export async function captureSessionState(
  agentNames: Map<string, string>,
  agentMeta?: Map<string, { kind: AgentKind; mission?: string; model?: string; worktreePath?: string; permissionMode?: FreeAgentPermissionMode }>,
): Promise<void> {
  const all = agentRegistry.getAllRegistrations();
  const sessions: RestartSessionEntry[] = [];

  for (const [agentId, reg] of all) {
    if (reg.runtime !== 'pty') continue;
    // Assistant agents are ephemeral — don't persist or resume them
    if (isAssistantAgent(agentId)) continue;

    const provider = getProvider(reg.orchestrator);
    if (!provider) continue;

    let sessionId: string | null = null;
    if (isSessionCapable(provider)) {
      const buffer = ptyManager.getBuffer(agentId);
      sessionId = provider.extractSessionId(buffer);
    }

    const canResume = isSessionCapable(provider);
    const meta = agentMeta?.get(agentId);

    // Capture the permission mode the agent was running with.
    // Prefer per-agent meta (future-proofing), fall back to project-level setting.
    const permissionMode = meta?.permissionMode ?? freeAgentSettings.getPermissionMode(reg.projectPath);

    sessions.push({
      agentId,
      agentName: agentNames.get(agentId) || agentId,
      projectPath: reg.projectPath,
      orchestrator: reg.orchestrator,
      sessionId,
      resumeStrategy: canResume ? 'auto' : 'manual',
      worktreePath: meta?.worktreePath,
      kind: meta?.kind || 'durable',
      mission: meta?.mission,
      model: meta?.model,
      permissionMode,
    });
  }

  const state: RestartSessionState = {
    version: SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    sessions,
  };

  const statePath = getStatePath();
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  await fsp.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
  appLog('update:session-resume', 'info', `Captured ${sessions.length} sessions for resume`, {
    meta: { sessionCount: sessions.length, agentIds: sessions.map((s) => s.agentId) },
  });
}

export async function loadPendingResume(): Promise<RestartSessionState | null> {
  const statePath = getStatePath();

  let raw: string;
  try {
    raw = await fsp.readFile(statePath, 'utf-8');
  } catch {
    return null;
  }

  let state: RestartSessionState;
  try {
    state = JSON.parse(raw);
  } catch {
    appLog('update:session-resume', 'warn', 'Corrupt restart-session-state.json, deleting');
    await silentUnlink(statePath);
    return null;
  }

  if (state.version !== SCHEMA_VERSION) {
    appLog('update:session-resume', 'info', `Schema version mismatch (got ${state.version}, want ${SCHEMA_VERSION}), discarding`);
    await silentUnlink(statePath);
    return null;
  }

  const age = Date.now() - new Date(state.capturedAt).getTime();
  if (age > STALENESS_THRESHOLD_MS) {
    appLog('update:session-resume', 'info', `Restart state too old (${Math.round(age / 3600000)}h), discarding`);
    await silentUnlink(statePath);
    return null;
  }

  // Filter out assistant agents and sessions with missing project directories
  const validSessions: RestartSessionEntry[] = [];
  for (const session of state.sessions) {
    if (isAssistantAgent(session.agentId)) continue;
    const dirExists = await pathExists(session.worktreePath || session.projectPath);
    if (dirExists) {
      validSessions.push(session);
    } else {
      appLog('update:session-resume', 'warn', `Skipping resume for ${session.agentId} — directory missing: ${session.worktreePath || session.projectPath}`);
    }
  }
  state.sessions = validSessions;

  appLog('update:session-resume', 'info', `Loaded ${state.sessions.length} pending resumes`);
  return state;
}

export async function clearPendingResume(): Promise<void> {
  await silentUnlink(getStatePath());
}

async function silentUnlink(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath);
  } catch {
    // File didn't exist — fine
  }
}

export function getLiveAgentsForUpdate(): LiveAgentInfo[] {
  const all = agentRegistry.getAllRegistrations();
  const result: LiveAgentInfo[] = [];
  const now = Date.now();
  const WORKING_THRESHOLD_MS = 5000;

  for (const [agentId, reg] of all) {
    if (reg.runtime !== 'pty') continue;

    const lastActivity = ptyManager.getLastActivity(agentId);
    const isWorking = lastActivity !== null && (now - lastActivity) < WORKING_THRESHOLD_MS;

    result.push({
      agentId,
      projectPath: reg.projectPath,
      orchestrator: reg.orchestrator,
      runtime: reg.runtime,
      isWorking,
      lastActivity,
    });
  }

  return result;
}
