import { render, screen } from '@testing-library/react';
import { AgentAvatar, AgentAvatarWithRing } from './AgentAvatar';
import { useAgentStore } from '../../stores/agentStore';
import type { Agent } from '../../../shared/types';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    projectId: 'proj-1',
    name: 'bold-falcon',
    kind: 'durable',
    status: 'sleeping',
    color: 'indigo',
    ...overrides,
  } as Agent;
}

function resetStores() {
  useAgentStore.setState({
    agentIcons: {},
    agentDetailedStatus: {},
  });
}

describe('AgentAvatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('renders without crash', () => {
    render(<AgentAvatar agent={makeAgent()} />);
    expect(screen.getByText('BF')).toBeInTheDocument(); // bold-falcon → BF
  });

  it('renders initials from agent name', () => {
    render(<AgentAvatar agent={makeAgent({ name: 'clever-fox' })} />);
    expect(screen.getByText('CF')).toBeInTheDocument();
  });

  it('renders lightning bolt for quick agents', () => {
    const { container } = render(<AgentAvatar agent={makeAgent({ kind: 'quick' })} />);
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(screen.queryByText('BF')).not.toBeInTheDocument();
  });

  it('renders icon image when available', () => {
    useAgentStore.setState({
      agentIcons: { 'agent-1': 'data:image/png;base64,abc' },
    });

    render(<AgentAvatar agent={makeAgent({ icon: 'custom.png' })} />);
    const img = screen.getByAltText('bold-falcon');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'data:image/png;base64,abc');
  });

  it('falls back to initials when icon name set but data missing', () => {
    render(<AgentAvatar agent={makeAgent({ icon: 'custom.png' })} />);
    expect(screen.getByText('BF')).toBeInTheDocument();
  });

  it('renders with ring when showRing and ringColor are set', () => {
    const { container } = render(
      <AgentAvatar agent={makeAgent()} showRing ringColor="#22c55e" />,
    );
    const ringEl = container.querySelector('[style*="border"]');
    expect(ringEl).toBeInTheDocument();
  });

  it('renders without ring by default', () => {
    const { container } = render(<AgentAvatar agent={makeAgent()} />);
    const ringEls = container.querySelectorAll('[style*="border: 2px"]');
    expect(ringEls.length).toBe(0);
  });

  it('supports sm size', () => {
    const { container } = render(<AgentAvatar agent={makeAgent()} size="sm" />);
    expect(container.querySelector('.w-6')).toBeInTheDocument();
  });

  it('supports md size', () => {
    const { container } = render(<AgentAvatar agent={makeAgent()} size="md" />);
    expect(container.querySelector('.w-7')).toBeInTheDocument();
  });

  it('renders orchestrator mini icon for claude-code agents without custom icon', () => {
    const { container } = render(
      <AgentAvatar agent={makeAgent({ orchestrator: 'claude-code' })} />,
    );
    // Should render SVG mini icon, not initials
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(screen.queryByText('BF')).not.toBeInTheDocument();
  });

  it('renders orchestrator mini icon for copilot-cli agents without custom icon', () => {
    const { container } = render(
      <AgentAvatar agent={makeAgent({ orchestrator: 'copilot-cli' })} />,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(screen.queryByText('BF')).not.toBeInTheDocument();
  });

  it('renders orchestrator mini icon for codex-cli agents without custom icon', () => {
    const { container } = render(
      <AgentAvatar agent={makeAgent({ orchestrator: 'codex-cli' })} />,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(screen.queryByText('BF')).not.toBeInTheDocument();
  });

  it('prefers custom icon over orchestrator mini icon', () => {
    useAgentStore.setState({
      agentIcons: { 'agent-1': 'data:image/png;base64,abc' },
    });
    render(<AgentAvatar agent={makeAgent({ orchestrator: 'claude-code', icon: 'custom.png' })} />);
    const img = screen.getByAltText('bold-falcon');
    expect(img).toBeInTheDocument();
  });

  it('renders initials when no orchestrator and no custom icon', () => {
    render(<AgentAvatar agent={makeAgent()} />);
    expect(screen.getByText('BF')).toBeInTheDocument();
  });
});

describe('AgentAvatarWithRing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
  });

  it('renders without crash', () => {
    render(<AgentAvatarWithRing agent={makeAgent()} />);
    expect(screen.getByText('BF')).toBeInTheDocument();
  });

  it('renders with ring for running agent', () => {
    const { container } = render(
      <AgentAvatarWithRing agent={makeAgent({ status: 'running' })} />,
    );
    // AgentAvatarWithRing passes showRing=true to AgentAvatar, which adds a bordered wrapper
    const styledEl = container.querySelector('[style]');
    expect(styledEl).toBeTruthy();
    expect(styledEl!.getAttribute('style')).toContain('border');
  });

  it('renders with ring for sleeping agent', () => {
    const { container } = render(
      <AgentAvatarWithRing agent={makeAgent({ status: 'sleeping' })} />,
    );
    const styledEl = container.querySelector('[style]');
    expect(styledEl).toBeTruthy();
    expect(styledEl!.getAttribute('style')).toContain('border');
  });

  it('renders with ring for error agent', () => {
    const { container } = render(
      <AgentAvatarWithRing agent={makeAgent({ status: 'error' })} />,
    );
    const styledEl = container.querySelector('[style]');
    expect(styledEl).toBeTruthy();
    expect(styledEl!.getAttribute('style')).toContain('border');
  });

  it('renders amber ring for waking agent', () => {
    const { container } = render(
      <AgentAvatarWithRing agent={makeAgent({ status: 'waking' })} />,
    );
    const styledEl = container.querySelector('[style]');
    expect(styledEl).toBeTruthy();
    // Waking uses amber ring color — rendered as rgb(245, 158, 11) from #f59e0b
    expect(styledEl!.getAttribute('style')).toContain('245, 158, 11');
  });
});
