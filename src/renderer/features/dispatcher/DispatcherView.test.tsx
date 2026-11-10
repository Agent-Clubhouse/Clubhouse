import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen, fireEvent, within, waitFor } from '@testing-library/react';

vi.mock('../agents/chat/AgentRuntimePane', () => ({
  AgentRuntimePane: ({ agent }: { agent: { id: string } }) => <div data-testid="runtime-pane">{agent.id}</div>,
}));
vi.mock('../agents/AgentTerminal', () => ({ AgentTerminal: () => null }));
vi.mock('./DispatcherSetup', () => ({ DispatcherSetup: () => <div data-testid="dispatcher-setup-stub" /> }));

import { DISPATCHER_OFF, DISPATCHER_PROJECT_ID } from '../../../shared/dispatcher-types';
import type { Agent } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestrationCards } from '../agents/helpers/OrchestrationCards';
import { DispatcherView } from './DispatcherView';
import { useDispatcherStore } from './dispatcherStore';
import { ClearChatHost, StartFreshHost } from './ClearChat';
import { useDispatcherDebugStore } from './dispatcherDebug';
import { useChatStore } from '../../stores/chatStore';

const dispatcher = (over: Partial<Agent> = {}): Agent =>
  ({ id: 'disp', projectId: DISPATCHER_PROJECT_ID, name: 'Dispatcher', kind: 'durable', status: 'sleeping', color: 'indigo', ...over }) as Agent;

beforeEach(() => {
  useProjectStore.setState({ projects: [], activeProjectId: null });
  useUIStore.setState({ explorerTab: 'agents', dispatcherOpen: true });
  useDispatcherStore.getState().setState({ enabled: true, flagOn: true, agentId: 'disp-work', path: 'dispatcher-work-dir', chatAgentId: 'disp', chatPath: 'dispatcher-dir', config: null });
});
afterEach(() => {
  useDispatcherStore.getState().setState(DISPATCHER_OFF);
  useDispatcherStore.setState({ loadError: null });
});

describe('DispatcherView debug view (#3188)', () => {
  afterEach(() => useDispatcherDebugStore.setState({ on: false, workOpen: false }));

  it('shows its work agent\'s chat, read-only, while the debug view is on and its row chose it', async () => {
    const read = vi.fn(async () => [
      { agentId: 'disp-work', sessionId: 's', seq: 1, ts: 1, type: 'agent_message', data: { messageId: 'a1', text: 'Checking the agents.' } },
    ]);
    const original = window.clubhouse.chat.readTranscript;
    window.clubhouse.chat.readTranscript = read as unknown as typeof original;
    useChatStore.setState({ agents: {}, loading: {}, partial: {}, loaded: {} });
    useAgentStore.setState({ agents: { disp: dispatcher({ status: 'running' }) } });
    useDispatcherDebugStore.setState({ on: true, workOpen: true });
    render(<DispatcherView />);
    const view = screen.getByTestId('dispatcher-work-view');
    expect(view.getAttribute('data-agent-id')).toBe('disp-work');
    expect(screen.getByTestId('dispatcher-work-note').textContent).toContain('Read only');
    expect(await screen.findByText('Checking the agents.')).toBeTruthy();
    expect(read).toHaveBeenCalledWith('disp-work', undefined);
    expect(screen.queryByTestId('runtime-pane')).toBeNull();
    expect(screen.queryByLabelText('Message')).toBeNull();
    window.clubhouse.chat.readTranscript = original;
  });

  it('shows the Dispatcher\'s own chat when the debug view is off, whatever its row last chose', () => {
    useAgentStore.setState({ agents: { disp: dispatcher({ status: 'running' }) } });
    useDispatcherDebugStore.setState({ on: false, workOpen: true });
    render(<DispatcherView />);
    expect(screen.queryByTestId('dispatcher-work-view')).toBeNull();
    expect(screen.getByTestId('runtime-pane').textContent).toBe('disp');
  });
});

describe('DispatcherView', () => {
  it('shows the chat or terminal pane while it runs', () => {
    useAgentStore.setState({ agents: { disp: dispatcher({ status: 'running' }) } });
    render(<DispatcherView />);
    expect(screen.getByTestId('runtime-pane').textContent).toBe('disp');
  });

  it("shows the sleeping view, whose menu leaves out what doesn't apply", () => {
    useAgentStore.setState({ agents: { disp: dispatcher() } });
    render(<DispatcherView />);
    expect(screen.getByTestId('sleeping-agent')).toBeTruthy();
    fireEvent.click(screen.getByTestId('sleeping-more'));
    const menu = screen.getByTestId('agent-context-menu');
    for (const id of ['delete', 'apply-persona', 'extract-persona']) {
      expect(within(menu).queryByTestId(`ctx-${id}`)).toBeNull();
    }
    expect(within(menu).getByTestId('ctx-settings')).toBeTruthy();
    expect(within(menu).getByTestId('ctx-popout')).toBeTruthy();
  });

  it('shows where its chat went while it is popped out, and the chat again once it comes back (#3235)', async () => {
    let popouts = [{ windowId: 7, params: { type: 'agent', agentId: 'disp', projectId: DISPATCHER_PROJECT_ID } }];
    let changed: () => void = () => {};
    const list = vi.spyOn(window.clubhouse.window, 'listPopouts').mockImplementation(async () => popouts as never);
    const onChanged = vi.spyOn(window.clubhouse.window, 'onPopoutsChanged').mockImplementation((cb: () => void) => { changed = cb; return () => {}; });
    useAgentStore.setState({ agents: { disp: dispatcher({ status: 'running' }) } });
    render(<DispatcherView />);
    expect(await screen.findByTestId('popped-out-placeholder')).toBeTruthy();
    expect(screen.queryByTestId('runtime-pane')).toBeNull();
    popouts = [];
    act(() => changed());
    expect(await screen.findByTestId('runtime-pane')).toBeTruthy();
    list.mockRestore();
    onChanged.mockRestore();
  });

  it('still shows setup while its chat is popped out', async () => {
    const list = vi.spyOn(window.clubhouse.window, 'listPopouts').mockResolvedValue([{ windowId: 7, params: { type: 'agent', agentId: 'disp' } }] as never);
    useAgentStore.setState({ agents: { disp: dispatcher({ status: 'running' }) } });
    useDispatcherStore.getState().setState({ ...useDispatcherStore.getState().state!, config: {} as never, setup: { status: 'pending' } as never });
    render(<DispatcherView />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(screen.getByTestId('dispatcher-setup-stub')).toBeTruthy();
    expect(screen.queryByTestId('popped-out-placeholder')).toBeNull();
    list.mockRestore();
  });

  it('offers Clear chat in its menu, which asks first and then starts the conversation over (#3043)', async () => {
    const clearChat = vi.spyOn(window.clubhouse.dispatcher, 'clearChat');
    useAgentStore.setState({ agents: { disp: dispatcher() } });
    render(<><DispatcherView /><ClearChatHost /></>);
    fireEvent.click(screen.getByTestId('sleeping-more'));
    fireEvent.click(within(screen.getByTestId('agent-context-menu')).getByTestId('ctx-clear-chat'));
    const confirm = await waitFor(() => screen.getByTestId('dispatcher-clear-chat-confirm'));
    expect(confirm.textContent).toContain('Dispatcher still remembers');
    expect(clearChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('dispatcher-clear-chat-confirm-button'));
    await waitFor(() => expect(screen.queryByTestId('dispatcher-clear-chat-confirm')).toBeNull());
    expect(clearChat).toHaveBeenCalledTimes(1);
    clearChat.mockRestore();
  });

  it('offers Start fresh in its menu, for its work or both conversations, keeping everything else (#3240)', async () => {
    const startFresh = vi.spyOn(window.clubhouse.dispatcher, 'startFresh').mockResolvedValue({ work: 'next_start' });
    useAgentStore.setState({ agents: { disp: dispatcher() } });
    render(<><DispatcherView /><StartFreshHost /></>);
    fireEvent.click(screen.getByTestId('sleeping-more'));
    fireEvent.click(within(screen.getByTestId('agent-context-menu')).getByTestId('ctx-start-fresh'));
    const confirm = await waitFor(() => screen.getByTestId('dispatcher-start-fresh-confirm'));
    expect(confirm.textContent).toContain('Memory, agents, connections, Actions and settings stay as they are.');
    expect(startFresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('dispatcher-start-fresh-work'));
    await waitFor(() => expect(screen.queryByTestId('dispatcher-start-fresh-confirm')).toBeNull());
    expect(startFresh).toHaveBeenCalledWith('work');

    fireEvent.click(screen.getByTestId('sleeping-more'));
    fireEvent.click(within(screen.getByTestId('agent-context-menu')).getByTestId('ctx-start-fresh'));
    fireEvent.click(await waitFor(() => screen.getByTestId('dispatcher-start-fresh-both')));
    await waitFor(() => expect(startFresh).toHaveBeenCalledWith('both'));
    startFresh.mockRestore();
  });

  it('sends a failed launch to Settings > Dispatcher, not the agent settings view', async () => {
    useAgentStore.setState({ agents: { disp: dispatcher({ status: 'error', errorMessage: 'claude not found' }) }, agentSettingsOpenFor: null });
    render(<DispatcherView />);
    fireEvent.click(await waitFor(() => screen.getByTestId('open-settings-button')));
    expect(useUIStore.getState()).toMatchObject({ explorerTab: 'settings', settingsSubPage: 'dispatcher', dispatcherOpen: false });
    expect(useAgentStore.getState().agentSettingsOpenFor).toBeNull();
  });

  it('has no Orchestrate or Helpers cards, though its folder resolves', () => {
    const { result } = renderHook(() => useOrchestrationCards(dispatcher(), 'dispatcher-dir'));
    expect(result.current).toMatchObject({ orchestrationPath: undefined, showOrchestrate: false, showHelpers: false });
  });

  it('says it is loading until the agent is in the store', () => {
    useAgentStore.setState({ agents: {} });
    render(<DispatcherView />);
    expect(screen.getByRole('status').textContent).toBe('Loading the Dispatcher');
  });

  it('shows a failed load with Retry instead of loading for good (#2557)', () => {
    useAgentStore.setState({ agents: {} });
    useDispatcherStore.getState().setLoadError('disk unavailable');
    render(<DispatcherView />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Couldn’t load the Dispatcher. disk unavailable');
    expect(alert.className).toContain('text-ctp-error');
    const before = useDispatcherStore.getState().loadAttempt;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(useDispatcherStore.getState()).toMatchObject({ loadError: null, loadAttempt: before + 1 });
    expect(screen.getByRole('status').textContent).toBe('Loading the Dispatcher');
  });
});
