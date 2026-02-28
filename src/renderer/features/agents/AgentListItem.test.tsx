import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentListItem } from './AgentListItem';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import type { Agent } from '../../../shared/types';

const baseAgent: Agent = {
  id: 'agent-1',
  projectId: 'proj-1',
  name: 'bold-falcon',
  kind: 'durable',
  status: 'sleeping',
  color: 'indigo',
};

function resetStores(agentOverrides: Partial<Agent> = {}) {
  const agent = { ...baseAgent, ...agentOverrides };
  useAgentStore.setState({
    agents: { [agent.id]: agent },
    activeAgentId: agent.id,
    agentIcons: {},
    agentDetailedStatus: {},
    killAgent: vi.fn(),
    removeAgent: vi.fn(),
    spawnDurableAgent: vi.fn(),
    openAgentSettings: vi.fn(),
    openDeleteDialog: vi.fn(),
  });
  useProjectStore.setState({
    projects: [{ id: 'proj-1', name: 'test-project', path: '/project' }],
    activeProjectId: 'proj-1',
  });
  useOrchestratorStore.setState({
    enabled: ['claude-code'],
    allOrchestrators: [{
      id: 'claude-code',
      displayName: 'Claude Code',
      shortName: 'CC',
      capabilities: { headless: true, structuredOutput: true, hooks: true, sessionResume: true, permissions: true },
    }],
  });
}

function renderItem(agentOverrides: Partial<Agent> = {}, props: Partial<{ onSpawnQuickChild: () => void }> = {}) {
  const agent = { ...baseAgent, ...agentOverrides };
  resetStores(agentOverrides);
  return render(
    <AgentListItem agent={agent} isActive={false} isThinking={false} onSelect={vi.fn()} {...props} />,
  );
}

describe('AgentListItem activity animation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not apply animation classes when agent is sleeping', () => {
    const { container } = renderItem({ status: 'sleeping' });
    const avatarWrapper = container.querySelector('[class*="flex-shrink-0"]');
    expect(avatarWrapper?.className).not.toContain('animate-pulse-ring');
    expect(avatarWrapper?.className).not.toContain('animate-headless-orbit');
  });

  it('applies animate-pulse-ring when agent is working', () => {
    resetStores({ status: 'running' });
    useAgentStore.setState({
      agentDetailedStatus: { 'agent-1': { state: 'working', message: 'Thinking...' } },
    });
    const agent = { ...baseAgent, status: 'running' as const };
    const { container } = render(
      <AgentListItem agent={agent} isActive={false} isThinking={true} onSelect={vi.fn()} />,
    );
    const avatarWrapper = container.querySelector('[class*="flex-shrink-0"]');
    expect(avatarWrapper?.className).toContain('animate-pulse-ring');
  });

  it('does not use headless-orbit for headless running agents', () => {
    resetStores({ status: 'running', headless: true });
    useAgentStore.setState({
      agentDetailedStatus: { 'agent-1': { state: 'working', message: 'Processing...' } },
    });
    const agent = { ...baseAgent, status: 'running' as const, headless: true };
    const { container } = render(
      <AgentListItem agent={agent} isActive={false} isThinking={true} onSelect={vi.fn()} />,
    );
    const avatarWrapper = container.querySelector('[class*="flex-shrink-0"]');
    // Should use pulse-ring, not headless-orbit
    expect(avatarWrapper?.className).toContain('animate-pulse-ring');
    expect(avatarWrapper?.className).not.toContain('animate-headless-orbit');
  });

  it('applies pulse-ring consistently for both durable and quick working agents', () => {
    resetStores({ status: 'running', kind: 'quick' });
    const agent = { ...baseAgent, status: 'running' as const, kind: 'quick' as const };
    const { container } = render(
      <AgentListItem agent={agent} isActive={false} isThinking={true} onSelect={vi.fn()} />,
    );
    const avatarWrapper = container.querySelector('[class*="flex-shrink-0"]');
    expect(avatarWrapper?.className).toContain('animate-pulse-ring');
  });
});

describe('AgentListItem actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.window.createPopout = vi.fn().mockResolvedValue(1);
  });

  it('renders pop-out action button for sleeping durable agent', () => {
    renderItem({ status: 'sleeping' });
    expect(screen.getByTestId('action-popout')).toBeInTheDocument();
  });

  it('renders pop-out action button for running agent', () => {
    renderItem({ status: 'running' });
    expect(screen.getByTestId('action-popout')).toBeInTheDocument();
  });

  it('renders pop-out action button for quick agent', () => {
    renderItem({ status: 'running', kind: 'quick' });
    expect(screen.getByTestId('action-popout')).toBeInTheDocument();
  });

  it('calls createPopout when pop-out button is clicked', () => {
    renderItem({ status: 'sleeping' });
    fireEvent.click(screen.getByTestId('action-popout'));
    expect(window.clubhouse.window.createPopout).toHaveBeenCalledWith({
      type: 'agent',
      agentId: 'agent-1',
      projectId: 'proj-1',
      title: 'Agent — bold-falcon',
    });
  });

  it('renders wake button for sleeping durable agent', () => {
    renderItem({ status: 'sleeping' });
    expect(screen.getByTestId('action-wake')).toBeInTheDocument();
  });

  it('renders wake-resume button for sleeping durable agent', () => {
    renderItem({ status: 'sleeping' });
    expect(screen.getByTestId('action-wake-resume')).toBeInTheDocument();
  });

  it('renders stop button for running agent', () => {
    renderItem({ status: 'running' });
    expect(screen.getByTestId('action-stop')).toBeInTheDocument();
  });

  it('renders delete button for sleeping durable agent', () => {
    renderItem({ status: 'sleeping' });
    expect(screen.getByTestId('action-delete')).toBeInTheDocument();
  });

  it('renders settings button for durable agent', () => {
    renderItem({ status: 'sleeping' });
    expect(screen.getByTestId('action-settings')).toBeInTheDocument();
  });

  it('renders spawn button when onSpawnQuickChild is provided', () => {
    renderItem({ status: 'sleeping' }, { onSpawnQuickChild: vi.fn() });
    expect(screen.getByTestId('action-spawn')).toBeInTheDocument();
  });

  it('does not render spawn button when onSpawnQuickChild is not provided', () => {
    renderItem({ status: 'sleeping' });
    expect(screen.queryByTestId('action-spawn')).toBeNull();
  });
});

describe('AgentListItem context menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.window.createPopout = vi.fn().mockResolvedValue(1);
  });

  it('opens context menu on right-click', () => {
    renderItem({ status: 'sleeping' });
    const row = screen.getByTestId('agent-item-agent-1');
    fireEvent.contextMenu(row);
    expect(screen.getByTestId('agent-context-menu')).toBeInTheDocument();
  });

  it('context menu shows all available actions including Wake & Resume', () => {
    renderItem({ status: 'sleeping' }, { onSpawnQuickChild: vi.fn() });
    const row = screen.getByTestId('agent-item-agent-1');
    fireEvent.contextMenu(row);

    expect(screen.getByTestId('ctx-wake')).toBeInTheDocument();
    expect(screen.getByTestId('ctx-wake-resume')).toBeInTheDocument();
    expect(screen.getByTestId('ctx-popout')).toBeInTheDocument();
    expect(screen.getByTestId('ctx-spawn')).toBeInTheDocument();
    expect(screen.getByTestId('ctx-settings')).toBeInTheDocument();
    expect(screen.getByTestId('ctx-delete')).toBeInTheDocument();
  });

  it('context menu calls createPopout when Pop Out is clicked', () => {
    renderItem({ status: 'sleeping' });
    const row = screen.getByTestId('agent-item-agent-1');
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByTestId('ctx-popout'));
    expect(window.clubhouse.window.createPopout).toHaveBeenCalledWith({
      type: 'agent',
      agentId: 'agent-1',
      projectId: 'proj-1',
      title: 'Agent — bold-falcon',
    });
  });

  it('context menu closes after clicking an action', () => {
    renderItem({ status: 'sleeping' });
    const row = screen.getByTestId('agent-item-agent-1');
    fireEvent.contextMenu(row);
    expect(screen.getByTestId('agent-context-menu')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ctx-popout'));
    expect(screen.queryByTestId('agent-context-menu')).toBeNull();
  });

  it('context menu closes on escape', () => {
    renderItem({ status: 'sleeping' });
    const row = screen.getByTestId('agent-item-agent-1');
    fireEvent.contextMenu(row);
    expect(screen.getByTestId('agent-context-menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('agent-context-menu')).toBeNull();
  });

  it('does not show wake-resume in context menu for running agents', () => {
    renderItem({ status: 'running' });
    const row = screen.getByTestId('agent-item-agent-1');
    fireEvent.contextMenu(row);
    expect(screen.queryByTestId('ctx-wake-resume')).toBeNull();
  });
});
