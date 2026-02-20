import { render, screen } from '@testing-library/react';
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

function renderItem(agentOverrides: Partial<Agent> = {}) {
  const agent = { ...baseAgent, ...agentOverrides };
  resetStores(agentOverrides);
  return render(
    <AgentListItem agent={agent} isActive={false} isThinking={false} onSelect={vi.fn()} />,
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
