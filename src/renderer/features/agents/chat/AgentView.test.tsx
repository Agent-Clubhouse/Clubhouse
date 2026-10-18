import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Agent } from '../../../../shared/types';
import { useAgentStore } from '../../../stores/agentStore';
import { useChatStore } from '../../../stores/chatStore';
import { resetChatFlagCache } from './AgentRuntimePane';
import { AgentView } from './AgentView';
import { chatFixture, FIXTURE_AGENT_ID } from './fixtures';

vi.mock('../AgentTerminal', () => ({
  AgentTerminal: ({ agentId, zoneThemeId }: { agentId: string; zoneThemeId?: string }) => (
    <div data-testid="agent-terminal" data-agent-id={agentId} data-zone-theme={zoneThemeId} />
  ),
}));

const agent: Agent = {
  id: FIXTURE_AGENT_ID,
  projectId: 'proj-1',
  name: 'gallant-swift',
  kind: 'durable',
  status: 'running',
  color: 'emerald',
  orchestrator: 'codex-cli',
};
const api = window.clubhouse;

describe('AgentView', () => {
  beforeEach(() => {
    resetChatFlagCache();
    useChatStore.setState({ agents: {}, loading: {}, loaded: {} });
    useAgentStore.setState({ agents: { [agent.id]: agent } } as never);
    api.app.getExperimentalSettings = vi.fn(async () => ({ chat: true })) as typeof api.app.getExperimentalSettings;
    api.app.isPreviewEligible = vi.fn(async () => true);
    api.chat.readTranscript = vi.fn(async () => chatFixture('codex', 'conversation'));
  });

  it('shows chat without the runtime switch for an agent running in chat', async () => {
    api.chat.getAgentRuntime = vi.fn(async () => ({ chat: true, chatAvailable: true }));
    render(<AgentView agentId={agent.id} />);
    await screen.findByTestId('chat-view');
    expect(screen.queryByTestId('agent-terminal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('runtime-switch')).not.toBeInTheDocument();
  });

  it('shows the terminal, with its zone theme, for an agent in the terminal', async () => {
    api.chat.getAgentRuntime = vi.fn(async () => ({ chat: false, chatAvailable: true }));
    render(<AgentView agentId={agent.id} zoneThemeId="mocha" />);
    expect(await screen.findByTestId('agent-terminal')).toHaveAttribute('data-zone-theme', 'mocha');
    expect(screen.queryByTestId('terminal-runtime-bar')).not.toBeInTheDocument();
  });

  it('shows the terminal for agents this window does not know, such as remote ones', () => {
    api.chat.getAgentRuntime = vi.fn(async () => ({ chat: true, chatAvailable: true }));
    render(<AgentView agentId="remote||agent-9" />);
    expect(screen.getByTestId('agent-terminal')).toHaveAttribute('data-agent-id', 'remote||agent-9');
    expect(api.chat.getAgentRuntime).not.toHaveBeenCalled();
  });
});
