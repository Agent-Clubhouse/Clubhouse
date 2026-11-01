import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, fireEvent, within, waitFor } from '@testing-library/react';

vi.mock('../agents/chat/AgentRuntimePane', () => ({
  AgentRuntimePane: ({ agent }: { agent: { id: string } }) => <div data-testid="runtime-pane">{agent.id}</div>,
}));
vi.mock('../agents/AgentTerminal', () => ({ AgentTerminal: () => null }));

import { DISPATCHER_OFF, DISPATCHER_PROJECT_ID } from '../../../shared/dispatcher-types';
import type { Agent } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestrationCards } from '../agents/helpers/OrchestrationCards';
import { DispatcherView } from './DispatcherView';
import { useDispatcherStore } from './dispatcherStore';

const dispatcher = (over: Partial<Agent> = {}): Agent =>
  ({ id: 'disp', projectId: DISPATCHER_PROJECT_ID, name: 'Dispatcher', kind: 'durable', status: 'sleeping', color: 'indigo', ...over }) as Agent;

beforeEach(() => {
  useProjectStore.setState({ projects: [], activeProjectId: null });
  useUIStore.setState({ explorerTab: 'agents', dispatcherOpen: true });
  useDispatcherStore.getState().setState({ enabled: true, flagOn: true, agentId: 'disp', path: 'dispatcher-dir', config: null });
});
afterEach(() => {
  useDispatcherStore.getState().setState(DISPATCHER_OFF);
  useDispatcherStore.setState({ loadError: null });
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
    for (const id of ['delete', 'apply-persona', 'extract-persona', 'popout']) {
      expect(within(menu).queryByTestId(`ctx-${id}`)).toBeNull();
    }
    expect(within(menu).getByTestId('ctx-settings')).toBeTruthy();
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
