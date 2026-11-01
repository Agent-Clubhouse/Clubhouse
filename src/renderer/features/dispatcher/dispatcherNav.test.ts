import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DISPATCHER_OFF, DISPATCHER_PROJECT_ID } from '../../../shared/dispatcher-types';
import { useUIStore } from '../../stores/uiStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useToastStore } from '../../stores/toastStore';
import { openAgent } from '../agents/helpers/orchestration-hooks';
import { handleProtocolAction } from '../../app-event-bridge';
import { closeDispatcher, openDispatcher, openDispatcherSettings } from './dispatcherNav';
import { useDispatcherStore } from './dispatcherStore';

beforeEach(() => {
  useUIStore.setState({ explorerTab: 'agents', dispatcherOpen: false, previousExplorerTab: null });
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'Clubhouse', path: 'clubhouse-dir' }] as never, activeProjectId: 'p1' });
  useAgentStore.setState({ activeAgentId: 'a1', agentSettingsOpenFor: null });
  useDispatcherStore.getState().setState({ enabled: true, flagOn: true, agentId: 'disp', path: 'dispatcher-dir', config: null });
});
afterEach(() => useDispatcherStore.getState().setState(DISPATCHER_OFF));

describe('dispatcherNav', () => {
  it('opens the view without touching the active project or agent, and closes it', () => {
    openDispatcher();
    expect(useUIStore.getState().dispatcherOpen).toBe(true);
    expect(useProjectStore.getState().activeProjectId).toBe('p1');
    expect(useAgentStore.getState().activeAgentId).toBe('a1');
    closeDispatcher();
    expect(useUIStore.getState().dispatcherOpen).toBe(false);
  });

  it('does nothing while the Dispatcher is off', () => {
    useDispatcherStore.getState().setState(DISPATCHER_OFF);
    openDispatcher();
    expect(useUIStore.getState().dispatcherOpen).toBe(false);
  });

  it('leaves an app view for the Agents tab', () => {
    useUIStore.setState({ explorerTab: 'plugin:app:canvas' });
    openDispatcher();
    expect(useUIStore.getState()).toMatchObject({ explorerTab: 'agents', dispatcherOpen: true });
  });

  it('links to Settings > Dispatcher', () => {
    openDispatcher();
    openDispatcherSettings();
    expect(useUIStore.getState()).toMatchObject({ explorerTab: 'settings', settingsContext: 'app', settingsSubPage: 'dispatcher', dispatcherOpen: false });
  });

  it("opens the Dispatcher's view for its wires and mentions (openAgent), and closes it for any other agent", () => {
    openAgent(DISPATCHER_PROJECT_ID, 'disp');
    expect(useUIStore.getState().dispatcherOpen).toBe(true);
    expect(useProjectStore.getState().activeProjectId).toBe('p1');
    openAgent('p1', 'a2');
    expect(useUIStore.getState().dispatcherOpen).toBe(false);
    expect(useAgentStore.getState().activeAgentId).toBe('a2');
  });

  it("won't make the synthetic id the active project for a file open", () => {
    useToastStore.setState({ toasts: [] });
    handleProtocolAction({ kind: 'open-file', projectId: DISPATCHER_PROJECT_ID, relativePath: 'notes.md' });
    expect(useProjectStore.getState().activeProjectId).toBe('p1');
    expect(useToastStore.getState().toasts.at(-1)?.message).toContain('notes.md');
  });
});
