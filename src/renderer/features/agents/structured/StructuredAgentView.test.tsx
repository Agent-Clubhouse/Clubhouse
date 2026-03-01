import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StructuredAgentView, MAX_EVENTS } from './StructuredAgentView';
import { useAgentStore } from '../../../stores/agentStore';
import type { StructuredEvent } from '../../../../shared/structured-events';

const AGENT_ID = 'struct-1';

function resetStore(spawnedAt?: number) {
  useAgentStore.setState({
    agents: {
      [AGENT_ID]: {
        id: AGENT_ID,
        projectId: 'proj-1',
        name: 'test-agent',
        kind: 'durable' as const,
        status: 'running' as const,
        color: 'blue',
        executionMode: 'structured' as const,
      },
    },
    agentSpawnedAt: spawnedAt != null ? { [AGENT_ID]: spawnedAt } : {},
    killAgent: vi.fn(),
  });
}

type EventCallback = (agentId: string, event: { type: string; timestamp: number; data: unknown }) => void;

function setupEventSource(): { emit: (event: StructuredEvent) => void } {
  let callback: EventCallback = () => {};
  window.clubhouse.agent.onStructuredEvent = vi.fn((cb: EventCallback) => {
    callback = cb;
    return vi.fn(); // unsubscribe
  });
  return {
    emit: (event: StructuredEvent) => {
      callback(AGENT_ID, event as unknown as { type: string; timestamp: number; data: unknown });
    },
  };
}

describe('StructuredAgentView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetStore();
    window.clubhouse.agent.onStructuredEvent = vi.fn(() => vi.fn());
    window.clubhouse.agent.cancelStructured = vi.fn();
    window.clubhouse.agent.sendStructuredMessage = vi.fn();
    window.clubhouse.agent.respondPermission = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the structured agent view container', () => {
    render(<StructuredAgentView agentId={AGENT_ID} />);
    expect(screen.getByTestId('structured-agent-view')).toBeInTheDocument();
  });

  it('subscribes to structured events on mount', () => {
    render(<StructuredAgentView agentId={AGENT_ID} />);
    expect(window.clubhouse.agent.onStructuredEvent).toHaveBeenCalled();
  });

  it('shows starting indicator when no events yet', () => {
    render(<StructuredAgentView agentId={AGENT_ID} />);
    expect(screen.getByText('Starting agent...')).toBeInTheDocument();
  });

  it('shows elapsed timer', () => {
    resetStore(Date.now() - 45_000);
    render(<StructuredAgentView agentId={AGENT_ID} />);
    expect(screen.getByText('45s')).toBeInTheDocument();
  });

  it('shows action bar with stop button', () => {
    render(<StructuredAgentView agentId={AGENT_ID} />);
    expect(screen.getByTestId('action-bar')).toBeInTheDocument();
    expect(screen.getByTestId('stop-button')).toBeInTheDocument();
  });

  it('shows message input', () => {
    render(<StructuredAgentView agentId={AGENT_ID} />);
    expect(screen.getByTestId('message-input')).toBeInTheDocument();
  });

  // ── Event processing ────────────────────────────────────────────────

  it('renders text_delta events as streaming text', () => {
    const { emit } = setupEventSource();
    render(<StructuredAgentView agentId={AGENT_ID} />);

    act(() => {
      emit({ type: 'text_delta', timestamp: Date.now(), data: { text: 'Hello ' } });
      emit({ type: 'text_delta', timestamp: Date.now(), data: { text: 'World' } });
    });

    expect(screen.getByTestId('message-stream')).toBeInTheDocument();
    expect(screen.getByText(/Hello World/)).toBeInTheDocument();
  });

  it('merges consecutive text_delta events into one MessageStream', () => {
    const { emit } = setupEventSource();
    render(<StructuredAgentView agentId={AGENT_ID} />);

    act(() => {
      emit({ type: 'text_delta', timestamp: Date.now(), data: { text: 'a' } });
      emit({ type: 'text_delta', timestamp: Date.now(), data: { text: 'b' } });
      emit({ type: 'text_delta', timestamp: Date.now(), data: { text: 'c' } });
    });

    // Should be one MessageStream, not three
    const streams = screen.getAllByTestId('message-stream');
    expect(streams.length).toBe(1);
  });

  it('finalizes text on text_done', () => {
    const { emit } = setupEventSource();
    render(<StructuredAgentView agentId={AGENT_ID} />);

    act(() => {
      emit({ type: 'text_delta', timestamp: Date.now(), data: { text: 'partial' } });
      emit({ type: 'text_done', timestamp: Date.now(), data: { text: 'Final text' } });
    });

    expect(screen.getByText(/Final text/)).toBeInTheDocument();
  });

  it('renders tool lifecycle: start → output → end', () => {
    const { emit } = setupEventSource();
    render(<StructuredAgentView agentId={AGENT_ID} />);

    act(() => {
      emit({
        type: 'tool_start',
        timestamp: Date.now(),
        data: { id: 't1', name: 'Read', displayVerb: 'Reading file', input: { file_path: 'src/foo.ts' } },
      });
    });

    expect(screen.getByTestId('tool-card')).toBeInTheDocument();
    expect(screen.getByText('Reading file')).toBeInTheDocument();
    expect(screen.getByText('src/foo.ts')).toBeInTheDocument();

    act(() => {
      emit({
        type: 'tool_output',
        timestamp: Date.now(),
        data: { id: 't1', output: 'file contents here', isPartial: false },
      });
    });

    expect(screen.getByTestId('tool-output')).toBeInTheDocument();
    expect(screen.getByText('file contents here')).toBeInTheDocument();

    act(() => {
      emit({
        type: 'tool_end',
        timestamp: Date.now(),
        data: { id: 't1', name: 'Read', result: 'ok', durationMs: 120, status: 'success' },
      });
    });

    expect(screen.getByText('120ms')).toBeInTheDocument();
  });

  it('renders tool error state', () => {
    const { emit } = setupEventSource();
    render(<StructuredAgentView agentId={AGENT_ID} />);

    act(() => {
      emit({
        type: 'tool_start',
        timestamp: Date.now(),
        data: { id: 't2', name: 'Bash', displayVerb: 'Running command', input: { command: 'ls' } },
      });
      emit({
        type: 'tool_end',
        timestamp: Date.now(),
        data: { id: 't2', name: 'Bash', result: 'command failed', durationMs: 50, status: 'error' },
      });
    });

    const card = screen.getByTestId('tool-card');
    expect(card.dataset.toolStatus).toBe('error');
  });

  it('renders permission banners and handles approve', () => {
    const { emit } = setupEventSource();
    render(<StructuredAgentView agentId={AGENT_ID} />);

    act(() => {
      emit({
        type: 'permission_request',
        timestamp: Date.now(),
        data: {
          id: 'perm1',
          toolName: 'Bash',
          toolInput: { command: 'rm -rf node_modules' },
          description: 'Execute shell command',
        },
      });
    });

    expect(screen.getByTestId('permission-banner')).toBeInTheDocument();
    expect(screen.getByText('Bash')).toBeInTheDocument();

    // Approve
    act(() => {
      fireEvent.click(screen.getByTestId('permission-approve'));
    });

    expect(window.clubhouse.agent.respondPermission).toHaveBeenCalledWith(AGENT_ID, 'perm1', true);
    // Banner should be removed
    expect(screen.queryByTestId('permission-banner')).not.toBeInTheDocument();
  });

  it('renders file diffs', () => {
    const { emit } = setupEventSource();
    render(<StructuredAgentView agentId={AGENT_ID} />);

    act(() => {
      emit({
        type: 'file_diff',
        timestamp: Date.now(),
        data: {
          path: 'src/main.ts',
          changeType: 'modify',
          diff: '@@ -1,3 +1,3 @@\n-old line\n+new line\n context',
        },
      });
    });

    expect(screen.getByTestId('file-diff-viewer')).toBeInTheDocument();
    expect(screen.getByText('src/main.ts')).toBeInTheDocument();
  });

  it('renders command output', () => {
    const { emit } = setupEventSource();
    render(<StructuredAgentView agentId={AGENT_ID} />);

    act(() => {
      emit({
        type: 'command_output',
        timestamp: Date.now(),
        data: {
          id: 'cmd1',
          command: 'npm test',
          status: 'running',
          output: 'PASS test.ts',
        },
      });
    });

    expect(screen.getByTestId('command-output-panel')).toBeInTheDocument();
    expect(screen.getByText('npm test')).toBeInTheDocument();
  });

  it('updates command output in-place on subsequent events', () => {
    const { emit } = setupEventSource();
    render(<StructuredAgentView agentId={AGENT_ID} />);

    act(() => {
      emit({
        type: 'command_output',
        timestamp: Date.now(),
        data: { id: 'cmd1', command: 'npm test', status: 'running', output: 'line 1' },
      });
    });

    act(() => {
      emit({
        type: 'command_output',
        timestamp: Date.now(),
        data: { id: 'cmd1', command: 'npm test', status: 'completed', output: 'line 1\nline 2', exitCode: 0 },
      });
    });

    // Only one command panel
    const panels = screen.getAllByTestId('command-output-panel');
    expect(panels.length).toBe(1);
    expect(screen.getByText('exit 0')).toBeInTheDocument();
  });

  it('renders thinking panels collapsed by default', () => {
    const { emit } = setupEventSource();
    render(<StructuredAgentView agentId={AGENT_ID} />);

    act(() => {
      emit({
        type: 'thinking',
        timestamp: Date.now(),
        data: { text: 'I should read the file first...', isPartial: false },
      });
    });

    expect(screen.getByTestId('thinking-panel')).toBeInTheDocument();
    expect(screen.getByText('Thought')).toBeInTheDocument();
    // The thinking text should not be visible until expanded
    expect(screen.queryByText('I should read the file first...')).not.toBeInTheDocument();
  });

  it('renders plan progress in sticky header', () => {
    const { emit } = setupEventSource();
    render(<StructuredAgentView agentId={AGENT_ID} />);

    act(() => {
      emit({
        type: 'plan_update',
        timestamp: Date.now(),
        data: {
          steps: [
            { description: 'Read config', status: 'completed' },
            { description: 'Update endpoint', status: 'in_progress' },
            { description: 'Run tests', status: 'pending' },
          ],
        },
      });
    });

    // Plan should appear in the sticky area (outside event-feed)
    const planElements = screen.getAllByTestId('plan-progress');
    expect(planElements.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('1/3 complete')).toBeInTheDocument();
  });

  it('renders error banners', () => {
    const { emit } = setupEventSource();
    render(<StructuredAgentView agentId={AGENT_ID} />);

    act(() => {
      emit({
        type: 'error',
        timestamp: Date.now(),
        data: { code: 'RATE_LIMIT', message: 'Too many requests' },
      });
    });

    expect(screen.getByTestId('error-banner')).toBeInTheDocument();
    expect(screen.getByText('RATE_LIMIT')).toBeInTheDocument();
    expect(screen.getByText('Too many requests')).toBeInTheDocument();
  });

  it('accumulates usage across turns', () => {
    const { emit } = setupEventSource();
    render(<StructuredAgentView agentId={AGENT_ID} />);

    act(() => {
      emit({
        type: 'usage',
        timestamp: Date.now(),
        data: { inputTokens: 1000, outputTokens: 500, costUsd: 0.003 },
      });
    });

    expect(screen.getByTestId('cost-tracker')).toBeInTheDocument();

    act(() => {
      emit({
        type: 'usage',
        timestamp: Date.now(),
        data: { inputTokens: 500, outputTokens: 200, costUsd: 0.001 },
      });
    });

    // Tokens should be accumulated: 1500 input, 700 output
    expect(screen.getByText(/1.5k/)).toBeInTheDocument();
  });

  it('shows end summary on session complete', () => {
    const { emit } = setupEventSource();
    render(<StructuredAgentView agentId={AGENT_ID} />);

    act(() => {
      emit({
        type: 'end',
        timestamp: Date.now(),
        data: { reason: 'complete', summary: 'All tasks done!' },
      });
    });

    expect(screen.getByTestId('end-summary')).toBeInTheDocument();
    expect(screen.getByText('Session completed')).toBeInTheDocument();
    expect(screen.getByText(/All tasks done/)).toBeInTheDocument();
  });

  it('hides stop button and message input when complete', () => {
    const { emit } = setupEventSource();
    render(<StructuredAgentView agentId={AGENT_ID} />);

    act(() => {
      emit({ type: 'end', timestamp: Date.now(), data: { reason: 'complete' } });
    });

    expect(screen.queryByTestId('stop-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('message-input')).not.toBeInTheDocument();
  });

  // ── Action bar interactions ─────────────────────────────────────────

  it('calls cancelStructured and killAgent when stop is clicked', () => {
    render(<StructuredAgentView agentId={AGENT_ID} />);

    act(() => {
      fireEvent.click(screen.getByTestId('stop-button'));
    });

    expect(window.clubhouse.agent.cancelStructured).toHaveBeenCalledWith(AGENT_ID);
    expect(useAgentStore.getState().killAgent).toHaveBeenCalledWith(AGENT_ID);
  });

  it('sends message via IPC when Enter is pressed', () => {
    render(<StructuredAgentView agentId={AGENT_ID} />);

    const input = screen.getByTestId('message-input');
    act(() => {
      fireEvent.change(input, { target: { value: 'Hello agent' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(window.clubhouse.agent.sendStructuredMessage).toHaveBeenCalledWith(AGENT_ID, 'Hello agent');
  });

  it('does not send empty messages', () => {
    render(<StructuredAgentView agentId={AGENT_ID} />);

    const input = screen.getByTestId('message-input');
    act(() => {
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(window.clubhouse.agent.sendStructuredMessage).not.toHaveBeenCalled();
  });

  // ── Feed cap ────────────────────────────────────────────────────────

  it('caps feed items at MAX_EVENTS', () => {
    const { emit } = setupEventSource();
    render(<StructuredAgentView agentId={AGENT_ID} />);

    act(() => {
      for (let i = 0; i < MAX_EVENTS + 50; i++) {
        emit({
          type: 'tool_start',
          timestamp: Date.now(),
          data: { id: `t-${i}`, name: 'Read', displayVerb: `Tool ${i}`, input: {} },
        });
      }
    });

    const cards = screen.getAllByTestId('tool-card');
    expect(cards.length).toBeLessThanOrEqual(MAX_EVENTS);
  });
});
