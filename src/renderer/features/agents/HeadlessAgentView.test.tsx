import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HeadlessAgentView } from './HeadlessAgentView';
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

describe('HeadlessAgentView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetStore();
    // Mock IPC calls
    window.clubhouse.agent.onHookEvent = vi.fn(() => vi.fn());
    window.clubhouse.agent.readTranscript = vi.fn().mockResolvedValue('');
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
