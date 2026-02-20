import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

function resetStore() {
  useAgentStore.setState({
    agents: { [headlessAgent.id]: headlessAgent },
    killAgent: vi.fn(),
  });
}

describe('HeadlessAgentView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    // Mock IPC calls
    window.clubhouse.agent.onHookEvent = vi.fn(() => vi.fn());
    window.clubhouse.agent.readTranscript = vi.fn().mockResolvedValue('');
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
});
