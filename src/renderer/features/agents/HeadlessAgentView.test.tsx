import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HeadlessAgentView, MAX_FEED_ITEMS } from './HeadlessAgentView';
import { useAgentStore } from '../../stores/agentStore';
import type { Agent } from '../../../shared/types';

const headlessAgent: Agent = {
  id: 'headless-1',
  projectId: 'proj-1',
  name: 'swift-runner',
  kind: 'durable',
  status: 'running',
  color: 'blue',
  headless: true,
  mission: 'Fix all the bugs',
};

function resetStore(spawnedAt?: number) {
  useAgentStore.setState({
    agents: { [headlessAgent.id]: headlessAgent },
    agentSpawnedAt: spawnedAt != null ? { [headlessAgent.id]: spawnedAt } : {},
    killAgent: vi.fn(),
  });
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('HeadlessAgentView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetStore();
    // Mock IPC calls
    window.clubhouse.agent.onHookEvent = vi.fn(() => vi.fn());
    window.clubhouse.agent.readTranscript = vi.fn().mockResolvedValue('');
    window.clubhouse.agent.readTranscriptPage = vi.fn().mockResolvedValue({
      events: [],
      totalEvents: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the live activity header without event count', () => {
    render(<HeadlessAgentView agent={headlessAgent} />);

    expect(screen.getByText('Live Activity')).toBeInTheDocument();
    // The event count label should not be present
    expect(screen.queryByText(/events$/)).not.toBeInTheDocument();
  });

  it('still shows the green pulse indicator dot', () => {
    const { container } = render(<HeadlessAgentView agent={headlessAgent} />);

    // Green pulse dot should still be present
    const pulseDot = container.querySelector('.bg-green-500.animate-pulse');
    expect(pulseDot).not.toBeNull();
  });

  it('renders the animated treehouse', () => {
    const { container } = render(<HeadlessAgentView agent={headlessAgent} />);

    // The treehouse SVG should be present
    const svg = container.querySelector('svg[viewBox="0 0 120 120"]');
    expect(svg).not.toBeNull();
  });

  it('shows agent mission text', () => {
    render(<HeadlessAgentView agent={headlessAgent} />);

    expect(screen.getByText('Fix all the bugs')).toBeInTheDocument();
  });

  it('shows stop button', () => {
    render(<HeadlessAgentView agent={headlessAgent} />);

    expect(screen.getByText('Stop Agent')).toBeInTheDocument();
  });

  it('uses agentSpawnedAt as the timer baseline so remounts preserve elapsed time', () => {
    // Agent was spawned 90 seconds ago
    const now = Date.now();
    resetStore(now - 90_000);

    const { unmount } = render(<HeadlessAgentView agent={headlessAgent} />);

    // Should show ~90s elapsed (1m 30s)
    expect(screen.getByText('1m 30s')).toBeInTheDocument();

    // Unmount and remount — timer should NOT reset
    unmount();
    render(<HeadlessAgentView agent={headlessAgent} />);

    expect(screen.getByText('1m 30s')).toBeInTheDocument();
  });

  it('continues ticking while agent is running', () => {
    const now = Date.now();
    resetStore(now - 10_000);

    render(<HeadlessAgentView agent={headlessAgent} />);
    expect(screen.getByText('10s')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText('15s')).toBeInTheDocument();
  });

  it('caps transcript feed items at MAX_FEED_ITEMS', async () => {
    const transcriptEvents = Array.from({ length: MAX_FEED_ITEMS + 50 }, (_, i) => ({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: `tool-${i}` }],
      },
    }));

    window.clubhouse.agent.readTranscriptPage = vi.fn().mockImplementation(
      async (_agentId: string, offset: number, limit: number) => ({
        events: transcriptEvents.slice(offset, offset + limit),
        totalEvents: transcriptEvents.length,
      }),
    );

    render(<HeadlessAgentView agent={headlessAgent} />);
    await flushAsyncWork();

    const toolItems = screen.getAllByText(/^tool-/);
    expect(toolItems.length).toBeLessThanOrEqual(MAX_FEED_ITEMS);
    expect(screen.getByText(`tool-${MAX_FEED_ITEMS + 49}`)).toBeInTheDocument();
  });

  it('uses transcript pages as the canonical source for tool and result items', async () => {
    let hookCallback: (agentId: string, event: Record<string, unknown>) => void = () => {};
    let transcriptReady = false;

    window.clubhouse.agent.onHookEvent = vi.fn((cb) => {
      hookCallback = cb;
      return vi.fn();
    });
    window.clubhouse.agent.readTranscriptPage = vi.fn().mockImplementation(async (_agentId: string, offset: number) => {
      if (!transcriptReady) {
        return { events: [], totalEvents: 0 };
      }

      if (offset === 0) {
        return {
          events: [
            {
              type: 'assistant',
              message: { content: [{ type: 'tool_use', name: 'Read' }] },
            },
            { type: 'result', result: 'Done' },
          ],
          totalEvents: 2,
        };
      }

      return { events: [], totalEvents: 2 };
    });

    render(<HeadlessAgentView agent={headlessAgent} />);

    act(() => {
      transcriptReady = true;
      hookCallback(headlessAgent.id, {
        kind: 'pre_tool',
        toolName: 'Read',
        timestamp: Date.now(),
      });
      hookCallback(headlessAgent.id, {
        kind: 'stop',
        message: 'Done',
        timestamp: Date.now(),
      });
    });

    await flushAsyncWork();

    expect(screen.getAllByText('Read')).toHaveLength(1);
    expect(screen.getAllByText('Done')).toHaveLength(1);

    expect(window.clubhouse.agent.readTranscript).not.toHaveBeenCalled();
  });

  it('polls transcript pages incrementally instead of rereading from the beginning', async () => {
    window.clubhouse.agent.readTranscriptPage = vi.fn().mockImplementation(async (_agentId: string, offset: number) => {
      if (offset === 0) {
        return {
          events: [
            {
              type: 'assistant',
              message: {
                content: [
                  { type: 'tool_use', name: 'Read' },
                  { type: 'text', text: 'Inspect file' },
                ],
              },
            },
          ],
          totalEvents: 1,
        };
      }

      if (offset === 1) {
        return {
          events: [{ type: 'result', result: 'Done' }],
          totalEvents: 2,
        };
      }

      return { events: [], totalEvents: 2 };
    });

    render(<HeadlessAgentView agent={headlessAgent} />);
    await flushAsyncWork();

    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Inspect file')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await flushAsyncWork();

    expect(screen.getByText('Done')).toBeInTheDocument();

    const offsets = vi.mocked(window.clubhouse.agent.readTranscriptPage).mock.calls
      .map(([, offset]) => offset);

    expect(offsets.filter((offset) => offset === 0)).toHaveLength(1);
    expect(offsets).toContain(1);
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Inspect file')).toBeInTheDocument();
  });

  it('suppresses polling when hooks are actively firing', async () => {
    let hookCallback: (agentId: string, event: Record<string, unknown>) => void = () => {};
    window.clubhouse.agent.onHookEvent = vi.fn((cb) => {
      hookCallback = cb;
      return vi.fn();
    });
    window.clubhouse.agent.readTranscriptPage = vi.fn().mockResolvedValue({
      events: [],
      totalEvents: 0,
    });

    render(<HeadlessAgentView agent={headlessAgent} />);

    // Initial mount triggers one sync
    await flushAsyncWork();
    const callsAfterMount = vi.mocked(window.clubhouse.agent.readTranscriptPage).mock.calls.length;

    // Fire hook events to mark hooks as active
    act(() => {
      hookCallback(headlessAgent.id, {
        kind: 'pre_tool',
        toolName: 'Read',
        timestamp: Date.now(),
      });
    });
    await flushAsyncWork();
    const callsAfterHook = vi.mocked(window.clubhouse.agent.readTranscriptPage).mock.calls.length;

    // Advance past multiple poll intervals (500ms each) while hooks are "active"
    // The poller should skip these cycles since hooks fired recently
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await flushAsyncWork();
    const callsAfterPolling = vi.mocked(window.clubhouse.agent.readTranscriptPage).mock.calls.length;

    // Hook-triggered sync should have added calls, but the poller intervals
    // should NOT have added any additional calls
    expect(callsAfterPolling).toBe(callsAfterHook);
    // Verify hook did trigger at least one sync beyond the initial mount
    expect(callsAfterHook).toBeGreaterThan(callsAfterMount);
  });

  it('resumes polling when hooks stop firing', async () => {
    let hookCallback: (agentId: string, event: Record<string, unknown>) => void = () => {};
    window.clubhouse.agent.onHookEvent = vi.fn((cb) => {
      hookCallback = cb;
      return vi.fn();
    });
    window.clubhouse.agent.readTranscriptPage = vi.fn().mockResolvedValue({
      events: [],
      totalEvents: 0,
    });

    render(<HeadlessAgentView agent={headlessAgent} />);
    await flushAsyncWork();

    // Fire a hook event to suppress polling
    act(() => {
      hookCallback(headlessAgent.id, {
        kind: 'pre_tool',
        toolName: 'Read',
        timestamp: Date.now(),
      });
    });
    await flushAsyncWork();
    const callsAfterHook = vi.mocked(window.clubhouse.agent.readTranscriptPage).mock.calls.length;

    // Advance past the hook active threshold (5s) so hooks are no longer "active"
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    await flushAsyncWork();
    const callsAfterThreshold = vi.mocked(window.clubhouse.agent.readTranscriptPage).mock.calls.length;

    // Polling should have resumed and made additional calls
    expect(callsAfterThreshold).toBeGreaterThan(callsAfterHook);
  });

  it('freezes the timer when the agent is no longer running', () => {
    const now = Date.now();
    resetStore(now - 60_000);

    const stoppedAgent: Agent = { ...headlessAgent, status: 'sleeping' };
    useAgentStore.setState({
      agents: { [stoppedAgent.id]: stoppedAgent },
    });

    render(<HeadlessAgentView agent={stoppedAgent} />);
    const displayed = screen.getByText('1m 0s');
    expect(displayed).toBeInTheDocument();

    // Advance time — should NOT change because agent is stopped
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText('1m 0s')).toBeInTheDocument();
  });
});
