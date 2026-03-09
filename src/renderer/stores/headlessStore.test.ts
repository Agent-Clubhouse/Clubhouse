import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock window.clubhouse
const mockGetHeadlessSettings = vi.fn();
const mockSaveHeadlessSettings = vi.fn();

vi.stubGlobal('window', {
  clubhouse: {
    app: {
      getHeadlessSettings: (...args: unknown[]) => mockGetHeadlessSettings(...args),
      saveHeadlessSettings: (...args: unknown[]) => mockSaveHeadlessSettings(...args),
    },
  },
});

import { useHeadlessStore } from './headlessStore';

function getState() {
  return useHeadlessStore.getState();
}

describe('headlessStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetHeadlessSettings.mockResolvedValue({ defaultMode: 'interactive' });
    mockSaveHeadlessSettings.mockResolvedValue(undefined);
    useHeadlessStore.setState({
      enabled: false,
      defaultMode: 'interactive',
      projectOverrides: {},
    });
  });

  // ============================================================
  // loadSettings
  // ============================================================
  describe('loadSettings', () => {
    it('loads defaultMode from backend', async () => {
      mockGetHeadlessSettings.mockResolvedValue({ defaultMode: 'headless' });

      await getState().loadSettings();

      expect(getState().defaultMode).toBe('headless');
      expect(getState().enabled).toBe(true); // backwards compat
    });

    it('loads structured mode from backend', async () => {
      mockGetHeadlessSettings.mockResolvedValue({ defaultMode: 'structured' });

      await getState().loadSettings();

      expect(getState().defaultMode).toBe('structured');
    });

    it('migrates legacy enabled boolean', async () => {
      mockGetHeadlessSettings.mockResolvedValue({ enabled: true });

      await getState().loadSettings();

      expect(getState().defaultMode).toBe('headless');
    });

    it('migrates legacy enabled=false to interactive', async () => {
      mockGetHeadlessSettings.mockResolvedValue({ enabled: false });

      await getState().loadSettings();

      expect(getState().defaultMode).toBe('interactive');
    });

    it('loads projectOverrides from backend', async () => {
      mockGetHeadlessSettings.mockResolvedValue({
        defaultMode: 'interactive',
        projectOverrides: { '/project-a': 'headless', '/project-b': 'structured' },
      });

      await getState().loadSettings();

      expect(getState().projectOverrides).toEqual({
        '/project-a': 'headless',
        '/project-b': 'structured',
      });
    });

    it('defaults projectOverrides to empty object when not present', async () => {
      mockGetHeadlessSettings.mockResolvedValue({ defaultMode: 'headless' });

      await getState().loadSettings();

      expect(getState().projectOverrides).toEqual({});
    });

    it('handles null settings gracefully', async () => {
      mockGetHeadlessSettings.mockResolvedValue(null);

      await getState().loadSettings();

      expect(getState().defaultMode).toBe('headless');
      expect(getState().projectOverrides).toEqual({});
    });

    it('handles backend error gracefully', async () => {
      mockGetHeadlessSettings.mockRejectedValue(new Error('IPC error'));

      await getState().loadSettings();

      // Should keep current state (set to interactive in beforeEach)
      expect(getState().defaultMode).toBe('interactive');
      expect(getState().projectOverrides).toEqual({});
    });
  });

  // ============================================================
  // setDefaultMode
  // ============================================================
  describe('setDefaultMode', () => {
    it('updates defaultMode optimistically', async () => {
      await getState().setDefaultMode('headless');
      expect(getState().defaultMode).toBe('headless');
    });

    it('updates enabled for backwards compatibility', async () => {
      await getState().setDefaultMode('headless');
      expect(getState().enabled).toBe(true);

      await getState().setDefaultMode('interactive');
      expect(getState().enabled).toBe(false);

      await getState().setDefaultMode('structured');
      expect(getState().enabled).toBe(false);
    });

    it('persists defaultMode with current projectOverrides', async () => {
      useHeadlessStore.setState({ projectOverrides: { '/p': 'headless' } });

      await getState().setDefaultMode('structured');

      expect(mockSaveHeadlessSettings).toHaveBeenCalledWith({
        defaultMode: 'structured',
        projectOverrides: { '/p': 'headless' },
      });
    });

    it('rolls back on save failure', async () => {
      mockSaveHeadlessSettings.mockRejectedValue(new Error('save failed'));

      useHeadlessStore.setState({ defaultMode: 'interactive' });
      await getState().setDefaultMode('headless');

      // Should roll back to interactive
      expect(getState().defaultMode).toBe('interactive');
    });
  });

  // ============================================================
  // setEnabled (legacy)
  // ============================================================
  describe('setEnabled', () => {
    it('delegates to setDefaultMode', async () => {
      await getState().setEnabled(true);
      expect(getState().defaultMode).toBe('headless');

      await getState().setEnabled(false);
      expect(getState().defaultMode).toBe('interactive');
    });
  });

  // ============================================================
  // getProjectMode
  // ============================================================
  describe('getProjectMode', () => {
    it('returns interactive when global is interactive and no project override', () => {
      useHeadlessStore.setState({ defaultMode: 'interactive', projectOverrides: {} });
      expect(getState().getProjectMode('/some/project')).toBe('interactive');
    });

    it('returns headless when global is headless and no project override', () => {
      useHeadlessStore.setState({ defaultMode: 'headless', projectOverrides: {} });
      expect(getState().getProjectMode('/some/project')).toBe('headless');
    });

    it('returns structured when global is structured and no project override', () => {
      useHeadlessStore.setState({ defaultMode: 'structured', projectOverrides: {} });
      expect(getState().getProjectMode('/some/project')).toBe('structured');
    });

    it('project override headless overrides global interactive', () => {
      useHeadlessStore.setState({
        defaultMode: 'interactive',
        projectOverrides: { '/my/project': 'headless' },
      });
      expect(getState().getProjectMode('/my/project')).toBe('headless');
    });

    it('project override interactive overrides global headless', () => {
      useHeadlessStore.setState({
        defaultMode: 'headless',
        projectOverrides: { '/my/project': 'interactive' },
      });
      expect(getState().getProjectMode('/my/project')).toBe('interactive');
    });

    it('project override structured overrides global headless', () => {
      useHeadlessStore.setState({
        defaultMode: 'headless',
        projectOverrides: { '/my/project': 'structured' },
      });
      expect(getState().getProjectMode('/my/project')).toBe('structured');
    });

    it('falls back to global for projects without override', () => {
      useHeadlessStore.setState({
        defaultMode: 'headless',
        projectOverrides: { '/other/project': 'interactive' },
      });
      expect(getState().getProjectMode('/my/project')).toBe('headless');
    });

    it('returns global default when projectPath is undefined', () => {
      useHeadlessStore.setState({ defaultMode: 'headless', projectOverrides: {} });
      expect(getState().getProjectMode(undefined)).toBe('headless');
      expect(getState().getProjectMode()).toBe('headless');
    });

    it('handles empty projectPath string', () => {
      useHeadlessStore.setState({
        defaultMode: 'headless',
        projectOverrides: { '': 'interactive' },
      });
      // Empty string is falsy, so should fall back to global
      expect(getState().getProjectMode('')).toBe('headless');
    });
  });

  // ============================================================
  // setProjectMode
  // ============================================================
  describe('setProjectMode', () => {
    it('sets project override optimistically', async () => {
      await getState().setProjectMode('/my/project', 'headless');
      expect(getState().projectOverrides).toEqual({ '/my/project': 'headless' });
    });

    it('supports structured as project override', async () => {
      await getState().setProjectMode('/my/project', 'structured');
      expect(getState().projectOverrides).toEqual({ '/my/project': 'structured' });
    });

    it('preserves existing overrides when adding new one', async () => {
      useHeadlessStore.setState({
        projectOverrides: { '/project-a': 'headless' },
      });

      await getState().setProjectMode('/project-b', 'interactive');

      expect(getState().projectOverrides).toEqual({
        '/project-a': 'headless',
        '/project-b': 'interactive',
      });
    });

    it('overwrites existing override for same project', async () => {
      useHeadlessStore.setState({
        projectOverrides: { '/my/project': 'headless' },
      });

      await getState().setProjectMode('/my/project', 'structured');

      expect(getState().projectOverrides).toEqual({ '/my/project': 'structured' });
    });

    it('persists to backend with current defaultMode', async () => {
      useHeadlessStore.setState({ defaultMode: 'headless' });

      await getState().setProjectMode('/my/project', 'headless');

      expect(mockSaveHeadlessSettings).toHaveBeenCalledWith({
        defaultMode: 'headless',
        projectOverrides: { '/my/project': 'headless' },
      });
    });

    it('rolls back on save failure', async () => {
      mockSaveHeadlessSettings.mockRejectedValue(new Error('save failed'));
      useHeadlessStore.setState({
        projectOverrides: { '/project-a': 'headless' },
      });

      await getState().setProjectMode('/project-b', 'interactive');

      // Should roll back — project-b should not be in overrides
      expect(getState().projectOverrides).toEqual({ '/project-a': 'headless' });
    });
  });

  // ============================================================
  // clearProjectMode
  // ============================================================
  describe('clearProjectMode', () => {
    it('removes project override', async () => {
      useHeadlessStore.setState({
        projectOverrides: { '/my/project': 'headless', '/other': 'interactive' },
      });

      await getState().clearProjectMode('/my/project');

      expect(getState().projectOverrides).toEqual({ '/other': 'interactive' });
    });

    it('persists to backend without the cleared project', async () => {
      useHeadlessStore.setState({
        defaultMode: 'headless',
        projectOverrides: { '/my/project': 'headless' },
      });

      await getState().clearProjectMode('/my/project');

      expect(mockSaveHeadlessSettings).toHaveBeenCalledWith({
        defaultMode: 'headless',
        projectOverrides: {},
      });
    });

    it('falls back to global after clearing', async () => {
      useHeadlessStore.setState({
        defaultMode: 'headless',
        projectOverrides: { '/my/project': 'interactive' },
      });

      // Before clearing: override says interactive
      expect(getState().getProjectMode('/my/project')).toBe('interactive');

      await getState().clearProjectMode('/my/project');

      // After clearing: should use global (headless)
      expect(getState().getProjectMode('/my/project')).toBe('headless');
    });

    it('no-op when project has no override', async () => {
      useHeadlessStore.setState({
        projectOverrides: { '/other': 'headless' },
      });

      await getState().clearProjectMode('/my/project');

      expect(getState().projectOverrides).toEqual({ '/other': 'headless' });
    });

    it('rolls back on save failure', async () => {
      mockSaveHeadlessSettings.mockRejectedValue(new Error('save failed'));
      useHeadlessStore.setState({
        projectOverrides: { '/my/project': 'headless', '/other': 'interactive' },
      });

      await getState().clearProjectMode('/my/project');

      // Should roll back
      expect(getState().projectOverrides).toEqual({
        '/my/project': 'headless',
        '/other': 'interactive',
      });
    });
  });

  // ============================================================
  // Integration: getProjectMode reflects setProjectMode
  // ============================================================
  describe('integration', () => {
    it('getProjectMode reflects setProjectMode changes', async () => {
      useHeadlessStore.setState({ defaultMode: 'interactive' });

      expect(getState().getProjectMode('/my/project')).toBe('interactive');

      await getState().setProjectMode('/my/project', 'headless');

      expect(getState().getProjectMode('/my/project')).toBe('headless');
    });

    it('setDefaultMode + getProjectMode: override takes priority over global', async () => {
      await getState().setProjectMode('/my/project', 'interactive');
      await getState().setDefaultMode('headless');

      // Global is headless, but project override is interactive
      expect(getState().getProjectMode('/my/project')).toBe('interactive');
      // Other projects use global
      expect(getState().getProjectMode('/other/project')).toBe('headless');
    });

    it('structured override overrides headless global', async () => {
      await getState().setDefaultMode('headless');
      await getState().setProjectMode('/my/project', 'structured');

      expect(getState().getProjectMode('/my/project')).toBe('structured');
      expect(getState().getProjectMode('/other/project')).toBe('headless');
    });
  });

  // ============================================================
  // Race condition: snapshot state before optimistic set
  // ============================================================
  describe('race condition prevention', () => {
    it('setDefaultMode saves with pre-snapshot projectOverrides', async () => {
      useHeadlessStore.setState({
        defaultMode: 'interactive',
        projectOverrides: { '/a': 'headless' },
      });

      let resolveSave!: () => void;
      mockSaveHeadlessSettings.mockImplementation(
        () => new Promise<void>((r) => { resolveSave = r; }),
      );

      const promise = getState().setDefaultMode('headless');

      // Concurrent mutation while save is in-flight
      useHeadlessStore.setState({ projectOverrides: { '/a': 'headless', '/b': 'structured' } });

      resolveSave();
      await promise;

      // Save should use the snapshot taken before the concurrent mutation
      expect(mockSaveHeadlessSettings).toHaveBeenCalledWith({
        defaultMode: 'headless',
        projectOverrides: { '/a': 'headless' },
      });
    });

    it('setProjectMode saves with pre-snapshot defaultMode', async () => {
      useHeadlessStore.setState({ defaultMode: 'interactive', projectOverrides: {} });

      let resolveSave!: () => void;
      mockSaveHeadlessSettings.mockImplementation(
        () => new Promise<void>((r) => { resolveSave = r; }),
      );

      const promise = getState().setProjectMode('/a', 'headless');

      // Concurrent mutation while save is in-flight
      useHeadlessStore.setState({ defaultMode: 'structured' });

      resolveSave();
      await promise;

      expect(mockSaveHeadlessSettings).toHaveBeenCalledWith({
        defaultMode: 'interactive',
        projectOverrides: { '/a': 'headless' },
      });
    });

    it('clearProjectMode saves with pre-snapshot defaultMode', async () => {
      useHeadlessStore.setState({
        defaultMode: 'interactive',
        projectOverrides: { '/a': 'headless' },
      });

      let resolveSave!: () => void;
      mockSaveHeadlessSettings.mockImplementation(
        () => new Promise<void>((r) => { resolveSave = r; }),
      );

      const promise = getState().clearProjectMode('/a');

      // Concurrent mutation while save is in-flight
      useHeadlessStore.setState({ defaultMode: 'structured' });

      resolveSave();
      await promise;

      expect(mockSaveHeadlessSettings).toHaveBeenCalledWith({
        defaultMode: 'interactive',
        projectOverrides: {},
      });
    });
  });
});
