import React, { useEffect, useState, useCallback, useRef, useSyncExternalStore } from 'react';
import type { PluginContext, PluginAPI, PluginModule, AgentInfo, CompletedQuickAgentInfo } from '../../../../shared/plugin-types';
import type { SessionEvent, SessionSummary } from '../../../../shared/session-types';
import { sessionsState } from './state';
import type { PlaybackState } from './state';

// ── Lifecycle ──────────────────────────────────────────────────────────

export function activate(_ctx: PluginContext, _api: PluginAPI): void {
  // No commands to register yet — reserved for future "replay session" command
}

export function deactivate(): void {
  sessionsState.reset();
}

// ── Shared hook ────────────────────────────────────────────────────────

function useSessionsState() {
  const subscribe = useCallback((cb: () => void) => sessionsState.subscribe(cb), []);
  const getSelectedAgent = useCallback(() => sessionsState.selectedAgent, []);
  const getSelectedSessionId = useCallback(() => sessionsState.selectedSessionId, []);
  const getExpandedAgents = useCallback(() => sessionsState.expandedAgents, []);
  const getPlayback = useCallback(() => sessionsState.playback, []);

  const selectedAgent = useSyncExternalStore(subscribe, getSelectedAgent);
  const selectedSessionId = useSyncExternalStore(subscribe, getSelectedSessionId);
  const expandedAgents = useSyncExternalStore(subscribe, getExpandedAgents);
  const playback = useSyncExternalStore(subscribe, getPlayback);

  return { selectedAgent, selectedSessionId, expandedAgents, playback };
}

// ── Utilities ──────────────────────────────────────────────────────────

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString();
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ── Sidebar Panel ──────────────────────────────────────────────────────

interface SessionListEntry {
  sessionId: string;
  startedAt: string;
  lastActiveAt: string;
  friendlyName?: string;
}

export function SidebarPanel({ api }: { api: PluginAPI }) {
  const { selectedAgent, selectedSessionId, expandedAgents } = useSessionsState();
  const [durableAgents, setDurableAgents] = useState<AgentInfo[]>([]);
  const [completedAgents, setCompletedAgents] = useState<CompletedQuickAgentInfo[]>([]);
  const [sessionLists, setSessionLists] = useState<Record<string, SessionListEntry[]>>({});
  const [loadingAgents, setLoadingAgents] = useState<Set<string>>(new Set());

  const refreshAgents = useCallback(() => {
    const all = api.agents.list();
    setDurableAgents(all.filter((a) => a.kind === 'durable'));
    setCompletedAgents(api.agents.listCompleted());
  }, [api]);

  useEffect(() => {
    refreshAgents();
    const sub = api.agents.onAnyChange(refreshAgents);
    return () => sub.dispose();
  }, [api, refreshAgents]);

  // Load sessions when an agent is expanded
  const loadSessions = useCallback(async (agentId: string) => {
    if (sessionLists[agentId]) return; // Already loaded
    setLoadingAgents((prev) => new Set(prev).add(agentId));
    try {
      const sessions = await api.agents.listSessions(agentId);
      setSessionLists((prev) => ({ ...prev, [agentId]: sessions }));
    } catch {
      setSessionLists((prev) => ({ ...prev, [agentId]: [] }));
    }
    setLoadingAgents((prev) => {
      const next = new Set(prev);
      next.delete(agentId);
      return next;
    });
  }, [api, sessionLists]);

  const handleAgentClick = useCallback((agent: AgentInfo) => {
    sessionsState.toggleExpandedAgent(agent.id);
    if (!expandedAgents.has(agent.id)) {
      sessionsState.setSelectedAgent({
        agentId: agent.id,
        agentName: agent.name,
        kind: agent.kind,
        orchestrator: agent.orchestrator,
      });
      loadSessions(agent.id);
    }
  }, [expandedAgents, loadSessions]);

  const handleSessionClick = useCallback((agent: AgentInfo, session: SessionListEntry) => {
    sessionsState.setSelectedAgent({
      agentId: agent.id,
      agentName: agent.name,
      kind: agent.kind,
      orchestrator: agent.orchestrator,
    });
    sessionsState.setSelectedSession(session.sessionId);
  }, []);

  const handleCompletedClick = useCallback((completed: CompletedQuickAgentInfo) => {
    sessionsState.setSelectedAgent({
      agentId: completed.id,
      agentName: completed.name,
      kind: 'quick',
    });
    sessionsState.setSelectedSession(null);
  }, []);

  return React.createElement('div', {
    className: 'flex flex-col h-full bg-ctp-mantle',
    'data-testid': 'sessions-sidebar-panel',
  },
    // Header
    React.createElement('div', {
      className: 'px-3 py-2 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider border-b border-ctp-surface0',
    }, 'Agents'),

    // Scrollable list
    React.createElement('div', { className: 'flex-1 overflow-y-auto py-1' },

      // Durable agents
      durableAgents.map((agent) => React.createElement(React.Fragment, { key: agent.id },
        // Agent row
        React.createElement('button', {
          className: `w-full text-left px-3 py-2.5 text-sm cursor-pointer transition-colors ${
            selectedAgent?.agentId === agent.id
              ? 'bg-surface-1 text-ctp-text font-medium'
              : 'text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text'
          }`,
          onClick: () => handleAgentClick(agent),
        },
          React.createElement('div', { className: 'flex items-center gap-2' },
            React.createElement('span', {
              className: 'w-2 h-2 rounded-full flex-shrink-0',
              style: { backgroundColor: agent.color || '#89b4fa' },
            }),
            React.createElement('span', { className: 'truncate flex-1' }, agent.name),
            React.createElement('span', {
              className: 'text-[10px] text-ctp-overlay0 flex-shrink-0 transition-transform',
              style: { transform: expandedAgents.has(agent.id) ? 'rotate(90deg)' : 'none' },
            }, '\u25B8'),
          ),
        ),

        // Session list (expanded)
        expandedAgents.has(agent.id) && React.createElement('div', {
          className: 'pl-7 bg-ctp-crust',
        },
          loadingAgents.has(agent.id)
            ? React.createElement('div', {
              className: 'py-2 text-xs text-ctp-overlay0',
            }, 'Loading...')
            : (sessionLists[agent.id] || []).length === 0
              ? React.createElement('div', {
                className: 'py-2 text-xs text-ctp-overlay0',
              }, 'No sessions')
              : (sessionLists[agent.id] || []).map((session, idx) => React.createElement('button', {
                  key: session.sessionId,
                  className: `w-full text-left px-2 py-1.5 text-xs cursor-pointer transition-colors ${
                    selectedSessionId === session.sessionId
                      ? 'bg-surface-1 text-ctp-text'
                      : 'text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text'
                  }`,
                  onClick: () => handleSessionClick(agent, session),
                },
                  React.createElement('div', { className: 'flex items-center justify-between gap-1' },
                    React.createElement('span', { className: 'truncate' },
                      session.friendlyName || `Session ${session.sessionId.slice(0, 8)}...`
                    ),
                    React.createElement('span', { className: 'text-[10px] text-ctp-overlay0 flex-shrink-0' },
                      formatRelativeTime(session.lastActiveAt),
                    ),
                  ),
                  idx === 0 && React.createElement('span', {
                    className: 'text-[9px] text-ctp-info',
                  }, 'latest'),
                ),
              ),
        ),
      )),

      // Divider + completed agents
      completedAgents.length > 0 && React.createElement(React.Fragment, null,
        React.createElement('div', {
          className: 'mx-3 my-2 border-t border-ctp-surface0',
        }),
        React.createElement('div', {
          className: 'px-3 py-1 text-[10px] text-ctp-subtext0 uppercase tracking-wider',
        }, 'Completed'),
        completedAgents.map((completed) => React.createElement('button', {
          key: completed.id,
          className: `w-full text-left px-3 py-2 text-sm cursor-pointer transition-colors ${
            selectedAgent?.agentId === completed.id
              ? 'bg-surface-1 text-ctp-text'
              : 'text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text'
          }`,
          onClick: () => handleCompletedClick(completed),
        },
          React.createElement('div', { className: 'flex items-center justify-between gap-2' },
            React.createElement('span', { className: 'truncate' }, completed.name),
            React.createElement('span', { className: 'text-[10px] text-ctp-overlay0 flex-shrink-0' },
              formatRelativeTime(new Date(completed.completedAt).toISOString()),
            ),
          ),
        )),
      ),
    ),
  );
}

// ── Main Panel ──────────────────────────────────────────────────────────

const PAGE_SIZE = 100;

export function MainPanel({ api }: { api: PluginAPI }) {
  const { selectedAgent, selectedSessionId, playback } = useSessionsState();
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [totalEvents, setTotalEvents] = useState(0);
  const [loading, setLoading] = useState(false);
  const eventListRef = useRef<HTMLDivElement>(null);
  const playbackTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load session data when selection changes
  useEffect(() => {
    if (!selectedAgent || !selectedSessionId) {
      setSummary(null);
      setEvents([]);
      setTotalEvents(0);
      return;
    }

    let cancelled = false;
    setLoading(true);

    Promise.all([
      api.agents.getSessionSummary(selectedAgent.agentId, selectedSessionId),
      api.agents.readSessionTranscript(selectedAgent.agentId, selectedSessionId, 0, PAGE_SIZE),
    ]).then(([summaryResult, pageResult]) => {
      if (cancelled) return;
      setSummary(summaryResult);
      if (pageResult) {
        setEvents(pageResult.events);
        setTotalEvents(pageResult.totalEvents);
      } else {
        setEvents([]);
        setTotalEvents(0);
      }
      setLoading(false);
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [api, selectedAgent?.agentId, selectedSessionId]);

  // Load more events (pagination)
  const loadMore = useCallback(async () => {
    if (!selectedAgent || !selectedSessionId || events.length >= totalEvents) return;
    const page = await api.agents.readSessionTranscript(
      selectedAgent.agentId,
      selectedSessionId,
      events.length,
      PAGE_SIZE,
    );
    if (page) {
      setEvents((prev) => [...prev, ...page.events]);
    }
  }, [api, selectedAgent, selectedSessionId, events.length, totalEvents]);

  // Playback timer
  useEffect(() => {
    if (playbackTimerRef.current) {
      clearInterval(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }

    if (!playback.playing || events.length === 0) return;

    const currentIndex = playback.currentEventIndex;
    if (currentIndex >= events.length - 1) {
      sessionsState.setPlaybackPlaying(false);
      return;
    }

    // Calculate delay from real timestamp gaps, capped at 5s
    const nextIndex = currentIndex + 1;
    const gap = Math.min(
      events[nextIndex].timestamp - events[currentIndex].timestamp,
      5000,
    );
    const delay = Math.max(gap / playback.speed, 100); // minimum 100ms

    playbackTimerRef.current = setInterval(() => {
      const state = sessionsState.playback;
      const next = state.currentEventIndex + 1;
      if (next >= events.length) {
        sessionsState.setPlaybackPlaying(false);
      } else {
        sessionsState.setPlaybackIndex(next);
      }
    }, delay);

    return () => {
      if (playbackTimerRef.current) clearInterval(playbackTimerRef.current);
    };
  }, [playback.playing, playback.currentEventIndex, playback.speed, events]);

  // Auto-scroll to current event during playback
  useEffect(() => {
    if (!playback.playing) return;
    const el = eventListRef.current;
    if (!el) return;
    const item = el.querySelector(`[data-event-index="${playback.currentEventIndex}"]`);
    if (item) item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [playback.currentEventIndex, playback.playing]);

  // No selection state
  if (!selectedAgent || !selectedSessionId) {
    return React.createElement('div', {
      className: 'flex items-center justify-center h-full text-ctp-subtext0 text-sm',
      'data-testid': 'sessions-main-panel',
    },
      React.createElement('div', { className: 'text-center' },
        React.createElement('div', { className: 'text-lg mb-2' }, '\u23F0'),
        React.createElement('div', null, 'Select an agent and session to view details'),
      ),
    );
  }

  if (loading) {
    return React.createElement('div', {
      className: 'flex items-center justify-center h-full text-ctp-subtext0 text-sm',
      'data-testid': 'sessions-main-panel',
    }, 'Loading session...');
  }

  const sessionLabel = selectedSessionId.slice(0, 8);

  return React.createElement('div', {
    className: 'flex flex-col h-full bg-ctp-base',
    'data-testid': 'sessions-main-panel',
  },
    // Header
    React.createElement('div', {
      className: 'flex items-center px-3 py-1.5 border-b border-ctp-surface0 bg-ctp-mantle flex-shrink-0',
    },
      React.createElement('span', { className: 'text-xs font-medium text-ctp-text' },
        `Session \u2014 ${selectedAgent.agentName} \u2014 ${sessionLabel}`,
      ),
    ),

    // Scrollable content
    React.createElement('div', { className: 'flex-1 overflow-y-auto' },

      // Summary card
      summary && React.createElement(SessionSummaryCard, { summary }),

      // Timeline + controls
      events.length > 0 && React.createElement(TimelineSection, {
        events,
        playback,
      }),

      // Event list
      React.createElement(EventList, {
        events,
        totalEvents,
        playback,
        onLoadMore: loadMore,
        listRef: eventListRef,
      }),
    ),
  );
}

// ── Summary Card ────────────────────────────────────────────────────────

function SessionSummaryCard({ summary }: { summary: SessionSummary }) {
  const [filesExpanded, setFilesExpanded] = useState(false);

  return React.createElement('div', {
    className: 'mx-3 my-2 p-3 rounded-lg bg-ctp-mantle border border-ctp-surface0',
    'data-testid': 'session-summary-card',
  },
    // Summary text
    summary.summary && React.createElement('div', {
      className: 'text-xs text-ctp-subtext1 mb-3 line-clamp-3',
    }, summary.summary),

    // Stats grid
    React.createElement('div', { className: 'grid grid-cols-3 gap-2 text-center' },
      StatBadge('Duration', formatDuration(summary.totalDurationMs)),
      StatBadge('Tool Calls', String(summary.totalToolCalls)),
      StatBadge('Files', String(summary.filesModified.length)),
      StatBadge('Tokens In', formatTokens(summary.totalInputTokens)),
      StatBadge('Tokens Out', formatTokens(summary.totalOutputTokens)),
      StatBadge('Cost', formatCost(summary.totalCostUsd)),
    ),

    // Additional info row
    React.createElement('div', {
      className: 'flex items-center gap-3 mt-2 pt-2 border-t border-ctp-surface0 text-[10px] text-ctp-overlay0',
    },
      summary.model && React.createElement('span', null, `Model: ${summary.model}`),
      summary.orchestrator && React.createElement('span', null, `Provider: ${summary.orchestrator}`),
      React.createElement('span', null, `${summary.eventCount} events`),
    ),

    // Expandable file list
    summary.filesModified.length > 0 && React.createElement('div', { className: 'mt-2' },
      React.createElement('button', {
        className: 'text-[10px] text-ctp-info hover:underline cursor-pointer',
        onClick: () => setFilesExpanded(!filesExpanded),
      }, filesExpanded ? 'Hide files' : `Show ${summary.filesModified.length} modified files`),
      filesExpanded && React.createElement('div', { className: 'mt-1 text-[10px] text-ctp-subtext0 space-y-0.5' },
        summary.filesModified.map((f) => React.createElement('div', {
          key: f,
          className: 'truncate',
          title: f,
        }, f)),
      ),
    ),
  );
}

function StatBadge(label: string, value: string) {
  return React.createElement('div', {
    key: label,
    className: 'px-2 py-1.5 rounded bg-ctp-crust',
  },
    React.createElement('div', { className: 'text-xs font-medium text-ctp-text' }, value),
    React.createElement('div', { className: 'text-[10px] text-ctp-overlay0' }, label),
  );
}

// ── Timeline + Playback Controls ────────────────────────────────────────

function TimelineSection({ events, playback }: {
  events: SessionEvent[];
  playback: PlaybackState;
}) {
  const timelineRef = useRef<HTMLDivElement>(null);

  const handleTimelineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = timelineRef.current;
    if (!el || events.length === 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const index = Math.round(ratio * (events.length - 1));
    sessionsState.setPlaybackIndex(index);
  }, [events.length]);

  const thumbPosition = events.length > 1
    ? (playback.currentEventIndex / (events.length - 1)) * 100
    : 0;

  // Time labels
  const currentEvent = events[playback.currentEventIndex];
  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];
  const currentOffset = currentEvent && firstEvent
    ? formatDuration(currentEvent.timestamp - firstEvent.timestamp)
    : '0s';
  const totalDuration = firstEvent && lastEvent
    ? formatDuration(lastEvent.timestamp - firstEvent.timestamp)
    : '0s';

  return React.createElement('div', {
    className: 'mx-3 my-2',
    'data-testid': 'session-timeline',
  },
    // Playback controls
    React.createElement('div', { className: 'flex items-center gap-2 mb-2' },
      // Play/Pause
      React.createElement('button', {
        className: 'w-6 h-6 flex items-center justify-center rounded bg-ctp-surface0 hover:bg-ctp-surface1 text-ctp-text cursor-pointer transition-colors',
        onClick: () => sessionsState.setPlaybackPlaying(!playback.playing),
        'data-testid': 'playback-toggle',
      }, playback.playing ? '\u275A\u275A' : '\u25B6'),

      // Speed buttons
      ([1, 3, 5] as const).map((speed) =>
        React.createElement('button', {
          key: speed,
          className: `px-1.5 py-0.5 text-[10px] rounded cursor-pointer transition-colors ${
            playback.speed === speed
              ? 'bg-ctp-blue text-ctp-base font-medium'
              : 'bg-ctp-surface0 text-ctp-subtext0 hover:bg-ctp-surface1'
          }`,
          onClick: () => sessionsState.setPlaybackSpeed(speed),
        }, `${speed}x`),
      ),

      // Time display
      React.createElement('span', {
        className: 'ml-auto text-[10px] text-ctp-overlay0',
      }, `${currentOffset} / ${totalDuration}`),
    ),

    // Timeline bar
    React.createElement('div', {
      ref: timelineRef,
      className: 'relative h-4 bg-ctp-crust rounded cursor-pointer',
      onClick: handleTimelineClick,
    },
      // Event markers
      events.map((event, idx) => {
        const left = events.length > 1
          ? (idx / (events.length - 1)) * 100
          : 50;
        const color = event.type === 'tool_use' ? '#fab387' // peach
          : event.type === 'assistant_message' ? '#89b4fa' // blue
          : event.type === 'user_message' ? '#a6e3a1' // green
          : event.type === 'result' ? '#cba6f7' // mauve
          : '#585b70'; // surface2
        return React.createElement('div', {
          key: event.id,
          className: 'absolute top-1 w-1 h-2 rounded-full',
          style: { left: `${left}%`, backgroundColor: color },
        });
      }),

      // Thumb
      React.createElement('div', {
        className: 'absolute top-0 w-2 h-4 bg-ctp-text rounded',
        style: { left: `calc(${thumbPosition}% - 4px)` },
      }),
    ),
  );
}

// ── Event List ──────────────────────────────────────────────────────────

const EVENT_TYPE_ICONS: Record<string, string> = {
  tool_use: '\uD83D\uDD27',       // wrench
  tool_result: '\uD83D\uDCCB',    // clipboard
  assistant_message: '\uD83D\uDCAC', // chat
  user_message: '\uD83D\uDC64',   // user
  result: '\u2705',               // check
  system: '\u2699\uFE0F',         // gear
};

function EventList({ events, totalEvents, playback, onLoadMore, listRef }: {
  events: SessionEvent[];
  totalEvents: number;
  playback: PlaybackState;
  onLoadMore: () => void;
  listRef: React.RefObject<HTMLDivElement | null>;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Intersection observer for lazy loading
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore();
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onLoadMore]);

  if (events.length === 0) {
    return React.createElement('div', {
      className: 'px-3 py-4 text-xs text-ctp-overlay0 text-center',
    }, 'No events in this session');
  }

  const firstTimestamp = events[0].timestamp;

  return React.createElement('div', {
    ref: listRef,
    className: 'px-3 py-2',
    'data-testid': 'session-event-list',
  },
    React.createElement('div', {
      className: 'text-[10px] text-ctp-subtext0 mb-1 uppercase tracking-wider',
    }, `Events (${events.length}${events.length < totalEvents ? ` of ${totalEvents}` : ''})`),

    events.map((event, idx) => {
      const isActive = idx === playback.currentEventIndex;
      const offset = formatDuration(event.timestamp - firstTimestamp);
      const icon = EVENT_TYPE_ICONS[event.type] || '\u2022';
      const label = event.type === 'tool_use'
        ? event.toolName || 'tool'
        : event.type === 'assistant_message'
          ? (event.text ? event.text.slice(0, 80) + (event.text.length > 80 ? '...' : '') : 'response')
          : event.type === 'user_message'
            ? (event.text ? event.text.slice(0, 80) + (event.text.length > 80 ? '...' : '') : 'message')
            : event.type === 'result'
              ? 'Result'
              : event.type;

      return React.createElement('button', {
        key: event.id,
        'data-event-index': idx,
        className: `w-full text-left px-2 py-1.5 text-xs rounded cursor-pointer transition-colors mb-0.5 ${
          isActive
            ? 'bg-surface-1 border-l-2 border-ctp-blue'
            : 'hover:bg-surface-0'
        }`,
        onClick: () => sessionsState.setPlaybackIndex(idx),
      },
        React.createElement('div', { className: 'flex items-center gap-2' },
          React.createElement('span', { className: 'flex-shrink-0 text-[10px]' }, icon),
          React.createElement('span', {
            className: `flex-1 truncate ${isActive ? 'text-ctp-text' : 'text-ctp-subtext1'}`,
          }, label),
          React.createElement('span', {
            className: 'flex-shrink-0 text-[10px] text-ctp-overlay0',
          }, offset),
        ),
        event.filePath && React.createElement('div', {
          className: 'ml-5 text-[10px] text-ctp-overlay0 truncate',
        }, event.filePath),
      );
    }),

    // Load more sentinel
    events.length < totalEvents && React.createElement('div', {
      ref: sentinelRef,
      className: 'py-2 text-center text-[10px] text-ctp-overlay0',
    }, 'Loading more events...'),
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel, SidebarPanel };
void _;
