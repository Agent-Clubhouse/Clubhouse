/**
 * Shared module-level state for the terminal plugin.
 *
 * SidebarPanel and MainPanel are rendered in separate React trees,
 * so we use a lightweight pub/sub to coordinate the active terminal target.
 */

export interface TerminalTarget {
  sessionId: string;
  label: string;
  cwd: string;
  kind: 'project' | 'agent';
}

/**
 * Build a deterministic session ID for a terminal target.
 *
 * Project root: `terminal:<projectId>:project`
 * Agent:        `terminal:<projectId>:agent:<agentId>`
 *
 * Agents are keyed by id, not name, so a renamed agent keeps its shell and a
 * new agent that reuses a name does not inherit someone else's.
 */
export function makeSessionId(projectId: string, kind: 'project' | 'agent', agentId?: string): string {
  if (kind === 'agent') {
    return `terminal:${projectId}:agent:${agentId}`;
  }
  return `terminal:${projectId}:project`;
}

/**
 * Most idle shells kept alive per project. Past this the least recently shown
 * idle one is closed; a shell running a command is never closed for the cap.
 */
export const MAX_TERMINAL_SESSIONS = 8;

export const terminalState = {
  activeTarget: null as TerminalTarget | null,
  targets: [] as TerminalTarget[],
  /** Per project, session ids in the order they were last shown, oldest first. */
  recentSessions: new Map<string, string[]>(),
  listeners: new Set<() => void>(),

  /**
   * Mark `sessionId` as just shown in `projectId`. Returns the project's other
   * sessions, oldest first, when it has more than MAX_TERMINAL_SESSIONS: the
   * candidates for the caller to close (it skips busy ones and calls forgetSession).
   */
  touchSession(projectId: string, sessionId: string): string[] {
    const list = [...(this.recentSessions.get(projectId) ?? []).filter((id: string) => id !== sessionId), sessionId];
    this.recentSessions.set(projectId, list);
    return list.length > MAX_TERMINAL_SESSIONS ? list.slice(0, -1) : [];
  },

  /** How many sessions `projectId` has open. */
  sessionCount(projectId: string): number {
    return this.recentSessions.get(projectId)?.length ?? 0;
  },

  /** Stop tracking a session that was closed. */
  forgetSession(projectId: string, sessionId: string): void {
    const list = this.recentSessions.get(projectId);
    if (list) this.recentSessions.set(projectId, list.filter((id: string) => id !== sessionId));
  },

  setActiveTarget(target: TerminalTarget | null): void {
    this.activeTarget = target;
    this.notify();
  },

  setTargets(targets: TerminalTarget[]): void {
    this.targets = targets;
    this.notify();
  },

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  },

  notify(): void {
    for (const fn of this.listeners) {
      fn();
    }
  },

  reset(): void {
    this.activeTarget = null;
    this.targets = [];
    this.recentSessions = new Map();
    this.listeners.clear();
  },
};
