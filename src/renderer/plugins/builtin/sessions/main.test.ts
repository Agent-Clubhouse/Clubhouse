import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import React from 'react';
import { activate, deactivate, MainPanel, SidebarPanel } from './main';
import { sessionsState } from './state';
import { manifest } from './manifest';
import * as sessionsModule from './main';
import { validateBuiltinPlugin } from '../builtin-plugin-testing';
import { createMockContext, createMockAPI } from '../../testing';
import type { PluginAPI, PluginContext, AgentInfo, CompletedQuickAgentInfo } from '../../../../shared/plugin-types';
import type { SessionEvent, SessionSummary, SessionTranscriptPage } from '../../../../shared/session-types';
import { AGENT_COLORS } from '../../../../shared/name-generator';

// ── IntersectionObserver polyfill for jsdom ──────────────────────────
if (typeof globalThis.IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = class IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Convert hex color to rgb() string as jsdom normalises inline styles */
function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

// ── Test fixtures ───────────────────────────────────────────────────

function makeDurableAgent(overrides?: Partial<AgentInfo>): AgentInfo {
  return {
    id: 'agent-1',
    name: 'curious-tapir',
    kind: 'durable',
    status: 'sleeping',
    color: 'indigo',
    projectId: 'proj-1',
    orchestrator: 'claude-code',
    ...overrides,
  };
}

function makeCompletedAgent(overrides?: Partial<CompletedQuickAgentInfo>): CompletedQuickAgentInfo {
  return {
    id: 'completed-1',
    projectId: 'proj-1',
    name: 'quick-task',
    mission: 'Fix something',
    summary: 'Fixed it',
    filesModified: [],
    exitCode: 0,
    completedAt: Date.now() - 60_000,
    ...overrides,
  };
}

function makeSessionEntry(overrides?: Partial<{ sessionId: string; startedAt: string; lastActiveAt: string; friendlyName?: string }>) {
  return {
    sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    lastActiveAt: new Date(Date.now() - 1800_000).toISOString(),
    ...overrides,
  };
}

function makeSessionEvent(overrides?: Partial<SessionEvent>): SessionEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    type: 'user_message',
    text: 'Hello',
    ...overrides,
  };
}

function makeSessionSummary(overrides?: Partial<SessionSummary>): SessionSummary {
  return {
    summary: 'Test session summary',
    filesModified: ['/src/main.ts'],
    totalToolCalls: 5,
    toolsUsed: ['Write', 'Bash'],
    totalCostUsd: 0.15,
    totalDurationMs: 30_000,
    totalInputTokens: 5000,
    totalOutputTokens: 2000,
    model: 'claude-sonnet-4-5-20250514',
    orchestrator: 'claude-code',
    eventCount: 10,
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    lastActiveAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeTranscriptPage(events: SessionEvent[], total?: number): SessionTranscriptPage {
  return {
    events,
    totalEvents: total ?? events.length,
  };
}

// ── Built-in plugin validation ───────────────────────────────────────

describe('sessions plugin (built-in validation)', () => {
  it('passes validateBuiltinPlugin', () => {
    const result = validateBuiltinPlugin({ manifest, module: sessionsModule });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── activate() ───────────────────────────────────────────────────────

describe('sessions plugin activate()', () => {
  let ctx: PluginContext;
  let api: PluginAPI;

  beforeEach(() => {
    ctx = createMockContext({ pluginId: 'sessions' });
    api = createMockAPI();
  });

  it('does not throw', () => {
    expect(() => activate(ctx, api)).not.toThrow();
  });

  it('does not call any agent API methods during activation', () => {
    const listSpy = vi.fn().mockReturnValue([]);
    api = createMockAPI({
      agents: {
        ...api.agents,
        list: listSpy,
      },
    });
    activate(ctx, api);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it('works without project context', () => {
    const appCtx = createMockContext({ pluginId: 'sessions', scope: 'project', projectId: undefined, projectPath: undefined });
    expect(() => activate(appCtx, api)).not.toThrow();
  });
});

// ── deactivate() ─────────────────────────────────────────────────────

describe('sessions plugin deactivate()', () => {
  beforeEach(() => {
    sessionsState.reset();
  });

  it('does not throw', () => {
    expect(() => deactivate()).not.toThrow();
  });

  it('can be called multiple times', () => {
    deactivate();
    deactivate();
    deactivate();
  });

  it('resets sessionsState selectedAgent to null', () => {
    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'Alpha', kind: 'durable' });
    expect(sessionsState.selectedAgent).not.toBeNull();
    deactivate();
    expect(sessionsState.selectedAgent).toBeNull();
  });

  it('resets sessionsState selectedSessionId to null', () => {
    sessionsState.setSelectedSession('session-123');
    expect(sessionsState.selectedSessionId).toBe('session-123');
    deactivate();
    expect(sessionsState.selectedSessionId).toBeNull();
  });

  it('resets playback state', () => {
    sessionsState.setPlaybackPlaying(true);
    sessionsState.setPlaybackSpeed(5);
    sessionsState.setPlaybackIndex(10);
    deactivate();
    expect(sessionsState.playback).toEqual({ playing: false, speed: 1, currentEventIndex: 0 });
  });
});

// ── SidebarPanel rendering ──────────────────────────────────────────

describe('SidebarPanel', () => {
  let api: PluginAPI;

  beforeEach(() => {
    sessionsState.reset();
    api = createMockAPI();
  });

  afterEach(() => {
    sessionsState.reset();
  });

  it('renders the sidebar panel with header', () => {
    render(React.createElement(SidebarPanel, { api }));
    expect(screen.getByTestId('sessions-sidebar-panel')).toBeDefined();
    expect(screen.getByText('Agents')).toBeDefined();
  });

  it('renders durable agents from the agents API', () => {
    const agent = makeDurableAgent();
    api = createMockAPI({
      agents: {
        ...api.agents,
        list: () => [agent],
        listCompleted: () => [],
      },
    });
    render(React.createElement(SidebarPanel, { api }));
    expect(screen.getByText('curious-tapir')).toBeDefined();
  });

  it('renders agent avatar with correct color hex (not raw color ID)', () => {
    const agent = makeDurableAgent({ color: 'violet' });
    api = createMockAPI({
      agents: {
        ...api.agents,
        list: () => [agent],
        listCompleted: () => [],
      },
    });
    render(React.createElement(SidebarPanel, { api }));

    // The avatar inner circle should use the hex value from AGENT_COLORS, not the raw "violet" string
    const violetColor = AGENT_COLORS.find((c) => c.id === 'violet');
    const agentRow = screen.getByTestId(`sessions-agent-${agent.id}`);
    // Find the initials circle (the inner div with background color)
    const initialsEl = agentRow.querySelector('[style*="background-color"]') as HTMLElement;
    expect(initialsEl).toBeTruthy();
    expect(initialsEl.style.backgroundColor).toBe(hexToRgb(violetColor!.hex));
  });

  it('renders agent initials from hyphenated name', () => {
    const agent = makeDurableAgent({ name: 'curious-tapir' });
    api = createMockAPI({
      agents: {
        ...api.agents,
        list: () => [agent],
        listCompleted: () => [],
      },
    });
    render(React.createElement(SidebarPanel, { api }));
    // "curious-tapir" → "CT"
    expect(screen.getByText('CT')).toBeDefined();
  });

  it('renders default color for agents without a color', () => {
    const agent = makeDurableAgent({ color: '' });
    api = createMockAPI({
      agents: {
        ...api.agents,
        list: () => [agent],
        listCompleted: () => [],
      },
    });
    render(React.createElement(SidebarPanel, { api }));
    const agentRow = screen.getByTestId(`sessions-agent-${agent.id}`);
    const initialsEl = agentRow.querySelector('[style*="background-color"]') as HTMLElement;
    expect(initialsEl).toBeTruthy();
    // Should use default #6366f1 (indigo)
    expect(initialsEl.style.backgroundColor).toBe(hexToRgb('#6366f1'));
  });

  it('renders status ring border color based on agent status', () => {
    const runningAgent = makeDurableAgent({ id: 'a-running', status: 'running', name: 'running-agent' });
    const sleepingAgent = makeDurableAgent({ id: 'a-sleeping', status: 'sleeping', name: 'sleeping-agent' });
    api = createMockAPI({
      agents: {
        ...api.agents,
        list: () => [runningAgent, sleepingAgent],
        listCompleted: () => [],
      },
    });
    render(React.createElement(SidebarPanel, { api }));

    // Running agent should have green border
    const runningRow = screen.getByTestId('sessions-agent-a-running');
    const runningRing = runningRow.querySelector('[style*="border-color"]') as HTMLElement;
    expect(runningRing.style.borderColor).toBe('rgb(34, 197, 94)');

    // Sleeping agent should have grey border
    const sleepingRow = screen.getByTestId('sessions-agent-a-sleeping');
    const sleepingRing = sleepingRow.querySelector('[style*="border-color"]') as HTMLElement;
    expect(sleepingRing.style.borderColor).toBe('rgb(108, 112, 134)');
  });

  it('shows status label for different statuses', () => {
    api = createMockAPI({
      agents: {
        ...api.agents,
        list: () => [
          makeDurableAgent({ id: 'a1', name: 'running-bot', status: 'running' }),
          makeDurableAgent({ id: 'a2', name: 'sleeping-bot', status: 'sleeping' }),
          makeDurableAgent({ id: 'a3', name: 'error-bot', status: 'error' }),
        ],
        listCompleted: () => [],
      },
    });
    render(React.createElement(SidebarPanel, { api }));
    expect(screen.getByText('Running')).toBeDefined();
    expect(screen.getByText('Sleeping')).toBeDefined();
    expect(screen.getByText('Error')).toBeDefined();
  });

  it('loads and displays sessions when agent is expanded', async () => {
    const agent = makeDurableAgent();
    const sessions = [
      makeSessionEntry({ sessionId: 'sess-001', friendlyName: 'Bug fix session' }),
      makeSessionEntry({ sessionId: 'sess-002' }),
    ];
    const listSessionsMock = vi.fn().mockResolvedValue(sessions);

    api = createMockAPI({
      agents: {
        ...api.agents,
        list: () => [agent],
        listCompleted: () => [],
        listSessions: listSessionsMock,
      },
    });

    render(React.createElement(SidebarPanel, { api }));

    // Click agent to expand
    await act(async () => {
      fireEvent.click(screen.getByTestId(`sessions-agent-${agent.id}`));
    });

    // Wait for sessions to load
    await waitFor(() => {
      expect(screen.getByText('Bug fix session')).toBeDefined();
    });

    expect(listSessionsMock).toHaveBeenCalledWith(agent.id);
  });

  it('shows "No sessions" when agent has no sessions', async () => {
    const agent = makeDurableAgent();
    api = createMockAPI({
      agents: {
        ...api.agents,
        list: () => [agent],
        listCompleted: () => [],
        listSessions: vi.fn().mockResolvedValue([]),
      },
    });

    render(React.createElement(SidebarPanel, { api }));

    await act(async () => {
      fireEvent.click(screen.getByTestId(`sessions-agent-${agent.id}`));
    });

    await waitFor(() => {
      expect(screen.getByText('No sessions')).toBeDefined();
    });
  });

  it('shows "Loading sessions..." while fetching', async () => {
    const agent = makeDurableAgent();
    let resolvePromise: (v: any) => void;
    const pendingPromise = new Promise((resolve) => { resolvePromise = resolve; });

    api = createMockAPI({
      agents: {
        ...api.agents,
        list: () => [agent],
        listCompleted: () => [],
        listSessions: vi.fn().mockReturnValue(pendingPromise),
      },
    });

    render(React.createElement(SidebarPanel, { api }));

    await act(async () => {
      fireEvent.click(screen.getByTestId(`sessions-agent-${agent.id}`));
    });

    expect(screen.getByText('Loading sessions...')).toBeDefined();

    // Resolve the promise to clean up
    await act(async () => {
      resolvePromise!([]);
    });
  });

  it('clicking a session sets the selected session state', async () => {
    const agent = makeDurableAgent();
    const session = makeSessionEntry({ sessionId: 'sess-abc', friendlyName: 'My Session' });
    api = createMockAPI({
      agents: {
        ...api.agents,
        list: () => [agent],
        listCompleted: () => [],
        listSessions: vi.fn().mockResolvedValue([session]),
      },
    });

    render(React.createElement(SidebarPanel, { api }));

    // Expand agent
    await act(async () => {
      fireEvent.click(screen.getByTestId(`sessions-agent-${agent.id}`));
    });

    // Wait for sessions
    await waitFor(() => {
      expect(screen.getByText('My Session')).toBeDefined();
    });

    // Click session
    await act(async () => {
      fireEvent.click(screen.getByTestId(`session-entry-${session.sessionId}`));
    });

    expect(sessionsState.selectedSessionId).toBe(session.sessionId);
    expect(sessionsState.selectedAgent?.agentId).toBe(agent.id);
  });

  it('renders completed agents with lightning icon avatar', () => {
    const completed = makeCompletedAgent();
    api = createMockAPI({
      agents: {
        ...api.agents,
        list: () => [],
        listCompleted: () => [completed],
      },
    });

    render(React.createElement(SidebarPanel, { api }));
    expect(screen.getByText('quick-task')).toBeDefined();
    expect(screen.getByTestId(`sessions-completed-${completed.id}`)).toBeDefined();
    // Should show lightning icon
    expect(screen.getByText('\u26A1')).toBeDefined();
  });

  it('does not re-fetch sessions when agent is already loaded (via ref tracking)', async () => {
    const agent = makeDurableAgent();
    const listSessionsMock = vi.fn().mockResolvedValue([makeSessionEntry()]);

    api = createMockAPI({
      agents: {
        ...api.agents,
        list: () => [agent],
        listCompleted: () => [],
        listSessions: listSessionsMock,
      },
    });

    render(React.createElement(SidebarPanel, { api }));

    // First expand
    await act(async () => {
      fireEvent.click(screen.getByTestId(`sessions-agent-${agent.id}`));
    });

    await waitFor(() => {
      expect(listSessionsMock).toHaveBeenCalledTimes(1);
    });

    // Collapse
    await act(async () => {
      fireEvent.click(screen.getByTestId(`sessions-agent-${agent.id}`));
    });

    // Re-expand — should NOT call listSessions again
    await act(async () => {
      fireEvent.click(screen.getByTestId(`sessions-agent-${agent.id}`));
    });

    // Wait a tick to ensure no additional call
    await waitFor(() => {
      expect(listSessionsMock).toHaveBeenCalledTimes(1);
    });
  });

  it('each AGENT_COLORS entry maps to correct hex in avatar', () => {
    // Regression: ensure all color IDs resolve correctly, not as CSS color names
    const agents = AGENT_COLORS.map((c, i) =>
      makeDurableAgent({ id: `agent-${c.id}`, name: `test-${c.id}`, color: c.id }),
    );
    api = createMockAPI({
      agents: {
        ...api.agents,
        list: () => agents,
        listCompleted: () => [],
      },
    });
    render(React.createElement(SidebarPanel, { api }));

    for (const c of AGENT_COLORS) {
      const row = screen.getByTestId(`sessions-agent-agent-${c.id}`);
      const initialsEl = row.querySelector('[style*="background-color"]') as HTMLElement;
      expect(initialsEl).toBeTruthy();
      // The style should contain the hex value (as rgb), not the color name
      expect(initialsEl.style.backgroundColor).toBe(hexToRgb(c.hex));
    }
  });

  it('renders multiple durable agents in order', () => {
    const agents = [
      makeDurableAgent({ id: 'a1', name: 'alpha-agent' }),
      makeDurableAgent({ id: 'a2', name: 'beta-agent' }),
      makeDurableAgent({ id: 'a3', name: 'gamma-agent' }),
    ];
    api = createMockAPI({
      agents: {
        ...api.agents,
        list: () => agents,
        listCompleted: () => [],
      },
    });
    render(React.createElement(SidebarPanel, { api }));
    const panel = screen.getByTestId('sessions-sidebar-panel');
    const text = panel.textContent || '';
    expect(text.indexOf('alpha-agent')).toBeLessThan(text.indexOf('beta-agent'));
    expect(text.indexOf('beta-agent')).toBeLessThan(text.indexOf('gamma-agent'));
  });

  it('only renders durable agents, not quick ones', () => {
    const durable = makeDurableAgent({ id: 'a1', name: 'durable-bot' });
    const quick: AgentInfo = { ...makeDurableAgent({ id: 'a2', name: 'quick-bot' }), kind: 'quick' };
    api = createMockAPI({
      agents: {
        ...api.agents,
        list: () => [durable, quick],
        listCompleted: () => [],
      },
    });
    render(React.createElement(SidebarPanel, { api }));
    expect(screen.getByText('durable-bot')).toBeDefined();
    expect(screen.queryByText('quick-bot')).toBeNull();
  });

  it('marks first session as latest', async () => {
    const agent = makeDurableAgent();
    const sessions = [
      makeSessionEntry({ sessionId: 'sess-latest' }),
      makeSessionEntry({ sessionId: 'sess-older' }),
    ];
    api = createMockAPI({
      agents: {
        ...api.agents,
        list: () => [agent],
        listCompleted: () => [],
        listSessions: vi.fn().mockResolvedValue(sessions),
      },
    });
    render(React.createElement(SidebarPanel, { api }));

    await act(async () => {
      fireEvent.click(screen.getByTestId(`sessions-agent-${agent.id}`));
    });

    await waitFor(() => {
      expect(screen.getByText('latest')).toBeDefined();
    });
  });

  it('subscribes to agent changes and refreshes', async () => {
    let changeCallback: (() => void) | null = null;
    const onAnyChange = vi.fn().mockImplementation((cb: () => void) => {
      changeCallback = cb;
      return { dispose: vi.fn() };
    });
    const listMock = vi.fn().mockReturnValue([]);

    api = createMockAPI({
      agents: {
        ...api.agents,
        list: listMock,
        listCompleted: () => [],
        onAnyChange,
      },
    });

    render(React.createElement(SidebarPanel, { api }));
    expect(onAnyChange).toHaveBeenCalled();

    // Simulate agent change
    listMock.mockReturnValue([makeDurableAgent({ name: 'new-agent' })]);
    await act(async () => {
      changeCallback?.();
    });

    expect(screen.getByText('new-agent')).toBeDefined();
  });
});

// ── MainPanel rendering ─────────────────────────────────────────────

describe('MainPanel', () => {
  let api: PluginAPI;

  beforeEach(() => {
    sessionsState.reset();
    api = createMockAPI();
  });

  afterEach(() => {
    sessionsState.reset();
  });

  it('shows placeholder when no session is selected', () => {
    render(React.createElement(MainPanel, { api }));
    expect(screen.getByTestId('sessions-main-panel')).toBeDefined();
    expect(screen.getByText('Select an agent and session to view details')).toBeDefined();
  });

  it('shows loading state when fetching session data', async () => {
    let resolvePromise: (v: any) => void;
    const pendingPromise = new Promise((resolve) => { resolvePromise = resolve; });

    api = createMockAPI({
      agents: {
        ...api.agents,
        getSessionSummary: vi.fn().mockReturnValue(pendingPromise),
        readSessionTranscript: vi.fn().mockReturnValue(pendingPromise),
      },
    });

    // Select an agent and session
    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'Alpha', kind: 'durable' });
    sessionsState.setSelectedSession('sess-123');

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Loading session...')).toBeDefined();
    });

    // Resolve to clean up
    await act(async () => {
      resolvePromise!(null);
    });
  });

  it('loads and displays session summary and events', async () => {
    const summary = makeSessionSummary();
    const events = [
      makeSessionEvent({ type: 'user_message', text: 'Fix the bug' }),
      makeSessionEvent({ type: 'assistant_message', text: 'Sure, let me look at it' }),
      makeSessionEvent({ type: 'tool_use', toolName: 'Write', filePath: '/src/main.ts' }),
    ];
    const page = makeTranscriptPage(events);

    api = createMockAPI({
      agents: {
        ...api.agents,
        getSessionSummary: vi.fn().mockResolvedValue(summary),
        readSessionTranscript: vi.fn().mockResolvedValue(page),
      },
    });

    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'Alpha', kind: 'durable' });
    sessionsState.setSelectedSession('sess-123');

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      // Summary card
      expect(screen.getByTestId('session-summary-card')).toBeDefined();
      // Event list
      expect(screen.getByTestId('session-event-list')).toBeDefined();
    });

    // Check events rendered
    expect(screen.getByText('Fix the bug')).toBeDefined();
    expect(screen.getByText('Sure, let me look at it')).toBeDefined();
    expect(screen.getByText('Write')).toBeDefined();
    // Check file path display
    expect(screen.getByText('/src/main.ts')).toBeDefined();
  });

  it('displays session summary card with stats', async () => {
    const summary = makeSessionSummary({
      totalToolCalls: 12,
      totalCostUsd: 0.42,
      totalDurationMs: 120_000,
      totalInputTokens: 10_000,
      totalOutputTokens: 5_000,
      model: 'claude-sonnet-4-5-20250514',
      orchestrator: 'claude-code',
      filesModified: ['/a.ts', '/b.ts'],
    });

    api = createMockAPI({
      agents: {
        ...api.agents,
        getSessionSummary: vi.fn().mockResolvedValue(summary),
        readSessionTranscript: vi.fn().mockResolvedValue(makeTranscriptPage([])),
      },
    });

    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'Alpha', kind: 'durable' });
    sessionsState.setSelectedSession('sess-1');

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByTestId('session-summary-card')).toBeDefined();
    });

    const card = screen.getByTestId('session-summary-card');
    const cardText = card.textContent || '';
    expect(cardText).toContain('12'); // tool calls
    expect(cardText).toContain('$0.42'); // cost
    expect(cardText).toContain('2m'); // duration
    expect(cardText).toContain('10.0K'); // input tokens
    expect(cardText).toContain('5.0K'); // output tokens
    expect(cardText).toContain('Model: claude-sonnet-4-5-20250514');
    expect(cardText).toContain('Provider: claude-code');
    // File list toggle
    expect(screen.getByText('Show 2 modified files')).toBeDefined();
  });

  it('expandable file list in summary card', async () => {
    const summary = makeSessionSummary({ filesModified: ['/src/app.ts', '/src/utils.ts'] });

    api = createMockAPI({
      agents: {
        ...api.agents,
        getSessionSummary: vi.fn().mockResolvedValue(summary),
        readSessionTranscript: vi.fn().mockResolvedValue(makeTranscriptPage([])),
      },
    });

    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'Alpha', kind: 'durable' });
    sessionsState.setSelectedSession('sess-1');

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Show 2 modified files')).toBeDefined();
    });

    // Click to expand files
    fireEvent.click(screen.getByText('Show 2 modified files'));
    expect(screen.getByText('/src/app.ts')).toBeDefined();
    expect(screen.getByText('/src/utils.ts')).toBeDefined();
    expect(screen.getByText('Hide files')).toBeDefined();
  });

  it('shows "No events in this session" when events are empty', async () => {
    api = createMockAPI({
      agents: {
        ...api.agents,
        getSessionSummary: vi.fn().mockResolvedValue(null),
        readSessionTranscript: vi.fn().mockResolvedValue(makeTranscriptPage([])),
      },
    });

    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'Alpha', kind: 'durable' });
    sessionsState.setSelectedSession('sess-empty');

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('No events in this session')).toBeDefined();
    });
  });

  it('shows "No events in this session" when transcript returns null', async () => {
    api = createMockAPI({
      agents: {
        ...api.agents,
        getSessionSummary: vi.fn().mockResolvedValue(null),
        readSessionTranscript: vi.fn().mockResolvedValue(null),
      },
    });

    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'Alpha', kind: 'durable' });
    sessionsState.setSelectedSession('sess-null');

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('No events in this session')).toBeDefined();
    });
  });

  it('renders session header with agent name and session ID prefix', async () => {
    api = createMockAPI({
      agents: {
        ...api.agents,
        getSessionSummary: vi.fn().mockResolvedValue(makeSessionSummary()),
        readSessionTranscript: vi.fn().mockResolvedValue(makeTranscriptPage([makeSessionEvent()])),
      },
    });

    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'my-agent', kind: 'durable' });
    sessionsState.setSelectedSession('abcdef12-3456-7890-abcd-ef1234567890');

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      const panel = screen.getByTestId('sessions-main-panel');
      const text = panel.textContent || '';
      expect(text).toContain('my-agent');
      expect(text).toContain('abcdef12');
    });
  });

  it('renders timeline section with playback controls when events exist', async () => {
    const events = [
      makeSessionEvent({ timestamp: 1000, type: 'user_message' }),
      makeSessionEvent({ timestamp: 2000, type: 'assistant_message' }),
      makeSessionEvent({ timestamp: 3000, type: 'tool_use' }),
    ];

    api = createMockAPI({
      agents: {
        ...api.agents,
        getSessionSummary: vi.fn().mockResolvedValue(makeSessionSummary()),
        readSessionTranscript: vi.fn().mockResolvedValue(makeTranscriptPage(events)),
      },
    });

    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'Alpha', kind: 'durable' });
    sessionsState.setSelectedSession('sess-1');

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByTestId('session-timeline')).toBeDefined();
      expect(screen.getByTestId('playback-toggle')).toBeDefined();
    });

    // Speed buttons
    expect(screen.getByText('1x')).toBeDefined();
    expect(screen.getByText('3x')).toBeDefined();
    expect(screen.getByText('5x')).toBeDefined();
  });

  it('playback toggle changes state', async () => {
    const events = [
      makeSessionEvent({ timestamp: 1000 }),
      makeSessionEvent({ timestamp: 2000 }),
    ];

    api = createMockAPI({
      agents: {
        ...api.agents,
        getSessionSummary: vi.fn().mockResolvedValue(makeSessionSummary()),
        readSessionTranscript: vi.fn().mockResolvedValue(makeTranscriptPage(events)),
      },
    });

    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'Alpha', kind: 'durable' });
    sessionsState.setSelectedSession('sess-1');

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByTestId('playback-toggle')).toBeDefined();
    });

    expect(sessionsState.playback.playing).toBe(false);
    fireEvent.click(screen.getByTestId('playback-toggle'));
    expect(sessionsState.playback.playing).toBe(true);
  });

  it('clicking an event updates playback index', async () => {
    const events = [
      makeSessionEvent({ timestamp: 1000, text: 'First event' }),
      makeSessionEvent({ timestamp: 2000, text: 'Second event' }),
    ];

    api = createMockAPI({
      agents: {
        ...api.agents,
        getSessionSummary: vi.fn().mockResolvedValue(null),
        readSessionTranscript: vi.fn().mockResolvedValue(makeTranscriptPage(events)),
      },
    });

    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'Alpha', kind: 'durable' });
    sessionsState.setSelectedSession('sess-1');

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Second event')).toBeDefined();
    });

    // Click second event
    const secondEvent = screen.getByText('Second event').closest('button')!;
    fireEvent.click(secondEvent);

    expect(sessionsState.playback.currentEventIndex).toBe(1);
  });

  it('calls getSessionSummary and readSessionTranscript with correct args', async () => {
    const getSummary = vi.fn().mockResolvedValue(null);
    const readTranscript = vi.fn().mockResolvedValue(null);

    api = createMockAPI({
      agents: {
        ...api.agents,
        getSessionSummary: getSummary,
        readSessionTranscript: readTranscript,
      },
    });

    sessionsState.setSelectedAgent({ agentId: 'agent-42', agentName: 'Test', kind: 'durable' });
    sessionsState.setSelectedSession('session-xyz');

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(getSummary).toHaveBeenCalledWith('agent-42', 'session-xyz');
      expect(readTranscript).toHaveBeenCalledWith('agent-42', 'session-xyz', 0, 100);
    });
  });

  it('clears state when selection is removed', async () => {
    const events = [makeSessionEvent()];

    api = createMockAPI({
      agents: {
        ...api.agents,
        getSessionSummary: vi.fn().mockResolvedValue(makeSessionSummary()),
        readSessionTranscript: vi.fn().mockResolvedValue(makeTranscriptPage(events)),
      },
    });

    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'Alpha', kind: 'durable' });
    sessionsState.setSelectedSession('sess-1');

    const { rerender } = render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByTestId('session-event-list')).toBeDefined();
    });

    // Clear selection
    await act(async () => {
      sessionsState.setSelectedSession(null);
    });

    // Should show placeholder again
    await waitFor(() => {
      expect(screen.getByText('Select an agent and session to view details')).toBeDefined();
    });
  });

  it('shows event count in header', async () => {
    const events = [
      makeSessionEvent({ timestamp: 1000 }),
      makeSessionEvent({ timestamp: 2000 }),
      makeSessionEvent({ timestamp: 3000 }),
    ];

    api = createMockAPI({
      agents: {
        ...api.agents,
        getSessionSummary: vi.fn().mockResolvedValue(null),
        readSessionTranscript: vi.fn().mockResolvedValue(makeTranscriptPage(events)),
      },
    });

    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'Alpha', kind: 'durable' });
    sessionsState.setSelectedSession('sess-1');

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Events (3)')).toBeDefined();
    });
  });

  it('shows partial event count when paginated', async () => {
    const events = [
      makeSessionEvent({ timestamp: 1000 }),
      makeSessionEvent({ timestamp: 2000 }),
    ];

    api = createMockAPI({
      agents: {
        ...api.agents,
        getSessionSummary: vi.fn().mockResolvedValue(null),
        readSessionTranscript: vi.fn().mockResolvedValue(makeTranscriptPage(events, 10)),
      },
    });

    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'Alpha', kind: 'durable' });
    sessionsState.setSelectedSession('sess-1');

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('Events (2 of 10)')).toBeDefined();
    });
  });

  it('renders event labels correctly for each type', async () => {
    const events = [
      makeSessionEvent({ type: 'user_message', text: 'User prompt', timestamp: 1000 }),
      makeSessionEvent({ type: 'assistant_message', text: 'AI response', timestamp: 2000 }),
      makeSessionEvent({ type: 'tool_use', toolName: 'Bash', timestamp: 3000 }),
      makeSessionEvent({ type: 'result', timestamp: 4000 }),
    ];

    api = createMockAPI({
      agents: {
        ...api.agents,
        getSessionSummary: vi.fn().mockResolvedValue(null),
        readSessionTranscript: vi.fn().mockResolvedValue(makeTranscriptPage(events)),
      },
    });

    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'Alpha', kind: 'durable' });
    sessionsState.setSelectedSession('sess-1');

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(screen.getByText('User prompt')).toBeDefined();
      expect(screen.getByText('AI response')).toBeDefined();
      expect(screen.getByText('Bash')).toBeDefined();
      expect(screen.getByText('Result')).toBeDefined();
    });
  });

  it('sets window title based on selection', async () => {
    const setTitle = vi.fn();
    const resetTitle = vi.fn();

    api = createMockAPI({
      agents: {
        ...api.agents,
        getSessionSummary: vi.fn().mockResolvedValue(null),
        readSessionTranscript: vi.fn().mockResolvedValue(null),
      },
      window: {
        ...api.window,
        setTitle,
        resetTitle,
      },
    });

    sessionsState.setSelectedAgent({ agentId: 'a1', agentName: 'TestAgent', kind: 'durable' });
    sessionsState.setSelectedSession('abcdef12-3456');

    render(React.createElement(MainPanel, { api }));

    await waitFor(() => {
      expect(setTitle).toHaveBeenCalledWith('TestAgent \u2014 abcdef12');
    });
  });
});

// ── Module exports ───────────────────────────────────────────────────

describe('sessions plugin module exports', () => {
  it('exports activate function', () => {
    expect(typeof sessionsModule.activate).toBe('function');
  });

  it('exports deactivate function', () => {
    expect(typeof sessionsModule.deactivate).toBe('function');
  });

  it('exports MainPanel component', () => {
    expect(typeof sessionsModule.MainPanel).toBe('function');
  });

  it('exports SidebarPanel component', () => {
    expect(typeof (sessionsModule as any).SidebarPanel).toBe('function');
  });

  it('does not export HubPanel', () => {
    expect((sessionsModule as any).HubPanel).toBeUndefined();
  });

  it('does not export SettingsPanel', () => {
    expect((sessionsModule as any).SettingsPanel).toBeUndefined();
  });
});

// ── Plugin lifecycle integration ─────────────────────────────────────

describe('sessions plugin lifecycle', () => {
  beforeEach(() => {
    sessionsState.reset();
  });

  it('activate then deactivate does not throw', () => {
    const ctx = createMockContext({ pluginId: 'sessions' });
    const api = createMockAPI();
    activate(ctx, api);
    deactivate();
  });
});
