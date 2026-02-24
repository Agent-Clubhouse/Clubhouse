import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock stores before importing hook
const mockSetActiveProject = vi.fn();
const mockSetActiveAgent = vi.fn();
const mockSetExplorerTab = vi.fn();
const mockToggleSettings = vi.fn();
const mockSetSettingsSubPage = vi.fn();
const mockSetSettingsContext = vi.fn();
const mockToggleHelp = vi.fn();
const mockOpenAbout = vi.fn();
const mockToggleExplorerCollapse = vi.fn();
const mockToggleAccessoryCollapse = vi.fn();
const mockSaveAnnexSettings = vi.fn();
const mockOpenQuickAgentDialog = vi.fn();
const mockPickAndAddProject = vi.fn();

const projectStoreState = {
  projects: [
    { id: 'p1', name: 'TestProject', path: '/test', displayName: 'Test' },
    { id: 'p2', name: 'OtherProject', path: '/other', displayName: 'Other' },
  ],
  setActiveProject: mockSetActiveProject,
  activeProjectId: 'p1' as string | null,
};

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: Object.assign(
    (selector: any) => selector(projectStoreState),
    { getState: () => ({ pickAndAddProject: mockPickAndAddProject }) },
  ),
}));

vi.mock('../../stores/agentStore', () => ({
  useAgentStore: (selector: any) => selector({
    agents: { 'a1': { id: 'a1', projectId: 'p1', kind: 'durable', name: 'TestAgent' } },
    setActiveAgent: mockSetActiveAgent,
  }),
}));

const uiStoreState = {
  explorerTab: 'agents' as string,
  setExplorerTab: mockSetExplorerTab,
  toggleSettings: mockToggleSettings,
  setSettingsSubPage: mockSetSettingsSubPage,
  setSettingsContext: mockSetSettingsContext,
  toggleHelp: mockToggleHelp,
  openAbout: mockOpenAbout,
  openQuickAgentDialog: mockOpenQuickAgentDialog,
};

vi.mock('../../stores/uiStore', () => ({
  useUIStore: Object.assign(
    (selector: any) => selector(uiStoreState),
    { getState: () => uiStoreState },
  ),
}));

vi.mock('../../stores/panelStore', () => ({
  usePanelStore: (selector: any) => selector({
    toggleExplorerCollapse: mockToggleExplorerCollapse,
    toggleAccessoryCollapse: mockToggleAccessoryCollapse,
  }),
}));

vi.mock('../../plugins/plugin-store', () => ({
  usePluginStore: (selector: any) => selector({ plugins: {}, projectEnabled: {} }),
}));

vi.mock('../../stores/keyboardShortcutsStore', () => ({
  useKeyboardShortcutsStore: (selector: any) => selector({ shortcuts: {} }),
  formatBinding: (b: string) => b,
}));

const annexState = {
  settings: { enabled: false, deviceName: '' },
  status: { advertising: false, port: 0, pin: '', connectedCount: 0 },
  saveSettings: mockSaveAnnexSettings,
};

vi.mock('../../stores/annexStore', () => ({
  useAnnexStore: Object.assign(
    (selector: any) => selector(annexState),
    { getState: () => annexState },
  ),
}));

const mockSetProjectActiveHub = vi.fn();
const mockSetAppActiveHub = vi.fn();

const projectHubState = {
  hubs: [{ id: 'ph1', name: 'ProjectHub1' }] as any[],
  activeHubId: 'ph1',
  setActiveHub: mockSetProjectActiveHub,
};

const appHubState = {
  hubs: [{ id: 'ah1', name: 'AppHub1' }, { id: 'ah2', name: 'AppHub2' }] as any[],
  activeHubId: 'ah1',
  setActiveHub: mockSetAppActiveHub,
};

const mockProjectHubStore = Object.assign(
  (selector: any) => selector(projectHubState),
  { getState: () => projectHubState, subscribe: () => () => {}, destroy: () => {} },
);

vi.mock('zustand', async () => {
  const actual = await vi.importActual('zustand');
  return {
    ...(actual as any),
    useStore: (store: any, selector: any) => selector(store.getState()),
  };
});

vi.mock('../../plugins/builtin/hub/main', () => ({
  getProjectHubStore: () => mockProjectHubStore,
  useAppHubStore: Object.assign(
    (selector: any) => selector(appHubState),
    { getState: () => appHubState },
  ),
}));

vi.mock('../../plugins/plugin-hotkeys', () => ({
  pluginHotkeyRegistry: { getAll: () => [] },
}));

vi.mock('../../plugins/plugin-commands', () => ({
  pluginCommandRegistry: { execute: vi.fn() },
}));

// Mock window.clubhouse.plugin for cross-project hub storage
const mockStorageRead = vi.fn();
const mockStorageWrite = vi.fn();
(window as any).clubhouse = {
  ...(window as any).clubhouse,
  plugin: {
    storageRead: mockStorageRead,
    storageWrite: mockStorageWrite,
  },
};

import { useCommandSource } from './use-command-source';

function findItem(items: any[], id: string) {
  return items.find((i) => i.id === id);
}

describe('useCommandSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uiStoreState.explorerTab = 'agents';
    annexState.settings = { enabled: false, deviceName: '' };
    annexState.status = { advertising: false, port: 0, pin: '', connectedCount: 0 };
    projectStoreState.activeProjectId = 'p1';
    projectHubState.hubs = [{ id: 'ph1', name: 'ProjectHub1' }];
    projectHubState.activeHubId = 'ph1';
    // Default: no hubs in other projects
    mockStorageRead.mockResolvedValue(null);
    mockStorageWrite.mockResolvedValue(undefined);
  });

  it('includes annex settings page', () => {
    const { result } = renderHook(() => useCommandSource());
    const item = findItem(result.current, 'settings:annex');
    expect(item).toBeTruthy();
    expect(item.label).toBe('Annex');
    expect(item.category).toBe('Settings');
  });

  it('includes toggle annex action with Enable label when disabled', () => {
    annexState.settings = { enabled: false, deviceName: '' };
    const { result } = renderHook(() => useCommandSource());
    const item = findItem(result.current, 'action:toggle-annex');
    expect(item).toBeTruthy();
    expect(item.label).toBe('Enable Annex');
    expect(item.category).toBe('Actions');
  });

  it('includes toggle annex action with Disable label when enabled', () => {
    annexState.settings = { enabled: true, deviceName: 'Mac' };
    const { result } = renderHook(() => useCommandSource());
    const item = findItem(result.current, 'action:toggle-annex');
    expect(item).toBeTruthy();
    expect(item.label).toBe('Disable Annex');
  });

  it('toggle annex calls saveSettings with toggled enabled', () => {
    annexState.settings = { enabled: false, deviceName: '' };
    const { result } = renderHook(() => useCommandSource());
    const item = findItem(result.current, 'action:toggle-annex');
    item.execute();
    expect(mockSaveAnnexSettings).toHaveBeenCalledWith({ enabled: true, deviceName: '' });
  });

  it('includes show annex PIN action', () => {
    const { result } = renderHook(() => useCommandSource());
    const item = findItem(result.current, 'action:annex-show-pin');
    expect(item).toBeTruthy();
    expect(item.label).toBe('Show Annex PIN');
    expect(item.category).toBe('Actions');
  });

  it('show annex PIN includes PIN in detail when enabled', () => {
    annexState.settings = { enabled: true, deviceName: '' };
    annexState.status = { advertising: true, port: 5353, pin: '1234', connectedCount: 0 };
    const { result } = renderHook(() => useCommandSource());
    const item = findItem(result.current, 'action:annex-show-pin');
    expect(item.detail).toBe('PIN: 1234');
  });

  it('show annex PIN has no detail when annex is disabled', () => {
    annexState.settings = { enabled: false, deviceName: '' };
    const { result } = renderHook(() => useCommandSource());
    const item = findItem(result.current, 'action:annex-show-pin');
    expect(item.detail).toBeUndefined();
  });

  it('show annex PIN navigates to annex settings', () => {
    const { result } = renderHook(() => useCommandSource());
    const item = findItem(result.current, 'action:annex-show-pin');
    item.execute();
    expect(mockToggleSettings).toHaveBeenCalled();
    expect(mockSetSettingsContext).toHaveBeenCalledWith('app');
    expect(mockSetSettingsSubPage).toHaveBeenCalledWith('annex');
  });

  it('includes agent config action', () => {
    const { result } = renderHook(() => useCommandSource());
    const item = findItem(result.current, 'action:agent-config');
    expect(item).toBeTruthy();
    expect(item.label).toBe('Agent Config');
    expect(item.category).toBe('Actions');
    expect(item.keywords).toContain('clubhouse');
  });

  it('agent config navigates to orchestrators settings', () => {
    const { result } = renderHook(() => useCommandSource());
    const item = findItem(result.current, 'action:agent-config');
    item.execute();
    expect(mockToggleSettings).toHaveBeenCalled();
    expect(mockSetSettingsContext).toHaveBeenCalledWith('app');
    expect(mockSetSettingsSubPage).toHaveBeenCalledWith('orchestrators');
  });

  it('agent config does not toggle settings when already in settings view', () => {
    uiStoreState.explorerTab = 'settings';
    const { result } = renderHook(() => useCommandSource());
    const item = findItem(result.current, 'action:agent-config');
    item.execute();
    expect(mockToggleSettings).not.toHaveBeenCalled();
    expect(mockSetSettingsSubPage).toHaveBeenCalledWith('orchestrators');
  });

  // ── Hub resolution tests ────────────────────────────────────────────

  it('includes both project hubs and app hubs when a project is active', () => {
    const { result } = renderHook(() => useCommandSource());
    const projectHub = findItem(result.current, 'hub:project:ph1');
    const appHub1 = findItem(result.current, 'hub:app:ah1');
    const appHub2 = findItem(result.current, 'hub:app:ah2');
    expect(projectHub).toBeTruthy();
    expect(projectHub.label).toBe('ProjectHub1');
    expect(appHub1).toBeTruthy();
    expect(appHub1.label).toBe('AppHub1');
    expect(appHub2).toBeTruthy();
    expect(appHub2.label).toBe('AppHub2');
  });

  it('marks the active project hub as Active', () => {
    const { result } = renderHook(() => useCommandSource());
    const projectHub = findItem(result.current, 'hub:project:ph1');
    expect(projectHub.detail).toBe('Active');
  });

  it('shows project name as detail for non-active project hubs', () => {
    projectHubState.hubs = [{ id: 'ph1', name: 'PH1' }, { id: 'ph2', name: 'PH2' }];
    projectHubState.activeHubId = 'ph1';
    const { result } = renderHook(() => useCommandSource());
    const ph2 = findItem(result.current, 'hub:project:ph2');
    expect(ph2.detail).toBe('Test');
    projectHubState.hubs = [{ id: 'ph1', name: 'ProjectHub1' }];
  });

  it('labels app hubs with Home detail', () => {
    const { result } = renderHook(() => useCommandSource());
    const appHub2 = findItem(result.current, 'hub:app:ah2');
    expect(appHub2.detail).toBe('Home');
  });

  it('project hub execution switches to project, navigates to hub tab, and activates hub', () => {
    const { result } = renderHook(() => useCommandSource());
    const projectHub = findItem(result.current, 'hub:project:ph1');
    projectHub.execute();
    expect(mockSetActiveProject).toHaveBeenCalledWith('p1');
    expect(mockSetExplorerTab).toHaveBeenCalledWith('plugin:hub', 'p1');
    expect(mockSetProjectActiveHub).toHaveBeenCalledWith('ph1');
  });

  it('app hub execution switches to home, navigates to hub tab, and activates hub', () => {
    const { result } = renderHook(() => useCommandSource());
    const appHub = findItem(result.current, 'hub:app:ah1');
    appHub.execute();
    expect(mockSetActiveProject).toHaveBeenCalledWith(null);
    expect(mockSetExplorerTab).toHaveBeenCalledWith('plugin:hub');
    expect(mockSetAppActiveHub).toHaveBeenCalledWith('ah1');
  });

  it('all hub items have # type indicator', () => {
    const { result } = renderHook(() => useCommandSource());
    const hubItems = result.current.filter((i: any) => i.category === 'Hubs');
    for (const hub of hubItems) {
      expect(hub.typeIndicator).toBe('#');
    }
  });

  // ── Cross-project hub tests ─────────────────────────────────────────

  it('loads hubs from non-active projects via storage', async () => {
    mockStorageRead.mockImplementation(async (req: any) => {
      if (req.projectPath === '/other' && req.key === 'hub-instances') {
        return [{ id: 'oh1', name: 'OtherHub1' }, { id: 'oh2', name: 'OtherHub2' }];
      }
      return null;
    });

    const { result } = renderHook(() => useCommandSource());

    await waitFor(() => {
      const oh1 = findItem(result.current, 'hub:project:p2:oh1');
      expect(oh1).toBeTruthy();
    });

    const oh1 = findItem(result.current, 'hub:project:p2:oh1');
    const oh2 = findItem(result.current, 'hub:project:p2:oh2');
    expect(oh1.label).toBe('OtherHub1');
    expect(oh1.detail).toBe('Other');
    expect(oh1.category).toBe('Hubs');
    expect(oh1.typeIndicator).toBe('#');
    expect(oh2).toBeTruthy();
    expect(oh2.label).toBe('OtherHub2');
  });

  it('cross-project hub execution pre-writes active hub to storage then switches', async () => {
    mockStorageRead.mockImplementation(async (req: any) => {
      if (req.projectPath === '/other' && req.key === 'hub-instances') {
        return [{ id: 'oh1', name: 'OtherHub1' }];
      }
      return null;
    });

    const { result } = renderHook(() => useCommandSource());

    await waitFor(() => {
      expect(findItem(result.current, 'hub:project:p2:oh1')).toBeTruthy();
    });

    const oh1 = findItem(result.current, 'hub:project:p2:oh1');
    await act(async () => {
      await oh1.execute();
    });

    expect(mockStorageWrite).toHaveBeenCalledWith({
      pluginId: 'hub',
      scope: 'project-local',
      key: 'hub-active-id',
      value: 'oh1',
      projectPath: '/other',
    });
    expect(mockSetActiveProject).toHaveBeenCalledWith('p2');
    expect(mockSetExplorerTab).toHaveBeenCalledWith('plugin:hub', 'p2');
  });

  it('skips active project when loading cross-project hubs', async () => {
    mockStorageRead.mockImplementation(async (req: any) => {
      if (req.projectPath === '/other' && req.key === 'hub-instances') {
        return [{ id: 'oh1', name: 'OtherHub1' }];
      }
      return null;
    });

    const { result } = renderHook(() => useCommandSource());

    await waitFor(() => {
      expect(findItem(result.current, 'hub:project:p2:oh1')).toBeTruthy();
    });

    // Should NOT have read storage for the active project
    const activeCalls = mockStorageRead.mock.calls.filter(
      (c: any) => c[0].projectPath === '/test',
    );
    expect(activeCalls).toHaveLength(0);
  });

  it('handles storage read errors gracefully for individual projects', async () => {
    mockStorageRead.mockRejectedValue(new Error('read failed'));

    const { result } = renderHook(() => useCommandSource());

    // Wait for the effect to run (should not throw)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Active project hubs and app hubs should still be present
    expect(findItem(result.current, 'hub:project:ph1')).toBeTruthy();
    expect(findItem(result.current, 'hub:app:ah1')).toBeTruthy();
  });
});
