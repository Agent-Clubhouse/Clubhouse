import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from './uiStore';

function getState() {
  return useUIStore.getState();
}

describe('uiStore', () => {
  beforeEach(() => {
    useUIStore.setState({
      explorerTab: 'agents',
      previousExplorerTab: null,
      settingsSubPage: 'display',
      settingsContext: 'app',
      showHome: true,
      projectExplorerTab: {},
    });
  });

  describe('settingsSubPage default', () => {
    it('defaults to display', () => {
      expect(getState().settingsSubPage).toBe('display');
    });
  });

  describe('toggleSettings', () => {
    it('enters settings mode and saves previous tab', () => {
      useUIStore.setState({ explorerTab: 'agents' });
      getState().toggleSettings();
      expect(getState().explorerTab).toBe('settings');
      expect(getState().previousExplorerTab).toBe('agents');
      expect(getState().settingsSubPage).toBe('orchestrators');
      expect(getState().settingsContext).toBe('app');
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

    it('toggleSettings resets context to app', () => {
      useUIStore.setState({ explorerTab: 'agents', settingsContext: 'proj-1' });
      getState().toggleSettings();
      expect(getState().settingsContext).toBe('app');
    });
  });
});
