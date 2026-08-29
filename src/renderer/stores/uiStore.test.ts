import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock rendererLog before importing the store
const mockRendererLog = vi.hoisted(() => vi.fn());
vi.mock('../plugins/renderer-logger', () => ({
  rendererLog: (...args: unknown[]) => mockRendererLog(...args),
}));

const storage: Record<string, string> = {};
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: vi.fn((key: string) => storage[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { storage[key] = value; }),
    removeItem: vi.fn((key: string) => { delete storage[key]; }),
    clear: vi.fn(() => {
      for (const key of Object.keys(storage)) delete storage[key];
    }),
  },
  writable: true,
});

import { useUIStore } from './uiStore';

function getState() {
  return useUIStore.getState();
}

describe('uiStore', () => {
  beforeEach(() => {
    useUIStore.setState({
      explorerTab: 'agents',
      previousExplorerTab: null,
      settingsSubPage: 'orchestrators',
      settingsContext: 'app',
      showHome: true,
      projectExplorerTab: {},
    });
    for (const key of Object.keys(storage)) delete storage[key];
    mockRendererLog.mockClear();
  });

  describe('settingsSubPage default', () => {
    it('defaults to orchestrators', () => {
      expect(getState().settingsSubPage).toBe('orchestrators');
    });
  });

  describe('toggleSettings', () => {
    it('enters settings mode and saves previous tab', () => {
      useUIStore.setState({ explorerTab: 'agents' });
      getState().toggleSettings();
      expect(getState().explorerTab).toBe('settings');
      expect(getState().previousExplorerTab).toBe('agents');
    });

    it('restores the last-viewed section and context when re-entering settings', () => {
      // User was last on a project-scoped Notifications page, then left settings.
      useUIStore.setState({
        explorerTab: 'agents',
        settingsSubPage: 'notifications',
        settingsContext: 'proj-1',
      });
      getState().toggleSettings();
      expect(getState().explorerTab).toBe('settings');
      expect(getState().settingsSubPage).toBe('notifications');
      expect(getState().settingsContext).toBe('proj-1');
    });

    it('exits settings mode and restores previous tab', () => {
      useUIStore.setState({ explorerTab: 'settings', previousExplorerTab: 'agents' });
      getState().toggleSettings();
      expect(getState().explorerTab).toBe('agents');
      expect(getState().previousExplorerTab).toBeNull();
    });

    it('falls back to agents when no previous tab saved', () => {
      useUIStore.setState({ explorerTab: 'settings', previousExplorerTab: null });
      getState().toggleSettings();
      expect(getState().explorerTab).toBe('agents');
      expect(getState().previousExplorerTab).toBeNull();
    });

    it('round-trips correctly', () => {
      useUIStore.setState({ explorerTab: 'agents' });
      getState().toggleSettings();
      expect(getState().explorerTab).toBe('settings');
      getState().toggleSettings();
      expect(getState().explorerTab).toBe('agents');
    });
  });

  describe('toggleHelp', () => {
    it('enters help mode and saves previous tab', () => {
      useUIStore.setState({ explorerTab: 'agents' });
      getState().toggleHelp();
      expect(getState().explorerTab).toBe('help');
      expect(getState().previousExplorerTab).toBe('agents');
      expect(getState().helpSectionId).toBe('general');
      expect(getState().helpTopicId).toBeNull();
    });

    it('exits help mode and restores previous tab', () => {
      useUIStore.setState({ explorerTab: 'help', previousExplorerTab: 'agents' });
      getState().toggleHelp();
      expect(getState().explorerTab).toBe('agents');
      expect(getState().previousExplorerTab).toBeNull();
    });

    it('setHelpSection resets topic', () => {
      useUIStore.setState({ helpSectionId: 'general', helpTopicId: 'navigation' });
      getState().setHelpSection('projects');
      expect(getState().helpSectionId).toBe('projects');
      expect(getState().helpTopicId).toBeNull();
    });

    it('setHelpTopic updates topic', () => {
      getState().setHelpTopic('getting-started');
      expect(getState().helpTopicId).toBe('getting-started');
    });
  });

  describe('per-project tab persistence', () => {
    it('setExplorerTab with projectId saves to projectExplorerTab', () => {
      getState().setExplorerTab('agents', 'proj-1');
      expect(getState().projectExplorerTab['proj-1']).toBe('agents');
    });

    it('setExplorerTab without projectId does not save to projectExplorerTab', () => {
      getState().setExplorerTab('agents');
      expect(getState().projectExplorerTab).toEqual({});
    });

    it('setExplorerTab with settings tab does not save to projectExplorerTab', () => {
      getState().setExplorerTab('settings', 'proj-1');
      expect(getState().projectExplorerTab['proj-1']).toBeUndefined();
    });

    it('setExplorerTab with help tab does not save to projectExplorerTab', () => {
      getState().setExplorerTab('help', 'proj-1');
      expect(getState().projectExplorerTab['proj-1']).toBeUndefined();
    });

    it('setExplorerTab saves plugin tabs to projectExplorerTab', () => {
      getState().setExplorerTab('plugin:hub', 'proj-1');
      expect(getState().projectExplorerTab['proj-1']).toBe('plugin:hub');
    });

    it('restoreProjectView restores saved tab', () => {
      useUIStore.setState({ projectExplorerTab: { 'proj-1': 'plugin:hub' } });
      getState().restoreProjectView('proj-1');
      expect(getState().explorerTab).toBe('plugin:hub');
    });

    it('restoreProjectView defaults to agents when no saved tab', () => {
      useUIStore.setState({ explorerTab: 'settings', projectExplorerTab: {} });
      getState().restoreProjectView('proj-2');
      expect(getState().explorerTab).toBe('agents');
    });

    it('different projects maintain independent tabs', () => {
      getState().setExplorerTab('agents', 'proj-1');
      getState().setExplorerTab('plugin:hub', 'proj-2');
      expect(getState().projectExplorerTab['proj-1']).toBe('agents');
      expect(getState().projectExplorerTab['proj-2']).toBe('plugin:hub');
    });
  });

  describe('openAbout', () => {
    it('opens settings to about page and saves previous tab', () => {
      useUIStore.setState({ explorerTab: 'agents' });
      getState().openAbout();
      expect(getState().explorerTab).toBe('settings');
      expect(getState().previousExplorerTab).toBe('agents');
      expect(getState().settingsSubPage).toBe('about');
      expect(getState().settingsContext).toBe('app');
    });

    it('preserves previous tab when coming from a plugin tab', () => {
      useUIStore.setState({ explorerTab: 'plugin:hub' });
      getState().openAbout();
      expect(getState().previousExplorerTab).toBe('plugin:hub');
      expect(getState().settingsSubPage).toBe('about');
    });
  });

  describe('quickAgentDialog', () => {
    it('starts closed', () => {
      expect(getState().quickAgentDialogOpen).toBe(false);
    });

    it('openQuickAgentDialog sets dialog open', () => {
      getState().openQuickAgentDialog();
      expect(getState().quickAgentDialogOpen).toBe(true);
    });

    it('closeQuickAgentDialog sets dialog closed', () => {
      getState().openQuickAgentDialog();
      getState().closeQuickAgentDialog();
      expect(getState().quickAgentDialogOpen).toBe(false);
    });
  });

  describe('blueprintGallery scope (GH-1563)', () => {
    it('starts closed with no scope', () => {
      expect(getState().blueprintGalleryOpen).toBe(false);
      expect(getState().blueprintGalleryScope).toBeNull();
    });

    it('openBlueprintGallery with no scope opens with a null scope (back-compat callers)', () => {
      getState().openBlueprintGallery();
      expect(getState().blueprintGalleryOpen).toBe(true);
      expect(getState().blueprintGalleryScope).toBeNull();
    });

    it('openBlueprintGallery records an app scope', () => {
      getState().openBlueprintGallery({ mode: 'app' });
      expect(getState().blueprintGalleryOpen).toBe(true);
      expect(getState().blueprintGalleryScope).toEqual({ mode: 'app' });
    });

    it('openBlueprintGallery records a project scope with id and path', () => {
      getState().openBlueprintGallery({ mode: 'project', projectId: 'proj-1', projectPath: '/tmp/proj-1' });
      expect(getState().blueprintGalleryScope).toEqual({
        mode: 'project', projectId: 'proj-1', projectPath: '/tmp/proj-1',
      });
    });

    it('closeBlueprintGallery clears both open and scope', () => {
      getState().openBlueprintGallery({ mode: 'project', projectId: 'proj-1', projectPath: '/tmp/proj-1' });
      getState().closeBlueprintGallery();
      expect(getState().blueprintGalleryOpen).toBe(false);
      expect(getState().blueprintGalleryScope).toBeNull();
    });
  });

  describe('settingsContext', () => {
    it('defaults to app', () => {
      expect(getState().settingsContext).toBe('app');
    });

    it('switching to app context sets subPage to orchestrators', () => {
      useUIStore.setState({ settingsSubPage: 'plugins', settingsContext: 'proj-1' });
      getState().setSettingsContext('app');
      expect(getState().settingsContext).toBe('app');
      expect(getState().settingsSubPage).toBe('orchestrators');
    });

    it('switching to project context sets subPage to project', () => {
      useUIStore.setState({ settingsSubPage: 'display', settingsContext: 'app' });
      getState().setSettingsContext('proj-1');
      expect(getState().settingsContext).toBe('proj-1');
      expect(getState().settingsSubPage).toBe('project');
    });

    it('toggleSettings preserves context across re-entry', () => {
      useUIStore.setState({ explorerTab: 'agents', settingsContext: 'proj-1' });
      getState().toggleSettings();
      expect(getState().settingsContext).toBe('proj-1');
    });
  });

  describe('openProjectSettings', () => {
    it('enters settings scoped to the given project on the project page', () => {
      useUIStore.setState({ explorerTab: 'agents', settingsContext: 'app', settingsSubPage: 'orchestrators' });
      getState().openProjectSettings('proj-1');
      expect(getState().explorerTab).toBe('settings');
      expect(getState().settingsContext).toBe('proj-1');
      expect(getState().settingsSubPage).toBe('project');
      expect(getState().previousExplorerTab).toBe('agents');
    });

    it('preserves previousExplorerTab when already in settings', () => {
      useUIStore.setState({ explorerTab: 'settings', previousExplorerTab: 'agents', settingsContext: 'app' });
      getState().openProjectSettings('proj-2');
      expect(getState().settingsContext).toBe('proj-2');
      expect(getState().settingsSubPage).toBe('project');
      // Coming from another settings page must not overwrite the saved origin tab.
      expect(getState().previousExplorerTab).toBe('agents');
    });

    it('switches directly between two projects settings', () => {
      getState().openProjectSettings('proj-1');
      getState().openProjectSettings('proj-2');
      expect(getState().settingsContext).toBe('proj-2');
      expect(getState().settingsSubPage).toBe('project');
    });
  });

  describe('localStorage write error logging (LB-SP-004)', () => {
    it('logs via rendererLog when setItem throws in setShowHome', () => {
      vi.mocked(localStorage.setItem).mockImplementationOnce(() => {
        throw new DOMException('QuotaExceededError');
      });

      getState().setShowHome(false);

      expect(mockRendererLog).toHaveBeenCalledWith(
        'store:ui',
        'warn',
        expect.stringContaining('Failed to persist view prefs'),
        expect.objectContaining({ meta: expect.objectContaining({ key: 'clubhouse_view_prefs' }) }),
      );
    });

    it('in-memory state still updates even when setItem throws in setShowHome', () => {
      vi.mocked(localStorage.setItem).mockImplementationOnce(() => {
        throw new DOMException('QuotaExceededError');
      });

      getState().setShowHome(false);

      expect(getState().showHome).toBe(false);
    });

    it('logs via rendererLog when setItem throws in setActiveHost', () => {
      vi.mocked(localStorage.setItem).mockImplementationOnce(() => {
        throw new DOMException('QuotaExceededError');
      });

      getState().setActiveHost('sat-1');

      expect(mockRendererLog).toHaveBeenCalledWith(
        'store:ui',
        'warn',
        expect.stringContaining('Failed to persist active host'),
        expect.objectContaining({ meta: expect.objectContaining({ key: 'clubhouse_active_host' }) }),
      );
    });

    it('in-memory state still updates even when setItem throws in setActiveHost', () => {
      vi.mocked(localStorage.setItem).mockImplementationOnce(() => {
        throw new DOMException('QuotaExceededError');
      });

      getState().setActiveHost('sat-1');

      expect(getState().activeHostId).toBe('sat-1');
    });
  });

  describe('corrupt localStorage', () => {
    it('logs a warning when view prefs data is corrupt', async () => {
      localStorage.setItem('clubhouse_view_prefs', '{not valid json');
      vi.resetModules();
      await import('./uiStore');
      expect(mockRendererLog).toHaveBeenCalledWith(
        'store:ui',
        'warn',
        expect.stringContaining('Corrupt view preferences'),
        expect.objectContaining({
          meta: expect.objectContaining({ key: 'clubhouse_view_prefs' }),
        }),
      );
    });
  });
});
