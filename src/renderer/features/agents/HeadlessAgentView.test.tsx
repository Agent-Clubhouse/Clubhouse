import { render, screen, act, fireEvent } from '@testing-library/react';
import { installTranscriptShim } from './states/transcript-test-utils';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HeadlessAgentView } from './HeadlessAgentView';
import { useAgentStore } from '../../stores/agentStore';
import type { Agent } from '../../../shared/types';

const headlessAgent: Agent = {
  id: 'headless-1',
  projectId: 'proj-1',
  name: 'swift-runner',
  kind: 'quick',
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
    // Yield enough microtask ticks for multi-page transcript syncs
    // to complete before flushing the batched requestAnimationFrame.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    vi.advanceTimersByTime(16); // flush requestAnimationFrame
    await Promise.resolve();
  });
}

describe('HeadlessAgentView', () => {
  let transcript: ReturnType<typeof installTranscriptShim>;
  beforeEach(() => {
    vi.useFakeTimers();
    transcript = installTranscriptShim();
    vi.clearAllMocks();
    resetStore();
    // Mock IPC calls
    window.clubhouse.agent.onHookEvent = vi.fn(() => vi.fn());
    window.clubhouse.agent.readTranscript = vi.fn().mockResolvedValue('');
    transcript.page = vi.fn().mockResolvedValue({
      events: [],
      totalEvents: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows Working in the toolbar and the starting state before the first step', () => {
    render(<HeadlessAgentView agent={headlessAgent} />);
    expect(screen.getByTestId('state-word')).toHaveTextContent('Working');
    expect(screen.getByTestId('run-toolbar')).toHaveTextContent('headless · starting');
    expect(screen.getByTestId('run-starting')).toHaveTextContent('Starting swift-runner');
    expect(screen.getByTestId('headless-agent-view')).toHaveAttribute('data-phase', 'start');
  });

  it('renders the treehouse in theme tokens, with the run state', () => {
    const { container } = render(<HeadlessAgentView agent={headlessAgent} />);
    expect(screen.getByTestId('treehouse')).toHaveAttribute('data-phase', 'start');
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });

  it('shows the mission in the header, no Headless chip or uppercase label', () => {
    render(<HeadlessAgentView agent={headlessAgent} />);
    expect(screen.getByTestId('run-mission')).toHaveTextContent('Fix all the bugs');
    expect(screen.queryByText('Headless')).toBeNull();
    expect(screen.queryByText('Live Activity')).toBeNull();
  });

  it('shows stop button', () => {
    render(<HeadlessAgentView agent={headlessAgent} />);
    expect(screen.getByTestId('stop-agent-button')).toHaveTextContent('Stop…');
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

  it('uses transcript pages as the canonical source for tool and result items', async () => {
    let hookCallback: (agentId: string, event: Record<string, unknown>) => void = () => {};
    let transcriptReady = false;

    window.clubhouse.agent.onHookEvent = vi.fn((cb) => {
      hookCallback = cb;
      return vi.fn();
    });
    transcript.page = vi.fn().mockImplementation(async (_agentId: string, offset: number) => {
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

    expect(screen.getAllByTestId('timeline-tool')).toHaveLength(1);
    expect(screen.getByTestId('timeline-tool')).toHaveAttribute('data-tool', 'Read');

    expect(window.clubhouse.agent.readTranscript).not.toHaveBeenCalled();
  });

  it('polls transcript pages incrementally instead of rereading from the beginning', async () => {
    transcript.page = vi.fn().mockImplementation(async (_agentId: string, offset: number) => {
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

    expect(screen.getByTestId('timeline-tool')).toHaveAttribute('data-tool', 'Read');
    expect(screen.getByText('Inspect file')).toBeInTheDocument();
    expect(screen.getByTestId('headless-agent-view')).toHaveAttribute('data-phase', 'run');

    // Advance past the 5s fallback poll interval to trigger the next sync
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await flushAsyncWork();

    const offsets = vi.mocked(transcript.page).mock.calls
      .map(([, offset]) => offset);

    expect(offsets.filter((offset) => offset === 0)).toHaveLength(1);
    expect(offsets).toContain(1);
    expect(screen.getByTestId('timeline-tool')).toHaveAttribute('data-tool', 'Read');
    expect(screen.getByText('Inspect file')).toBeInTheDocument();
  });

  it('suppresses fallback polling when hooks are actively firing', async () => {
    let hookCallback: (agentId: string, event: Record<string, unknown>) => void = () => {};
    window.clubhouse.agent.onHookEvent = vi.fn((cb) => {
      hookCallback = cb;
      return vi.fn();
    });
    transcript.page = vi.fn().mockResolvedValue({
      events: [],
      totalEvents: 0,
    });

    render(<HeadlessAgentView agent={headlessAgent} />);

    // Initial mount triggers one sync
    await flushAsyncWork();
    const callsAfterMount = vi.mocked(transcript.page).mock.calls.length;

    // Fire hook event to mark hooks as active
    act(() => {
      hookCallback(headlessAgent.id, {
        kind: 'pre_tool',
        toolName: 'Read',
        timestamp: Date.now(),
      });
    });
    await flushAsyncWork();
    const callsAfterHook = vi.mocked(transcript.page).mock.calls.length;

    // Fire another hook at t=3s to keep hooks "active"
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    act(() => {
      hookCallback(headlessAgent.id, {
        kind: 'post_tool',
        toolName: 'Read',
        timestamp: Date.now(),
      });
    });
    await flushAsyncWork();
    const callsAfterSecondHook = vi.mocked(transcript.page).mock.calls.length;

    // Advance to t=7.5s — the fallback poll at t=5s should have been suppressed
    // because the second hook at t=3s keeps lastHookTimestamp within the 5s threshold
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    await flushAsyncWork();
    const callsAfterPolling = vi.mocked(transcript.page).mock.calls.length;

    // Only hook-triggered syncs should have occurred, no fallback polls
    expect(callsAfterPolling).toBe(callsAfterSecondHook);
    // Verify hooks triggered syncs beyond the initial mount
    expect(callsAfterHook).toBeGreaterThan(callsAfterMount);
  });

  it('resumes fallback polling when hooks stop firing', async () => {
    let hookCallback: (agentId: string, event: Record<string, unknown>) => void = () => {};
    window.clubhouse.agent.onHookEvent = vi.fn((cb) => {
      hookCallback = cb;
      return vi.fn();
    });
    transcript.page = vi.fn().mockResolvedValue({
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
    const callsAfterHook = vi.mocked(transcript.page).mock.calls.length;

    // Advance past both the hook active threshold and fallback poll interval
    // so polling resumes (hook at t=0 is stale by t=10s, and the t=10s poll fires)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await flushAsyncWork();
    const callsAfterThreshold = vi.mocked(transcript.page).mock.calls.length;

    // Fallback polling should have resumed and made additional calls
    expect(callsAfterThreshold).toBeGreaterThan(callsAfterHook);
  });

  it('does not aggressively poll during startup — only initial sync and fallback', async () => {
    transcript.page = vi.fn().mockResolvedValue({
      events: [],
      totalEvents: 0,
    });

    render(<HeadlessAgentView agent={headlessAgent} />);
    await flushAsyncWork();

    // Initial mount sync
    const callsAfterMount = vi.mocked(transcript.page).mock.calls.length;
    expect(callsAfterMount).toBe(1);

    // Advance 4.9s — no fallback poll should have fired yet (interval is 5s)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4900);
    });
    await flushAsyncWork();
    const callsBefore5s = vi.mocked(transcript.page).mock.calls.length;
    expect(callsBefore5s).toBe(1);

    // Advance past the 5s fallback interval — exactly one fallback poll should fire
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    await flushAsyncWork();
    const callsAfter5s = vi.mocked(transcript.page).mock.calls.length;
    expect(callsAfter5s).toBe(2);
  });

  it('batches rapid notification events into a single state flush', async () => {
    let hookCallback: (agentId: string, event: Record<string, unknown>) => void = () => {};
    window.clubhouse.agent.onHookEvent = vi.fn((cb) => {
      hookCallback = cb;
      return vi.fn();
    });
    transcript.page = vi.fn().mockResolvedValue({
      events: [],
      totalEvents: 0,
    });

    render(<HeadlessAgentView agent={headlessAgent} />);
    await flushAsyncWork();

    // Fire 5 notification events synchronously — they should be batched
    // into a single requestAnimationFrame flush instead of 5 array copies.
    act(() => {
      for (let i = 0; i < 5; i++) {
        hookCallback(headlessAgent.id, {
          kind: 'notification',
          message: `batch-msg-${i}`,
          timestamp: Date.now(),
        });
      }
    });
    await flushAsyncWork();

    // All 5 notifications should appear
    for (let i = 0; i < 5; i++) {
      expect(screen.getByText(`batch-msg-${i}`)).toBeInTheDocument();
    }
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

  it('clicking Stop Agent shows confirm dialog without calling killAgent', () => {
    const mockKillAgent = vi.fn();
    useAgentStore.setState({ killAgent: mockKillAgent });
    render(<HeadlessAgentView agent={headlessAgent} />);
    fireEvent.click(screen.getByTestId('stop-agent-button'));
    expect(screen.getByText(`Stop ${headlessAgent.name}?`)).toBeInTheDocument();
    expect(mockKillAgent).not.toHaveBeenCalled();
  });

  it('cancelling kill confirm dialog does not call killAgent', () => {
    const mockKillAgent = vi.fn();
    useAgentStore.setState({ killAgent: mockKillAgent });
    render(<HeadlessAgentView agent={headlessAgent} />);
    fireEvent.click(screen.getByTestId('stop-agent-button'));
    fireEvent.click(screen.getByTestId('confirm-destructive-cancel'));
    expect(mockKillAgent).not.toHaveBeenCalled();
  });

  it('confirming kill dialog calls killAgent with agent id', () => {
    const mockKillAgent = vi.fn();
    useAgentStore.setState({ killAgent: mockKillAgent });
    render(<HeadlessAgentView agent={headlessAgent} />);
    fireEvent.click(screen.getByTestId('stop-agent-button'));
    fireEvent.click(screen.getByTestId('confirm-destructive-confirm'));
    expect(mockKillAgent).toHaveBeenCalledWith(headlessAgent.id);
  });

  it('keeps tool input: shows the file, folds consecutive reads, and pairs results by id', async () => {
    const t0 = Date.now();
    resetStore(t0);
    transcript.page = vi.fn().mockImplementation(async (_id: string, offset: number) => offset > 0
      ? { events: [], totalEvents: 7 }
      : {
        events: [
          { type: 'assistant', _ts: t0 + 1000, message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/wt/src/one.ts' } }] } },
          { type: 'user', _ts: t0 + 1500, message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } },
          { type: 'assistant', _ts: t0 + 2000, message: { content: [{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/wt/src/two.ts' } }] } },
          { type: 'user', _ts: t0 + 2500, message: { content: [{ type: 'tool_result', tool_use_id: 'b' }] } },
          { type: 'assistant', _ts: t0 + 3000, message: { content: [{ type: 'tool_use', id: 'c', name: 'Edit', input: { file_path: '/wt/src/one.ts' } }] } },
          { type: 'user', _ts: t0 + 4000, message: { content: [{ type: 'tool_result', tool_use_id: 'c' }] } },
          { type: 'assistant', _ts: t0 + 5000, message: { content: [{ type: 'tool_use', id: 'd', name: 'Bash', input: { command: 'npm test' } }] } },
        ],
        totalEvents: 7,
      });
    window.clubhouse.git.diffNumstat = vi.fn().mockResolvedValue([{ path: 'src/one.ts', added: 12, removed: 3, binary: false }]);
    render(<HeadlessAgentView agent={{ ...headlessAgent, runCwd: '/wt', runBaseSha: 'abc123' }} />);
    await flushAsyncWork();

    const fold = screen.getByTestId('timeline-fold');
    expect(fold).toHaveTextContent('Read 2 files');
    expect(fold).toHaveTextContent('one.ts, two.ts');
    expect(fold).toHaveTextContent('0:01');

    const tools = screen.getAllByTestId('timeline-tool');
    expect(tools[0]).toHaveTextContent('Edited');
    expect(tools[0]).toHaveTextContent('one.ts');
    expect(tools[1]).toHaveTextContent('Running');
    expect(tools[1]).toHaveTextContent('npm test');
    expect(tools[1]).toHaveTextContent('running');

    // The files column lists the edited file, with its diff size from numstat against the run's base
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    await flushAsyncWork();
    expect(window.clubhouse.git.diffNumstat).toHaveBeenCalledWith('/wt', 'abc123');
    expect(screen.getByTestId('run-files')).toHaveTextContent('one.ts');
    expect(screen.getByTestId('run-files')).toHaveTextContent('+12');
    expect(screen.getByTestId('run-summary')).toHaveTextContent('Tool calls4');
  });

  it('expands a fold to list each read', async () => {
    transcript.page = vi.fn().mockImplementation(async (_id: string, offset: number) => offset > 0
      ? { events: [], totalEvents: 2 }
      : { events: [
        { type: 'assistant', message: { content: [
          { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'a.ts' } },
          { type: 'tool_use', id: 'b', name: 'Grep', input: { pattern: 'TODO' } },
        ] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }, { type: 'tool_result', tool_use_id: 'b' }] } },
      ], totalEvents: 2 });
    render(<HeadlessAgentView agent={headlessAgent} />);
    await flushAsyncWork();
    fireEvent.click(screen.getByRole('button', { name: /Read 1 file, searched 1/ }));
    expect(screen.getAllByTestId('timeline-tool')).toHaveLength(2);
  });

  it('shows a failed launch in place with the error', () => {
    render(<HeadlessAgentView agent={{ ...headlessAgent, status: 'error', errorMessage: 'claude: command not found' }} />);
    expect(screen.getByTestId('state-word')).toHaveTextContent('Error');
    expect(screen.getByTestId('run-error')).toHaveTextContent('claude: command not found');
    expect(screen.queryByTestId('stop-agent-button')).toBeNull();
  });

  it('stacks the summary column when asked (popouts)', () => {
    render(<HeadlessAgentView agent={headlessAgent} stacked />);
    expect(screen.getByTestId('headless-agent-view')).toHaveAttribute('data-stacked', 'true');
    expect(screen.queryByTestId('run-popout-button')).toBeNull();
  });

  it('opens the transcript inline', () => {
    render(<HeadlessAgentView agent={headlessAgent} />);
    fireEvent.click(screen.getByTestId('run-transcript-button'));
    expect(screen.getByTestId('run-transcript')).toBeInTheDocument();
  });
});
