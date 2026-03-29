import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useGroupProjectStore } from './groupProjectStore';

// Mock window.clubhouse.groupProject IPC
const mockList = vi.fn();
const mockOnChanged = vi.fn(() => () => {});

vi.stubGlobal('window', {
  clubhouse: {
    groupProject: {
      list: mockList,
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      postBulletinMessage: vi.fn(),
      sendShoulderTap: vi.fn(),
      onChanged: mockOnChanged,
    },
  },
});

describe('groupProjectStore', () => {
  beforeEach(() => {
    useGroupProjectStore.setState({ projects: [], loaded: false, loadError: null });
    vi.clearAllMocks();
  });

  describe('loadProjects', () => {
    it('sets projects and loaded on success', async () => {
      const mockProjects = [{ id: 'p1', name: 'Test Project' }];
      mockList.mockResolvedValue(mockProjects);

      await useGroupProjectStore.getState().loadProjects();

      const state = useGroupProjectStore.getState();
      expect(state.projects).toEqual(mockProjects);
      expect(state.loaded).toBe(true);
      expect(state.loadError).toBeNull();
    });

    it('sets loadError and logs on IPC failure', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockList.mockRejectedValue(new Error('IPC channel closed'));

      await useGroupProjectStore.getState().loadProjects();

      const state = useGroupProjectStore.getState();
      expect(state.loaded).toBe(true);
      expect(state.loadError).toBe('IPC channel closed');
      expect(state.projects).toEqual([]);
      expect(consoleSpy).toHaveBeenCalledWith(
        '[group-project] loadProjects failed:',
        'IPC channel closed',
      );

      consoleSpy.mockRestore();
    });

    it('clears previous loadError on successful retry', async () => {
      // First call fails
      mockList.mockRejectedValueOnce(new Error('Network error'));
      await useGroupProjectStore.getState().loadProjects();
      expect(useGroupProjectStore.getState().loadError).toBe('Network error');

      // Retry succeeds
      mockList.mockResolvedValueOnce([{ id: 'p1', name: 'Test' }]);
      await useGroupProjectStore.getState().loadProjects();

      const state = useGroupProjectStore.getState();
      expect(state.loadError).toBeNull();
      expect(state.projects).toHaveLength(1);
    });
  });
});
