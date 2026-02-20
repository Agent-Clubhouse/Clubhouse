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

import { useHeadlessStore, SpawnMode } from './headlessStore';

function getState() {
  return useHeadlessStore.getState();
}

describe('headlessStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetHeadlessSettings.mockResolvedValue({ enabled: false });
    mockSaveHeadlessSettings.mockResolvedValue(undefined);
    useHeadlessStore.setState({
      enabled: false,
      projectOverrides: {},
    });
  });

  // ============================================================
  // loadSettings
  // ============================================================
  describe('loadSettings', () => {
    it('loads enabled state from backend', async () => {
      mockGetHeadlessSettings.mockResolvedValue({ enabled: true });

      await getState().loadSettings();

      expect(getState().enabled).toBe(true);
    });

    it('loads projectOverrides from backend', async () => {
      mockGetHeadlessSettings.mockResolvedValue({
        enabled: false,
        projectOverrides: { '/project-a': 'headless', '/project-b': 'interactive' },
      });

      await getState().loadSettings();

      expect(getState().projectOverrides).toEqual({
        '/project-a': 'headless',
        '/project-b': 'interactive',
      });
    });

    it('defaults projectOverrides to empty object when not present', async () => {
      mockGetHeadlessSettings.mockResolvedValue({ enabled: true });

      await getState().loadSettings();

      expect(getState().projectOverrides).toEqual({});
    });

    it('handles null settings gracefully', async () => {
      mockGetHeadlessSettings.mockResolvedValue(null);

      await getState().loadSettings();

      expect(getState().enabled).toBe(true);
      expect(getState().projectOverrides).toEqual({});
    });

    it('handles backend error gracefully', async () => {
      mockGetHeadlessSettings.mockRejectedValue(new Error('IPC error'));

      await getState().loadSettings();

      // Should keep current state (set to false in beforeEach)
      expect(getState().enabled).toBe(false);
      expect(getState().projectOverrides).toEqual({});
    });
  });

  // ============================================================
  // setEnabled
  // ============================================================
  describe('setEnabled', () => {
    it('updates enabled state optimistically', async () => {
      await getState().setEnabled(true);
      expect(getState().enabled).toBe(true);
    });

    it('persists enabled state with current projectOverrides', async () => {
      useHeadlessStore.setState({ projectOverrides: { '/p': 'headless' } });

      await getState().setEnabled(true);

      expect(mockSaveHeadlessSettings).toHaveBeenCalledWith({
        enabled: true,
        projectOverrides: { '/p': 'headless' },
      });
    });

    it('rolls back on save failure', async () => {
      mockSaveHeadlessSettings.mockRejectedValue(new Error('save failed'));

      useHeadlessStore.setState({ enabled: false });
      await getState().setEnabled(true);

      // Should roll back to false
      expect(getState().enabled).toBe(false);
    });
  });

  // ============================================================
  // getProjectMode
  // ============================================================
  describe('getProjectMode', () => {
    it('returns interactive when global disabled and no project override', () => {
      useHeadlessStore.setState({ enabled: false, projectOverrides: {} });
      expect(getState().getProjectMode('/some/project')).toBe('interactive');
    });

    it('returns headless when global enabled and no project override', () => {
      useHeadlessStore.setState({ enabled: true, projectOverrides: {} });
      expect(getState().getProjectMode('/some/project')).toBe('headless');
    });

    it('project override headless overrides global disabled', () => {
      useHeadlessStore.setState({
        enabled: false,
        projectOverrides: { '/my/project': 'headless' },
      });
      expect(getState().getProjectMode('/my/project')).toBe('headless');
    });

    it('project override interactive overrides global enabled', () => {
      useHeadlessStore.setState({
        enabled: true,
        projectOverrides: { '/my/project': 'interactive' },
      });
      expect(getState().getProjectMode('/my/project')).toBe('interactive');
    });

    it('falls back to global for projects without override', () => {
      useHeadlessStore.setState({
        enabled: true,
        projectOverrides: { '/other/project': 'interactive' },
      });
      expect(getState().getProjectMode('/my/project')).toBe('headless');
    });

    it('returns global default when projectPath is undefined', () => {
      useHeadlessStore.setState({ enabled: true, projectOverrides: {} });
      expect(getState().getProjectMode(undefined)).toBe('headless');
      expect(getState().getProjectMode()).toBe('headless');
    });

    it('handles empty projectPath string', () => {
      useHeadlessStore.setState({
        enabled: true,
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

      await getState().setProjectMode('/my/project', 'interactive');

      expect(getState().projectOverrides).toEqual({ '/my/project': 'interactive' });
    });

    it('persists to backend with current enabled state', async () => {
      useHeadlessStore.setState({ enabled: true });

      await getState().setProjectMode('/my/project', 'headless');

      expect(mockSaveHeadlessSettings).toHaveBeenCalledWith({
        enabled: true,
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
        enabled: true,
        projectOverrides: { '/my/project': 'headless' },
      });

      await getState().clearProjectMode('/my/project');

      expect(mockSaveHeadlessSettings).toHaveBeenCalledWith({
        enabled: true,
        projectOverrides: {},
      });
    });

    it('falls back to global after clearing', async () => {
      useHeadlessStore.setState({
        enabled: true,
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
      useHeadlessStore.setState({ enabled: false });

      expect(getState().getProjectMode('/my/project')).toBe('interactive');

      await getState().setProjectMode('/my/project', 'headless');

      expect(getState().getProjectMode('/my/project')).toBe('headless');
    });

    it('setEnabled + getProjectMode: override takes priority over global', async () => {
      await getState().setProjectMode('/my/project', 'interactive');
      await getState().setEnabled(true);

      // Global is headless, but project override is interactive
      expect(getState().getProjectMode('/my/project')).toBe('interactive');
      // Other projects use global
      expect(getState().getProjectMode('/other/project')).toBe('headless');
    });
  });
});
