import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

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

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: Object.assign(
    (selector: any) => selector({
      projects: [{ id: 'p1', name: 'TestProject', path: '/test', displayName: 'Test' }],
      setActiveProject: mockSetActiveProject,
      activeProjectId: 'p1',
    }),
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

vi.mock('../../plugins/plugin-hotkeys', () => ({
  pluginHotkeyRegistry: { getAll: () => [] },
}));

vi.mock('../../plugins/plugin-commands', () => ({
  pluginCommandRegistry: { execute: vi.fn() },
}));

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
});
