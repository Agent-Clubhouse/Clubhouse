import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { DispatcherRow, DispatcherWorkRow, RemoteDispatcherRow } from './DispatcherRow';
import type { RemoteDispatcherPresence } from '../../../shared/dispatcher-presence';
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

  it('shows Idle with nothing under way, and Sleeping when its chat sleeps', () => {
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

describe('the controller and remote rows\' avatars', () => {
  beforeEach(() => useChatStore.setState({ agents: {} } as never));
  const remote = (over: Partial<RemoteDispatcherPresence> = {}): RemoteDispatcherPresence => ({
    machineId: 'fp1', machineName: 'Mini', address: 'work@fp1', dispatcherName: 'Tael', label: 'Tael on Mini', state: 'online', link: { state: 'active' }, ...over,
  });

  it('shows the local controller with a letter avatar, not an empty circle', () => {
    render(<DispatcherWorkRow agentId="coordinator" running active={false} onSelect={() => {}} />);
    expect(screen.getByTestId('dispatcher-avatar-fallback')).toHaveTextContent('D');
  });

  it('draws a remote Dispatcher from its chat agent and icon', () => {
    render(<RemoteDispatcherRow remote={remote()} chat={chat({ id: 'remote||s1||chat', name: 'Tael', icon: 'x.png' })} iconUrl="data:image/png;base64,AAAA" active={false} showController={false} onSelect={() => {}} />);
    expect(screen.getByTestId('remote-dispatcher-avatar').querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,AAAA');
  });

  it('falls back to the Dispatcher’s letter without a chat, and is still a target', () => {
    const onSelect = vi.fn();
    render(<RemoteDispatcherRow remote={remote({ dispatcherName: null, label: 'Dispatcher on Mini' })} active={false} showController={false} onSelect={onSelect} />);
    expect(screen.getByTestId('dispatcher-avatar-fallback')).toHaveTextContent('D');
    fireEvent.click(screen.getByRole('treeitem', { name: 'Dispatcher on Mini' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('dims an offline Dispatcher and says so, with the controller one level under it only in Debug', () => {
    const { rerender } = render(<RemoteDispatcherRow remote={remote({ state: 'offline' })} active={false} showController={false} onSelect={() => {}} />);
    expect(screen.getByTestId('remote-dispatcher-row')).toHaveClass('opacity-60');
    expect(screen.getByTestId('remote-dispatcher-row')).toHaveTextContent('offline');
    expect(screen.queryByTestId('remote-dispatcher-controller')).toBeNull();
    rerender(<RemoteDispatcherRow remote={remote({ state: 'offline' })} active={false} showController onSelect={() => {}} />);
    const owner = screen.getByRole('treeitem', { name: 'Tael on Mini' });
    const controller = within(screen.getByTestId('remote-dispatcher-controller')).getByRole('treeitem');
    expect(owner).toHaveAttribute('aria-level', '1');
    expect(controller).toHaveAttribute('aria-level', '2');
    expect(controller.style.paddingLeft).toBe('28px');
  });
});

describe('the Dispatcher row on another computer (#3607)', () => {
  it('is named with the full alias and offline state, though the label is short', () => {
    render(<DispatcherRow agent={chat()} detailed={between} active={false} onSelect={() => {}} machine="Studio-Mac-Pr…" machineName="Studio-Mac-Pro-Upstairs-2" offline />);
    expect(screen.getByRole('treeitem', { name: 'Dispatcher on Studio-Mac-Pro-Upstairs-2, offline' })).toBeTruthy();
    expect(screen.getByTestId('agent-row-machine').textContent).toBe('Studio-Mac-Pr…');
  });

  it('keeps the plain name on this computer', () => {
    render(<DispatcherRow agent={chat()} detailed={between} active={false} onSelect={() => {}} />);
    expect(screen.getByRole('treeitem', { name: 'Dispatcher' })).toBeTruthy();
  });
});
