import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openNewQuickAgent } from './startPage';
import { useChromeFlagStore } from './chromeFlag';
import { useChromeStore } from './chromeStore';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';

beforeEach(() => {
  useUIStore.setState({ explorerTab: 'plugin:files', activeHostId: null, quickAgentDialogOpen: false, projectExplorerTab: {} });
  useProjectStore.setState({ projects: [{ id: 'p1', name: 'a', path: '/a' }, { id: 'p2', name: 'b', path: '/b' }] as never, activeProjectId: 'p2' });
  useChromeStore.setState({ projectScopeId: null, composerRequest: 0, lastProjectId: null });
  useQuickAgentStore.setState({ selectedCompletedId: 'q1' });
});

afterEach(() => useChromeFlagStore.setState({ enabled: false }));

describe('openNewQuickAgent (⌘⇧N)', () => {
  it('opens the Quick Agent dialog in the legacy shell', () => {
    openNewQuickAgent();
    expect(useUIStore.getState().quickAgentDialogOpen).toBe(true);
    expect(useChromeStore.getState().composerRequest).toBe(0);
  });

  it('opens the start page composer for the selected project in the new shell', () => {
    useChromeFlagStore.setState({ enabled: true });
    openNewQuickAgent();
    expect(useUIStore.getState()).toMatchObject({ explorerTab: 'agents', quickAgentDialogOpen: false });
    expect(useChromeStore.getState()).toMatchObject({ projectScopeId: 'p2', composerRequest: 1 });
    expect(useQuickAgentStore.getState().selectedCompletedId).toBeNull();
  });

  it('falls back to the last project when none is selected', () => {
    useChromeFlagStore.setState({ enabled: true });
    useProjectStore.setState({ activeProjectId: null });
    useChromeStore.setState({ lastProjectId: 'p1' });
    openNewQuickAgent();
    expect(useProjectStore.getState().activeProjectId).toBe('p1');
    expect(useChromeStore.getState().projectScopeId).toBe('p1');
  });

  it('keeps the dialog on a satellite host or with no projects', () => {
    useChromeFlagStore.setState({ enabled: true });
    useUIStore.setState({ activeHostId: 'sat-1' });
    openNewQuickAgent();
    expect(useUIStore.getState().quickAgentDialogOpen).toBe(true);

    useUIStore.setState({ activeHostId: null, quickAgentDialogOpen: false });
    useProjectStore.setState({ projects: [], activeProjectId: null });
    openNewQuickAgent();
    expect(useUIStore.getState().quickAgentDialogOpen).toBe(true);
  });
});
