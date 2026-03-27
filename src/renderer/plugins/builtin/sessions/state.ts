/**
 * Shared module-level state for the sessions plugin.
 *
 * SidebarPanel and MainPanel are rendered in separate React trees,
 * so we use a lightweight pub/sub to coordinate selection and playback.
 */

export interface SelectedAgent {
  agentId: string;
  agentName: string;
  kind: 'durable' | 'quick' | 'companion';
  orchestrator?: string;
}

export interface PlaybackState {
  playing: boolean;
  speed: 1 | 3 | 5;
  currentEventIndex: number;
}

export interface SessionListEntry {
  sessionId: string;
  startedAt: string;
  lastActiveAt: string;
  friendlyName?: string;
}

export const sessionsState = {
  selectedAgent: null as SelectedAgent | null,
  selectedSessionId: null as string | null,
  expandedAgents: new Set<string>(),
  playback: { playing: false, speed: 1, currentEventIndex: 0 } as PlaybackState,

  /** Session lists keyed by agentId — persists across SidebarPanel unmount/remount */
  sessionLists: {} as Record<string, SessionListEntry[]>,
  /** Which agents are currently loading sessions */
  loadingAgents: new Set<string>(),
  /** Which agents have already been fetched (prevents duplicate requests) */
  fetchedAgents: new Set<string>(),

  listeners: new Set<() => void>(),

  setSelectedAgent(agent: SelectedAgent | null): void {
    this.selectedAgent = agent;
    this.notify();
  },

  setSelectedSession(sessionId: string | null): void {
    this.selectedSessionId = sessionId;
    // Reset playback when switching sessions
    this.playback = { playing: false, speed: 1, currentEventIndex: 0 };
    this.notify();
  },

  toggleExpandedAgent(agentId: string): void {
    const next = new Set(this.expandedAgents);
    if (next.has(agentId)) {
      next.delete(agentId);
    } else {
      next.add(agentId);
    }
    this.expandedAgents = next;
    this.notify();
  },

  setSessionList(agentId: string, sessions: SessionListEntry[]): void {
    this.sessionLists = { ...this.sessionLists, [agentId]: sessions };
    this.notify();
  },

  setLoadingAgent(agentId: string, loading: boolean): void {
    const next = new Set(this.loadingAgents);
    if (loading) {
      next.add(agentId);
    } else {
      next.delete(agentId);
    }
    this.loadingAgents = next;
    this.notify();
  },

  markFetched(agentId: string): void {
    this.fetchedAgents = new Set(this.fetchedAgents).add(agentId);
    // No notify needed — this is internal bookkeeping
  },

  setPlaybackPlaying(playing: boolean): void {
    this.playback = { ...this.playback, playing };
    this.notify();
  },

  setPlaybackSpeed(speed: 1 | 3 | 5): void {
    this.playback = { ...this.playback, speed };
    this.notify();
  },

  setPlaybackIndex(index: number): void {
    this.playback = { ...this.playback, currentEventIndex: index };
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
    this.selectedAgent = null;
    this.selectedSessionId = null;
    this.expandedAgents = new Set();
    this.playback = { playing: false, speed: 1, currentEventIndex: 0 };
    this.sessionLists = {};
    this.loadingAgents = new Set();
    this.fetchedAgents = new Set();
    this.listeners.clear();
  },
};
