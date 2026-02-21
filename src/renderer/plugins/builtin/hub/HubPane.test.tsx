import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { HubPane } from './HubPane';
import { createMockAPI } from '../../testing';
import type { AgentInfo, CompletedQuickAgentInfo } from '../../../../shared/plugin-types';
import type { LeafPane } from './pane-tree';

const noop = () => {};

function createTestAPI() {
  return createMockAPI({
    widgets: {
      AgentTerminal: ({ agentId }: { agentId: string }) =>
        React.createElement('div', { 'data-testid': 'agent-terminal' }, `Terminal: ${agentId}`),
      SleepingAgent: ({ agentId }: { agentId: string }) =>
        React.createElement('div', { 'data-testid': 'sleeping-agent' }, `Sleeping: ${agentId}`),
      AgentAvatar: ({ agentId }: { agentId: string }) =>
        React.createElement('div', { 'data-testid': 'avatar' }, agentId),
      QuickAgentGhost: ({ completed }: { completed: CompletedQuickAgentInfo }) =>
        React.createElement('div', { 'data-testid': 'ghost' }, `Ghost: ${completed.name}`),
    },
  });
}

const RUNNING_AGENT: AgentInfo = {
  id: 'agent-1',
  name: 'Builder',
  kind: 'durable',
  status: 'running',
  color: 'emerald',
  projectId: 'proj-1',
};

const SLEEPING_AGENT: AgentInfo = {
  ...RUNNING_AGENT,
  status: 'sleeping',
};

const COMPLETED: CompletedQuickAgentInfo = {
  id: 'quick-1',
  projectId: 'proj-1',
  name: 'Scout',
  mission: 'Find bugs',
  summary: 'Found 3 bugs',
  filesModified: [],
  exitCode: 0,
  completedAt: Date.now(),
};

const BASE_PANE: LeafPane = { type: 'leaf', id: 'pane-1', agentId: null };

const defaultProps = {
  api: createTestAPI(),
  focused: false,
  canClose: false,
  onSplit: noop,
  onClose: noop,
  onSwap: noop,
  onAssign: noop,
  onFocus: noop,
  agents: [] as AgentInfo[],
  detailedStatuses: {},
  completedAgents: [] as CompletedQuickAgentInfo[],
};

describe('HubPane', () => {
  it('running agent renders AgentTerminal widget', () => {
    render(
      <HubPane
        {...defaultProps}
        api={createTestAPI()}
        pane={{ ...BASE_PANE, agentId: 'agent-1' }}
        agents={[RUNNING_AGENT]}
      />,
    );
    expect(screen.getByTestId('agent-terminal')).toBeInTheDocument();
    expect(screen.getByText('Terminal: agent-1')).toBeInTheDocument();
  });

  it('non-running agent renders SleepingAgent widget', () => {
    render(
      <HubPane
        {...defaultProps}
        api={createTestAPI()}
        pane={{ ...BASE_PANE, agentId: 'agent-1' }}
        agents={[SLEEPING_AGENT]}
      />,
    );
    expect(screen.getByTestId('sleeping-agent')).toBeInTheDocument();
    expect(screen.getByText('Sleeping: agent-1')).toBeInTheDocument();
  });

  it('no agent renders picker slot (children)', () => {
    render(
      <HubPane
        {...defaultProps}
        api={createTestAPI()}
        pane={BASE_PANE}
      >
        <div data-testid="picker">Pick an agent</div>
      </HubPane>,
    );
    expect(screen.getByTestId('picker')).toBeInTheDocument();
  });

  it('completed quick agent renders QuickAgentGhost', () => {
    render(
      <HubPane
        {...defaultProps}
        api={createTestAPI()}
        pane={{ ...BASE_PANE, agentId: 'quick-1' }}
        completedAgents={[COMPLETED]}
      />,
    );
    expect(screen.getByTestId('ghost')).toBeInTheDocument();
    expect(screen.getByText('Ghost: Scout')).toBeInTheDocument();
  });

  it('renders pop-out button in expanded chip for assigned agent', () => {
    const { container } = render(
      <HubPane
        {...defaultProps}
        api={createTestAPI()}
        pane={{ ...BASE_PANE, agentId: 'agent-1', projectId: 'proj-1' }}
        agents={[RUNNING_AGENT]}
      />,
    );
    // Hover the pane to expand the floating chip
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    expect(screen.getByTestId('popout-button')).toBeInTheDocument();
  });

  it('pop-out button calls createPopout with correct params', () => {
    const createPopout = vi.fn().mockResolvedValue(1);
    window.clubhouse.window.createPopout = createPopout;

    const { container } = render(
      <HubPane
        {...defaultProps}
        api={createTestAPI()}
        pane={{ ...BASE_PANE, agentId: 'agent-1', projectId: 'proj-1' }}
        agents={[RUNNING_AGENT]}
      />,
    );

    // Hover the pane to expand the floating chip
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    fireEvent.click(screen.getByTestId('popout-button'));
    expect(createPopout).toHaveBeenCalledWith({
      type: 'agent',
      agentId: 'agent-1',
      projectId: 'proj-1',
      title: 'Agent — Builder',
    });
  });
});
