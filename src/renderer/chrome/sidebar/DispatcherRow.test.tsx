import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DispatcherRow, DispatcherWorkRow } from './DispatcherRow';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStore } from '../../stores/chatStore';
import { DISPATCHER_PROJECT_ID } from '../../../shared/dispatcher-types';
import type { Agent, AgentDetailedStatus } from '../../../shared/types';

/** The Dispatcher's chat agent, as the sidebar gets it. */
const chat = (over: Partial<Agent> = {}): Agent => ({
  id: 'chat', projectId: DISPATCHER_PROJECT_ID, name: 'Dispatcher', kind: 'durable', status: 'running', color: 'indigo', ...over,
} as Agent);

const between: AgentDetailedStatus = { state: 'idle', message: 'Idle', timestamp: 1 };

function dot(): string | null {
  return screen.getByTestId('dispatcher-row').querySelector('[data-dot]')?.getAttribute('data-dot') ?? null;
}

beforeEach(() => {
  useAgentStore.setState({ deleteDialogAgent: null, agentSettingsOpenFor: null, agentSpawnedAt: {} });
});

describe('the Dispatcher\'s row status (#3220)', () => {
  it('shows Working while a request is under way, though its chat is between turns', () => {
    render(<DispatcherRow agent={chat()} detailed={between} requestsUnderWay={1} active={false} onSelect={() => {}} />);
    expect(dot()).toBe('working');
    expect(screen.getAllByLabelText('Working').length).toBeGreaterThan(0);
  });

  it('shows Working while its chat sleeps and a request is under way', () => {
    render(<DispatcherRow agent={chat({ status: 'sleeping' })} requestsUnderWay={2} active={false} onSelect={() => {}} />);
    expect(dot()).toBe('working');
  });

  it('shows Done with nothing under way, and Sleeping when its chat sleeps', () => {
    const { unmount } = render(<DispatcherRow agent={chat()} detailed={between} active={false} onSelect={() => {}} />);
    expect(dot()).toBe('idle');
    unmount();
    render(<DispatcherRow agent={chat({ status: 'sleeping' })} requestsUnderWay={0} active={false} onSelect={() => {}} />);
    expect(dot()).toBe('sleeping');
  });

  it('keeps Needs you over a request under way', () => {
    render(<DispatcherRow agent={chat()} detailed={{ state: 'needs_permission', message: 'Bash', timestamp: 1 }} requestsUnderWay={1} active={false} onSelect={() => {}} />);
    expect(dot()).toBe('needs');
  });
});

describe('the debug controller row (#3220)', () => {
  beforeEach(() => useChatStore.setState({ agents: {} } as never));

  it('shows Sleeping when the controller is asleep, whatever the chat is doing', () => {
    render(<DispatcherWorkRow agentId="coordinator" running={false} active={false} onSelect={() => {}} />);
    expect(screen.getByRole('tree', { name: 'Dispatcher controller (debug)' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: 'Dispatcher controller' })).toBeTruthy();
    expect(screen.getByTestId('dispatcher-work-row').querySelector('[data-dot]')?.getAttribute('data-dot')).toBe('sleeping');
  });
});
