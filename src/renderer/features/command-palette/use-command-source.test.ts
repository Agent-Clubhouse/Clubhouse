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
const mockOpenBlueprintGallery = vi.fn();
const mockPickAndAddProject = vi.fn();
const mockOpenProjectSettings = vi.fn();

const projectStoreState = {
  projects: [
    { id: 'p1', name: 'TestProject', path: '/test', displayName: 'Test' },
    { id: 'p2', name: 'OtherProject', path: '/other', displayName: 'Other' },
  ],
  setActiveProject: mockSetActiveProject,
  activeProjectId: 'p1' as string | null,
  projectIcons: {} as Record<string, string>,
};

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: Object.assign(
    (selector: any) => selector(projectStoreState),
    { getState: () => ({ pickAndAddProject: mockPickAndAddProject }) },
  ),
}));

vi.mock('../../stores/agentStore', () => ({
  useAgentStore: (selector: any) => selector({
    agents: { 'a1': { id: 'a1', projectId: 'p1', kind: 'durable', name: 'TestAgent', status: 'sleeping' } },
    agentDetailedStatus: {},
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
  openBlueprintGallery: mockOpenBlueprintGallery,
  openProjectSettings: mockOpenProjectSettings,
};

vi.mock('../../panels/AccessoryPanel', () => ({
  useSettingsCategories: () => ({
    app: [{ label: 'About', page: 'about' }, { label: 'Display & UI', page: 'display' }, { label: 'Updates', page: 'updates' }],
    project: [{ label: 'Project Settings', page: 'project' }, { label: 'Plugins', page: 'plugins' }],
  }),
}));

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

const pluginStoreState = {
  plugins: {} as Record<string, any>,
  projectEnabled: {} as Record<string, string[]>,
  appEnabled: ['canvas'] as string[],
};

vi.mock('../../plugins/plugin-store', () => ({
  usePluginStore: (selector: any) => selector(pluginStoreState),
}));

vi.mock('../../stores/keyboardShortcutsStore', () => ({
  useKeyboardShortcutsStore: (selector: any) => selector({ shortcuts: {} }),
  formatBinding: (b: string) => b,
}));

const annexState = {
  settings: { enableServer: false, enableClient: false, deviceName: '' },
  status: { advertising: false, port: 0, pin: '', connectedCount: 0 },
  saveSettings: mockSaveAnnexSettings,
};

vi.mock('../../stores/annexStore', () => ({
  useAnnexStore: Object.assign(
    (selector: any) => selector(annexState),
    { getState: () => annexState },
  ),
}));

vi.mock('zustand', async () => {
  const actual = await vi.importActual('zustand');
  return {
    ...(actual as any),
    useStore: (store: any, selector: any) => selector(store.getState()),
  };
});

const mockSetProjectActiveCanvas = vi.fn();
const mockSetAppActiveCanvas = vi.fn();

const projectCanvasState = {
  canvases: [{ id: 'pc1', name: 'ProjectCanvas1' }] as any[],
  activeCanvasId: 'pc1',
  setActiveCanvas: mockSetProjectActiveCanvas,
};

const appCanvasState = {
  canvases: [{ id: 'ac1', name: 'AppCanvas1' }] as any[],
  activeCanvasId: 'ac1',
  setActiveCanvas: mockSetAppActiveCanvas,
};

const mockProjectCanvasStore = Object.assign(
  (selector: any) => selector(projectCanvasState),
  { getState: () => projectCanvasState, subscribe: () => () => {}, destroy: () => {} },
);

vi.mock('../../plugins/builtin/canvas/main', () => ({
  getProjectCanvasStore: () => mockProjectCanvasStore,
  getKnownProjectIds: () => [] as string[],
  useAppCanvasStore: Object.assign(
    (selector: any) => selector(appCanvasState),
    { getState: () => appCanvasState },
  ),
}));

vi.mock('../../plugins/plugin-hotkeys', () => ({
  pluginHotkeyRegistry: { getAll: () => [] },
}));

vi.mock('../../plugins/plugin-commands', () => ({
  pluginCommandRegistry: { execute: vi.fn() },
}));

// Mock window.clubhouse.plugin and app for cross-project canvas storage + preview eligibility
const mockStorageRead = vi.fn();
const mockStorageWrite = vi.fn();
const mockIsPreviewEligible = vi.fn().mockResolvedValue(true);
const mockGetExperimentalSettings = vi.fn().mockResolvedValue({} as Record<string, boolean>);
(window as any).clubhouse = {
  ...(window as any).clubhouse,
  plugin: {
    storageRead: mockStorageRead,
    storageWrite: mockStorageWrite,
  },
  app: {
    ...(window as any).clubhouse?.app,
    isPreviewEligible: mockIsPreviewEligible,
    getExperimentalSettings: mockGetExperimentalSettings,
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
    annexState.settings = { enableServer: false, enableClient: false, deviceName: '' };
    annexState.status = { advertising: false, port: 0, pin: '', connectedCount: 0 };
    pluginStoreState.appEnabled = ['canvas'];
    projectStoreState.activeProjectId = 'p1';
    projectCanvasState.canvases = [{ id: 'pc1', name: 'ProjectCanvas1' }];
    projectCanvasState.activeCanvasId = 'pc1';
    // Default: no canvases in other projects
    mockStorageRead.mockResolvedValue(null);
    mockStorageWrite.mockResolvedValue(undefined);
    // Default: preview-eligible (restored after clearAllMocks)
    mockIsPreviewEligible.mockResolvedValue(true);
    // Default: experimental flags off (restored after clearAllMocks)
    mockGetExperimentalSettings.mockResolvedValue({});
  });

  it('annex commands hidden when not preview-eligible', async () => {
    mockIsPreviewEligible.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useCommandSource());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(findItem(result.current, 'action:toggle-annex-server')).toBeUndefined();
    expect(findItem(result.current, 'action:toggle-annex-client')).toBeUndefined();
    expect(findItem(result.current, 'action:annex-show-pin')).toBeUndefined();
  });

  it('includes toggle annex server action when preview-eligible', async () => {
    annexState.settings = { enableServer: false, enableClient: false, deviceName: '' };
    const { result } = renderHook(() => useCommandSource());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const item = findItem(result.current, 'action:toggle-annex-server');
    expect(item).toBeDefined();
    expect(item.label).toBe('Enable Annex server');
    expect(item.category).toBe('Commands');
  });

  it('includes toggle annex server action with Disable label when enableServer is true', async () => {
    annexState.settings = { enableServer: true, enableClient: false, deviceName: 'Mac' };
    const { result } = renderHook(() => useCommandSource());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const item = findItem(result.current, 'action:toggle-annex-server');
    expect(item).toBeDefined();
    expect(item.label).toBe('Disable Annex server');
  });

  it('toggle annex server calls saveSettings with toggled enableServer', async () => {
    annexState.settings = { enableServer: false, enableClient: false, deviceName: '' };
    const { result } = renderHook(() => useCommandSource());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const item = findItem(result.current, 'action:toggle-annex-server');
    item.execute();
    expect(mockSaveAnnexSettings).toHaveBeenCalledWith({ enableServer: true, enableClient: false, deviceName: '' });
  });

  it('includes show annex PIN action when preview-eligible', async () => {
    const { result } = renderHook(() => useCommandSource());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const item = findItem(result.current, 'action:annex-show-pin');
    expect(item).toBeDefined();
    expect(item.label).toBe('Show Annex PIN');
    expect(item.category).toBe('Commands');
  });

  it('show annex PIN includes PIN in detail when enabled', async () => {
    annexState.settings = { enableServer: true, enableClient: false, deviceName: '' };
    annexState.status = { advertising: true, port: 5353, pin: '1234', connectedCount: 0 };
    const { result } = renderHook(() => useCommandSource());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const item = findItem(result.current, 'action:annex-show-pin');
    expect(item.detail).toBe('PIN: 1234');
  });

  it('show annex PIN has no detail when annex is disabled', async () => {
    annexState.settings = { enableServer: false, enableClient: false, deviceName: '' };
    const { result } = renderHook(() => useCommandSource());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const item = findItem(result.current, 'action:annex-show-pin');
    expect(item.detail).toBeUndefined();
  });

  it('show annex PIN navigates to annex settings', async () => {
    const { result } = renderHook(() => useCommandSource());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const item = findItem(result.current, 'action:annex-show-pin');
    item.execute();
    expect(mockToggleSettings).toHaveBeenCalled();
    expect(mockSetSettingsContext).toHaveBeenCalledWith('app');
    expect(mockSetSettingsSubPage).toHaveBeenCalledWith('annex');
  });

  it('includes agent config action', () => {
    const { result } = renderHook(() => useCommandSource());
    const item = findItem(result.current, 'action:agent-config');
    expect(item).toBeDefined();
    expect(item.label).toBe('Agent config');
    expect(item.category).toBe('Commands');
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

  // ── Canvas resolution tests ──────────────────────────

  it('all canvas items have the canvas icon and Canvases category', () => {
    const { result } = renderHook(() => useCommandSource());
    const spaceItems = result.current.filter((i: any) => i.category === 'Canvases');
    expect(spaceItems.length).toBeGreaterThan(0);
    for (const item of spaceItems) {
      expect(item.icon).toBe('canvas');
    }
  });

  it('skips active project when loading cross-project canvases', async () => {
    mockStorageRead.mockImplementation(async (req: any) => {
      if (req.projectPath === '/other' && req.key === 'canvas-instances') {
        return [{ id: 'oc1', name: 'OtherCanvas1' }];
      }
      return null;
    });

    const { result } = renderHook(() => useCommandSource());

    await waitFor(() => {
      expect(findItem(result.current, 'canvas:project:p2:oc1')).toBeDefined();
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

    // Active project canvases should still be present
    expect(findItem(result.current, 'canvas:project:pc1')).toBeDefined();
  });

  // ── Canvas resolution tests ─────────────────────────────────────────

  it('includes project canvases and app canvases as Canvases items', () => {
    const { result } = renderHook(() => useCommandSource());
    const projectCanvas = findItem(result.current, 'canvas:project:pc1');
    const appCanvas = findItem(result.current, 'canvas:app:ac1');
    expect(projectCanvas).toBeDefined();
    expect(projectCanvas.label).toBe('ProjectCanvas1');
    expect(projectCanvas.category).toBe('Canvases');
    expect(projectCanvas.icon).toBe('canvas');
    expect(appCanvas).toBeDefined();
    expect(appCanvas.label).toBe('AppCanvas1');
    expect(appCanvas.category).toBe('Canvases');
  });

  it('marks the open project canvas in its detail', () => {
    const { result } = renderHook(() => useCommandSource());
    const projectCanvas = findItem(result.current, 'canvas:project:pc1');
    expect(projectCanvas.detail).toBe('Test, open');
  });

  it('labels app canvases App canvas, never Home', () => {
    const { result } = renderHook(() => useCommandSource());
    const appCanvas = findItem(result.current, 'canvas:app:ac1');
    expect(appCanvas.detail).toBe('App canvas');
  });

  it('project canvas execution switches to project, navigates to canvas tab, and activates canvas', () => {
    const { result } = renderHook(() => useCommandSource());
    const projectCanvas = findItem(result.current, 'canvas:project:pc1');
    projectCanvas.execute();
    expect(mockSetActiveProject).toHaveBeenCalledWith('p1');
    expect(mockSetExplorerTab).toHaveBeenCalledWith('plugin:canvas', 'p1');
    expect(mockSetProjectActiveCanvas).toHaveBeenCalledWith('pc1');
  });

  it('app canvas execution switches to home, navigates to canvas tab, and activates canvas', () => {
    const { result } = renderHook(() => useCommandSource());
    const appCanvas = findItem(result.current, 'canvas:app:ac1');
    appCanvas.execute();
    expect(mockSetActiveProject).toHaveBeenCalledWith(null);
    expect(mockSetExplorerTab).toHaveBeenCalledWith('plugin:canvas');
    expect(mockSetAppActiveCanvas).toHaveBeenCalledWith('ac1');
  });

  it('loads canvases from non-active projects via storage', async () => {
    mockStorageRead.mockImplementation(async (req: any) => {
      if (req.projectPath === '/other' && req.key === 'canvas-instances') {
        return [{ id: 'oc1', name: 'OtherCanvas1' }];
      }
      return null;
    });

    const { result } = renderHook(() => useCommandSource());

    await waitFor(() => {
      const oc1 = findItem(result.current, 'canvas:project:p2:oc1');
      expect(oc1).toBeDefined();
    });

    const oc1 = findItem(result.current, 'canvas:project:p2:oc1');
    expect(oc1.label).toBe('OtherCanvas1');
    expect(oc1.detail).toBe('Other');
    expect(oc1.category).toBe('Canvases');
    expect(oc1.icon).toBe('canvas');
  });

  it('cross-project canvas execution pre-writes active canvas to storage then switches', async () => {
    mockStorageRead.mockImplementation(async (req: any) => {
      if (req.projectPath === '/other' && req.key === 'canvas-instances') {
        return [{ id: 'oc1', name: 'OtherCanvas1' }];
      }
      return null;
    });

    const { result } = renderHook(() => useCommandSource());

    await waitFor(() => {
      expect(findItem(result.current, 'canvas:project:p2:oc1')).toBeDefined();
    });

    const oc1 = findItem(result.current, 'canvas:project:p2:oc1');
    await act(async () => {
      await oc1.execute();
    });

    expect(mockStorageWrite).toHaveBeenCalledWith({
      pluginId: 'canvas',
      scope: 'project-local',
      key: 'canvas-active-id',
      value: 'oc1',
      projectPath: '/other',
    });
    expect(mockSetActiveProject).toHaveBeenCalledWith('p2');
    expect(mockSetExplorerTab).toHaveBeenCalledWith('plugin:canvas', 'p2');
  });

  it('never lists Hub items, and canvas items sit in the Canvases group', () => {
    const { result } = renderHook(() => useCommandSource());
    expect(result.current.filter((i: any) => i.id.startsWith('hub:'))).toHaveLength(0);
    const canvasItems = result.current.filter((i: any) => i.id.startsWith('canvas:'));
    expect(canvasItems.length).toBeGreaterThan(0);
    for (const canvas of canvasItems) {
      expect(canvas.category).toBe('Canvases');
      expect(canvas.detail ?? '').not.toMatch(/Canvas ·|Home/);
    }
  });

  // ── Settings: every page from useSettingsCategories ─────────

  it('lists Open settings with the settings shortcut, and every app page', () => {
    const { result } = renderHook(() => useCommandSource());
    const open = findItem(result.current, 'settings:open');
    expect(open.label).toBe('Open settings');
    expect(open.category).toBe('Settings');
    expect(findItem(result.current, 'settings:display').shortcut).toBeUndefined();
    for (const page of ['about', 'display', 'updates']) {
      expect(findItem(result.current, `settings:${page}`).detail).toBe('App');
    }
  });

  it("lists each project's settings pages, for searching only", () => {
    const { result } = renderHook(() => useCommandSource());
    const item = findItem(result.current, 'settings:p2:plugins');
    expect(item.detail).toBe('Other');
    expect(item.searchOnly).toBe(true);
    item.execute();
    expect(mockOpenProjectSettings).toHaveBeenCalledWith('p2');
    expect(mockSetSettingsSubPage).toHaveBeenCalledWith('plugins');
  });

  it('Open settings only opens, never closes, settings', () => {
    uiStoreState.explorerTab = 'settings';
    const { result } = renderHook(() => useCommandSource());
    findItem(result.current, 'settings:open').execute();
    expect(mockToggleSettings).not.toHaveBeenCalled();
  });

  it('agents carry the sidebar status word in their detail', () => {
    const { result } = renderHook(() => useCommandSource());
    const agent = findItem(result.current, 'agent:a1');
    expect(agent.dot).toBe('sleeping');
    expect(agent.detail).toBe('Test · Sleeping');
  });

  // ── Canvas gating: items hidden when canvas plugin disabled ─────────

  it('hides all canvas items when canvas plugin is not in appEnabled', () => {
    const saved = pluginStoreState.appEnabled;
    pluginStoreState.appEnabled = [];
    try {
      const { result } = renderHook(() => useCommandSource());
      const canvasItems = result.current.filter((i: any) => i.id.startsWith('canvas:'));
      expect(canvasItems).toHaveLength(0);
    } finally {
      pluginStoreState.appEnabled = saved;
    }
  });

  // ── Blueprint command tests ────────────────────────────────────────

  it('includes import-blueprint action', () => {
    const { result } = renderHook(() => useCommandSource());
    const item = findItem(result.current, 'action:import-blueprint');
    expect(item).toBeDefined();
    expect(item.label).toBe('Import blueprint');
    expect(item.category).toBe('Commands');
  });

  it('import-blueprint calls openBlueprintGallery', () => {
    const { result } = renderHook(() => useCommandSource());
    const item = findItem(result.current, 'action:import-blueprint');
    item.execute();
    expect(mockOpenBlueprintGallery).toHaveBeenCalled();
  });

  it('includes export-blueprint action', () => {
    const { result } = renderHook(() => useCommandSource());
    const item = findItem(result.current, 'action:export-blueprint');
    expect(item).toBeDefined();
    expect(item.label).toBe('Export canvas as blueprint');
    expect(item.category).toBe('Commands');
  });

  // ── The Assistant was removed: no palette entry, even with a stale flag ──

  it('never lists nav:assistant, even with a stale experimental.assistant flag', async () => {
    mockGetExperimentalSettings.mockResolvedValue({ assistant: true });
    const { result } = renderHook(() => useCommandSource());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(findItem(result.current, 'nav:assistant')).toBeUndefined();
  });

  it('shows nav:help', async () => {
    const { result } = renderHook(() => useCommandSource());
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(findItem(result.current, 'nav:help')).toBeDefined();
  });
});
