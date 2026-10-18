import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PoppedOutPlaceholder } from './PoppedOutPlaceholder';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStore, createChatViewState } from '../../stores/chatStore';

describe('PoppedOutPlaceholder', () => {
  beforeEach(() => {
    window.clubhouse.window.focusPopout = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.window.closePopout = vi.fn().mockResolvedValue(undefined);
    useAgentStore.setState({ agents: {}, agentDetailedStatus: {} });
    useChatStore.setState({ agents: {}, live: {} });
  });

  it('names a canvas that is open in its own window', () => {
    render(<PoppedOutPlaceholder type="canvas" name="Design Canvas" windowId={10} />);
    expect(screen.getByText('Design Canvas is open in its own window')).toBeInTheDocument();
    expect(screen.getByTestId('popped-out-placeholder')).toBeInTheDocument();
  });

  it('falls back to the type when there is no name', () => {
    render(<PoppedOutPlaceholder type="agent" windowId={7} />);
    expect(screen.getByText('Agent is open in its own window')).toBeInTheDocument();
  });

  it('shows an agent\'s status and latest line, live', () => {
    useAgentStore.setState({
      agents: { a1: { id: 'a1', name: 'gallant-swift', status: 'running', kind: 'durable', projectId: 'p1', color: 'indigo' } as never },
      agentDetailedStatus: { a1: { state: 'working', message: 'Editing HoverCard.tsx', timestamp: 1 } },
    });
    render(<PoppedOutPlaceholder type="agent" agentId="a1" windowId={3} />);
    expect(screen.getByText('gallant-swift')).toBeInTheDocument();
    expect(screen.getByTestId('popped-out-status')).toHaveTextContent('Working');
    expect(screen.getByTestId('popped-out-latest')).toHaveTextContent('Editing HoverCard.tsx');
  });

  it('shows a chat agent\'s last message and what its session changed', async () => {
    window.clubhouse.chat.getChanges = vi.fn().mockResolvedValue({
      available: true,
      files: [{ path: 'a.ts', status: 'modified', additions: 10, deletions: 2 }, { path: 'b.ts', status: 'added', additions: 8, deletions: 39 }],
    });
    useAgentStore.setState({
      agents: { a1: { id: 'a1', name: 'gallant-swift', status: 'running', kind: 'durable', projectId: 'p1', color: 'indigo' } as never },
    });
    const chat = createChatViewState('a1');
    useChatStore.setState({
      agents: {
        a1: {
          ...chat, sessionId: 's1', state: 'idle',
          items: [{ id: 'm1', sessionId: 's1', seq: 1, ts: 1, kind: 'agent_message', messageId: 'm1', text: 'Looked at it.\nNow updating HoverCard.tsx.', streaming: false }],
        },
      },
      live: { a1: true },
    });
    render(<PoppedOutPlaceholder type="agent" agentId="a1" windowId={3} />);
    expect(screen.getByTestId('popped-out-status')).toHaveTextContent('Done');
    expect(screen.getByTestId('popped-out-latest')).toHaveTextContent('Now updating HoverCard.tsx.');
    await waitFor(() => expect(screen.getByTestId('popped-out-changes')).toHaveTextContent('2 files changed+18 −41'));
    expect(window.clubhouse.chat.getChanges).toHaveBeenCalledWith('a1', { sessionId: 's1' });
  });

  it('"Show window" focuses the popout', () => {
    render(<PoppedOutPlaceholder type="agent" name="Test" windowId={42} />);
    fireEvent.click(screen.getByTestId('popped-out-go-to-window'));
    expect(window.clubhouse.window.focusPopout).toHaveBeenCalledWith(42);
    expect(screen.getByTestId('popped-out-go-to-window')).toHaveTextContent('Show window');
  });

  it('"Pop back in" closes the popout', () => {
    render(<PoppedOutPlaceholder type="canvas" windowId={99} />);
    fireEvent.click(screen.getByTestId('popped-out-close-window'));
    expect(window.clubhouse.window.closePopout).toHaveBeenCalledWith(99);
    expect(screen.getByTestId('popped-out-close-window')).toHaveTextContent('Pop back in');
  });
});
