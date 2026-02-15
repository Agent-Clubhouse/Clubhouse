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
