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
 * Agent:        `terminal:<projectId>:agent:<name>`
 */
export function makeSessionId(projectId: string, kind: 'project' | 'agent', name?: string): string {
  if (kind === 'agent') {
    return `terminal:${projectId}:agent:${name}`;
  }
  return `terminal:${projectId}:project`;
}

export const terminalState = {
  activeTarget: null as TerminalTarget | null,
  targets: [] as TerminalTarget[],
  listeners: new Set<() => void>(),

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
    this.listeners.clear();
  },
};
