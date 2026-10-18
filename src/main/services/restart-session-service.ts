import { app } from 'electron';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { appLog } from './log-service';
import { agentRegistry } from './agent-registry';
import * as ptyManager from './pty-manager';
import * as headlessManager from './headless-manager';
import { getAgentRuntime } from './agent-runtime';
import { getProvider, isSessionCapable, supportsAutoResumeAfterUpdate } from '../orchestrators';
import { pathExists } from './fs-utils';
import type { AgentKind, RestartSessionEntry, RestartSessionState, LiveAgentInfo, FreeAgentPermissionMode, ResumeStrategy } from '../../shared/types';
import * as freeAgentSettings from './free-agent-settings';
import { getDurableConfig } from './agent-config';
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
    if (reg.runtime !== 'pty' && reg.runtime !== 'chat') continue;
    const provider = getProvider(reg.orchestrator);
    if (!provider) continue;

    const meta0 = agentMeta?.get(agentId);
    const cwd = meta0?.worktreePath || reg.projectPath;

    let sessionId: string | null = null;
    // Whether the agent ever started a CLI session (#2074): true with an id,
    // false when we know there is none (resume would have nothing to continue,
    // so the agent is spawned fresh with its mission), undefined when we can't tell.
    let sessionStarted: boolean | undefined;
    const runtime = getAgentRuntime(agentId);
    if (runtime?.kind === 'chat') {
      // Chat runtimes know their native session id exactly; resume re-enters chat.
      sessionId = runtime.getNativeSessionId() ?? null;
      // No id yet means the session never initialized
      sessionStarted = sessionId !== null;
    } else if (isSessionCapable(provider)) {
      // Preferred: scrape the id the CLI printed into its own terminal.
      const buffer = ptyManager.getBuffer(agentId);
      sessionId = provider.extractSessionId(buffer);

      // Fallback: ask the provider what it has on disk for this directory.
      // Not every CLI prints an id — Codex's TUI doesn't — and without one the
      // resume degrades to "most recent session here", which picks the wrong
      // conversation whenever two agents share a working directory (any agent
      // with worktrees disabled). The newest recorded session for this cwd is
      // this agent's, because it is the one that was just running in it.
      if (!sessionId) {
        try {
          const [newest] = await provider.listSessions(cwd);
          if (newest) sessionId = newest.sessionId;
          // Nothing on disk for this directory while it was running: it never started one
          else sessionStarted = false;
        } catch (err) {
          appLog('update:session-resume', 'warn', 'Session lookup failed; will resume the most recent session', {
            meta: { agentId, cwd, error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
    }

    const canResume = resumeStrategyFor(reg.orchestrator) === 'auto';
    const meta = meta0;

    // Capture the permission mode the agent was running with.
    // Prefer per-agent meta (future-proofing), fall back to project-level setting.
    const permissionMode = meta?.permissionMode ?? freeAgentSettings.getPermissionMode(reg.projectPath);

    // Capture freeAgentMode from the durable config so it can be restored
    // during resume without relying solely on the main-process fallback.
    let freeAgentMode: boolean | undefined;
    try {
      const config = await getDurableConfig(reg.projectPath, agentId);
      freeAgentMode = config?.freeAgentMode;
    } catch {
      // Config unavailable — omit freeAgentMode from the entry
    }

    sessions.push({
      agentId,
      agentName: agentNames.get(agentId) || agentId,
      projectPath: reg.projectPath,
      orchestrator: reg.orchestrator,
      sessionId,
      sessionStarted: sessionId ? true : sessionStarted,
      resumeStrategy: canResume ? 'auto' : 'manual',
      worktreePath: meta?.worktreePath,
      kind: meta?.kind || 'durable',
      // For display after the restart only. The resume queue must not send it
      // to the resumed CLI, which would run it again as a new turn (#2074).
      mission: meta?.mission,
      model: meta?.model,
      permissionMode,
      freeAgentMode,
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

/**
 * Whether an agent can be brought back automatically after an update restart.
 *
 * Session resume is a provider capability, not a property of one orchestrator:
 * an agent is auto-resumable exactly when its provider can enumerate and resume
 * sessions.  Both the pre-restart badge and the capture path read this, so the
 * two can't drift — they previously did, with the badge hardcoded to Claude
 * Code while the capture already marked Codex auto.
 */
function resumeStrategyFor(orchestrator: string): ResumeStrategy {
  const provider = getProvider(orchestrator);
  if (!provider) return 'manual';
  return supportsAutoResumeAfterUpdate(provider) ? 'auto' : 'manual';
}

/** Chat states with a turn in progress. */
const CHAT_WORKING_STATES = new Set(['running', 'waiting_permission', 'waiting_input']);

/**
 * Every live agent the update restart stops (#2053): terminals, chat sessions
 * and headless runs. Chat agents resume like terminals; a headless run ends
 * with the restart and isn't resumed.
 */
export function getLiveAgentsForUpdate(): LiveAgentInfo[] {
  const all = agentRegistry.getAllRegistrations();
  const result: LiveAgentInfo[] = [];
  const now = Date.now();
  const WORKING_THRESHOLD_MS = 5000;

  for (const [agentId, reg] of all) {
    const base = { agentId, projectPath: reg.projectPath, orchestrator: reg.orchestrator, runtime: reg.runtime };
    if (reg.runtime === 'pty') {
      const lastActivity = ptyManager.getLastActivity(agentId);
      const isWorking = lastActivity !== null && (now - lastActivity) < WORKING_THRESHOLD_MS;
      result.push({ ...base, isWorking, lastActivity, resumeStrategy: resumeStrategyFor(reg.orchestrator) });
    } else if (reg.runtime === 'chat') {
      const runtime = getAgentRuntime(agentId);
      if (!runtime?.isRunning()) continue;
      result.push({ ...base, isWorking: CHAT_WORKING_STATES.has(runtime.getState()), lastActivity: null, resumeStrategy: resumeStrategyFor(reg.orchestrator) });
    } else if (reg.runtime === 'headless') {
      if (!headlessManager.isHeadless(agentId)) continue;
      result.push({ ...base, isWorking: true, lastActivity: null, resumeStrategy: 'manual' });
    }
  }

  return result;
}
