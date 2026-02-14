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
      selectedGitFile: null,
    });
  });

  describe('selectedGitFile', () => {
    it('stores and retrieves file with worktreePath', () => {
      getState().setSelectedGitFile({
        path: 'src/index.ts',
        staged: false,
        worktreePath: '/repo/.clubhouse/agents/warm-ferret',
      });
      const file = getState().selectedGitFile;
      expect(file).toEqual({
        path: 'src/index.ts',
        staged: false,
        worktreePath: '/repo/.clubhouse/agents/warm-ferret',
      });
    });

    it('distinguishes same file path across different worktrees', () => {
      getState().setSelectedGitFile({
        path: 'src/app.ts',
        staged: true,
        worktreePath: '/repo',
      });
      expect(getState().selectedGitFile!.worktreePath).toBe('/repo');

      getState().setSelectedGitFile({
        path: 'src/app.ts',
        staged: true,
        worktreePath: '/repo/.clubhouse/agents/noble-quail',
      });
      expect(getState().selectedGitFile!.worktreePath).toBe('/repo/.clubhouse/agents/noble-quail');
    });

    it('clears to null', () => {
      getState().setSelectedGitFile({
        path: 'file.ts',
        staged: false,
        worktreePath: '/repo',
      });
      getState().setSelectedGitFile(null);
      expect(getState().selectedGitFile).toBeNull();
    });
  });

  describe('settingsSubPage default', () => {
    it('defaults to display', () => {
      expect(getState().settingsSubPage).toBe('display');
    });
  });

  describe('toggleSettings', () => {
    it('enters settings mode and saves previous tab', () => {
      useUIStore.setState({ explorerTab: 'hub' });
      getState().toggleSettings();
      expect(getState().explorerTab).toBe('settings');
      expect(getState().previousExplorerTab).toBe('hub');
      expect(getState().settingsSubPage).toBe('display');
      expect(getState().settingsContext).toBe('app');
    });

    it('exits settings mode and restores previous tab', () => {
      useUIStore.setState({ explorerTab: 'settings', previousExplorerTab: 'hub' });
      getState().toggleSettings();
      expect(getState().explorerTab).toBe('hub');
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

    it('switching to app context sets subPage to display', () => {
      useUIStore.setState({ settingsSubPage: 'plugins', settingsContext: 'proj-1' });
      getState().setSettingsContext('app');
      expect(getState().settingsContext).toBe('app');
      expect(getState().settingsSubPage).toBe('display');
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
