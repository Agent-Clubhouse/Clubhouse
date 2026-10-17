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

/** Most shells kept alive at once; the least recently shown one is closed past this. */
export const MAX_TERMINAL_SESSIONS = 8;

export const terminalState = {
  activeTarget: null as TerminalTarget | null,
  targets: [] as TerminalTarget[],
  /** Session ids in the order they were last shown, oldest first. */
  recentSessions: [] as string[],
  listeners: new Set<() => void>(),

  /**
   * Mark `sessionId` as just shown. Returns the sessions that now exceed
   * MAX_TERMINAL_SESSIONS, oldest first, for the caller to close.
   */
  touchSession(sessionId: string): string[] {
    this.recentSessions = [...this.recentSessions.filter((id: string) => id !== sessionId), sessionId];
    const excess = this.recentSessions.length - MAX_TERMINAL_SESSIONS;
    if (excess <= 0) return [];
    const evicted = this.recentSessions.slice(0, excess);
    this.recentSessions = this.recentSessions.slice(excess);
    return evicted;
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
    this.recentSessions = [];
    this.listeners.clear();
  },
};
