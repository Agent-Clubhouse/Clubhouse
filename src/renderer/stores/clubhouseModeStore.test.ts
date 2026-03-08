import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useClubhouseModeStore } from './clubhouseModeStore';

describe('clubhouseModeStore', () => {
  beforeEach(() => {
    // Reset store to defaults
    useClubhouseModeStore.setState({
      enabled: false,
      projectOverrides: {},
      sourceControlProvider: 'github',
    });
    vi.restoreAllMocks();
  });

  describe('loadSettings', () => {
    it('loads settings from API', async () => {
      window.clubhouse.app.getClubhouseModeSettings = vi.fn().mockResolvedValue({
        enabled: true,
        projectOverrides: { '/project': false },
      });

      await useClubhouseModeStore.getState().loadSettings();

      expect(useClubhouseModeStore.getState().enabled).toBe(true);
      expect(useClubhouseModeStore.getState().projectOverrides).toEqual({ '/project': false });
    });

    it('keeps defaults on error', async () => {
      window.clubhouse.app.getClubhouseModeSettings = vi.fn().mockRejectedValue(new Error('fail'));

      await useClubhouseModeStore.getState().loadSettings();

      expect(useClubhouseModeStore.getState().enabled).toBe(false);
    });
  });

  describe('isEnabledForProject', () => {
    it('returns global when no project override', () => {
      useClubhouseModeStore.setState({ enabled: true, projectOverrides: {} });
      expect(useClubhouseModeStore.getState().isEnabledForProject('/project')).toBe(true);
    });

    it('returns project override when set', () => {
      useClubhouseModeStore.setState({
        enabled: true,
        projectOverrides: { '/project': false },
      });
      expect(useClubhouseModeStore.getState().isEnabledForProject('/project')).toBe(false);
    });

    it('returns global when no projectPath given', () => {
      useClubhouseModeStore.setState({ enabled: true, projectOverrides: {} });
      expect(useClubhouseModeStore.getState().isEnabledForProject()).toBe(true);
    });
  });

  describe('setEnabled', () => {
    it('updates enabled and saves', async () => {
      window.clubhouse.app.saveClubhouseModeSettings = vi.fn().mockResolvedValue(undefined);

      await useClubhouseModeStore.getState().setEnabled(true);

      expect(useClubhouseModeStore.getState().enabled).toBe(true);
      expect(window.clubhouse.app.saveClubhouseModeSettings).toHaveBeenCalledWith(
        { enabled: true, projectOverrides: {}, sourceControlProvider: 'github' },
        undefined,
      );
    });

    it('reverts on save failure', async () => {
      window.clubhouse.app.saveClubhouseModeSettings = vi.fn().mockRejectedValue(new Error('fail'));

      await useClubhouseModeStore.getState().setEnabled(true);

      // Should revert to false
      expect(useClubhouseModeStore.getState().enabled).toBe(false);
    });
  });

  describe('setProjectOverride', () => {
    it('sets project override and saves', async () => {
      window.clubhouse.app.saveClubhouseModeSettings = vi.fn().mockResolvedValue(undefined);

      await useClubhouseModeStore.getState().setProjectOverride('/project', true);

      expect(useClubhouseModeStore.getState().projectOverrides).toEqual({ '/project': true });
    });
  });

  describe('clearProjectOverride', () => {
    it('removes project override and saves', async () => {
      useClubhouseModeStore.setState({
        enabled: false,
        projectOverrides: { '/project': true, '/other': false },
      });
      window.clubhouse.app.saveClubhouseModeSettings = vi.fn().mockResolvedValue(undefined);

      await useClubhouseModeStore.getState().clearProjectOverride('/project');

      expect(useClubhouseModeStore.getState().projectOverrides).toEqual({ '/other': false });
    });
  });

  describe('race condition prevention', () => {
    it('setEnabled saves with pre-snapshot projectOverrides', async () => {
      useClubhouseModeStore.setState({
        enabled: false,
        projectOverrides: { '/a': true },
        sourceControlProvider: 'github',
      });

      let resolveSave!: () => void;
      window.clubhouse.app.saveClubhouseModeSettings = vi.fn().mockImplementation(
        () => new Promise<void>((r) => { resolveSave = r; }),
      );

      const promise = useClubhouseModeStore.getState().setEnabled(true);

      // Concurrent mutation while save is in-flight
      useClubhouseModeStore.setState({ projectOverrides: { '/a': true, '/b': false } });

      resolveSave();
      await promise;

      expect(window.clubhouse.app.saveClubhouseModeSettings).toHaveBeenCalledWith(
        { enabled: true, projectOverrides: { '/a': true }, sourceControlProvider: 'github' },
        undefined,
      );
    });

    it('setSourceControlProvider saves with pre-snapshot enabled and projectOverrides', async () => {
      useClubhouseModeStore.setState({
        enabled: false,
        projectOverrides: {},
        sourceControlProvider: 'github',
      });

      let resolveSave!: () => void;
      window.clubhouse.app.saveClubhouseModeSettings = vi.fn().mockImplementation(
        () => new Promise<void>((r) => { resolveSave = r; }),
      );

      const promise = useClubhouseModeStore.getState().setSourceControlProvider('gitlab');

      // Concurrent mutations while save is in-flight
      useClubhouseModeStore.setState({ enabled: true, projectOverrides: { '/x': true } });

      resolveSave();
      await promise;

      expect(window.clubhouse.app.saveClubhouseModeSettings).toHaveBeenCalledWith(
        { enabled: false, projectOverrides: {}, sourceControlProvider: 'gitlab' },
      );
    });
  });
});
