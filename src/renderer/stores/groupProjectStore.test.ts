import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initGroupProjectListener, useGroupProjectStore } from './groupProjectStore';
import type { GroupProject } from '../../shared/group-project-types';

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
  const project: GroupProject = {
    id: 'gp-1', name: 'Board', description: '', instructions: '',
    createdAt: '2026-11-12T00:00:00Z', scope: { level: 'app', reach: 'local' },
    metadata: { pollingEnabled: true, source: 'preserved' },
  };

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

  describe('change listener', () => {
    it('clears an earlier load failure when a list arrives', () => {
      useGroupProjectStore.setState({ projects: [], loaded: true, loadError: 'IPC failed' });
      initGroupProjectListener();
      const deliver = (mockOnChanged.mock.calls.at(-1) as unknown as [(projects: unknown) => void])[0];
      deliver([{ id: 'gp-1', name: 'Board' }]);
      expect(useGroupProjectStore.getState()).toMatchObject({ loaded: true, loadError: null, projects: [{ id: 'gp-1', name: 'Board' }] });
    });

    it('keeps the authoritative broadcast when CHANGED arrives before CREATE resolves', async () => {
      let resolve!: (value: GroupProject) => void;
      vi.mocked(window.clubhouse.groupProject.create).mockReturnValue(new Promise((res) => { resolve = res; }));
      const cleanup = initGroupProjectListener();
      const deliver = (mockOnChanged.mock.calls.at(-1) as unknown as [(projects: unknown) => void])[0];
      const pending = useGroupProjectStore.getState().create(project.name);
      const broadcast = { ...project, description: 'Newer broadcast value' };
      deliver([broadcast]);
      resolve(project);
      await pending;
      expect(useGroupProjectStore.getState().projects).toEqual([broadcast]);
      cleanup();
    });

    it.each([null, {}, { id: 'different-id', name: 'Wrong board' }])('refuses an unconfirmed update without publishing it: %j', async (response) => {
      useGroupProjectStore.setState({ projects: [project] });
      vi.mocked(window.clubhouse.groupProject.update).mockResolvedValue(response);
      await expect(useGroupProjectStore.getState().update(project.id, { name: 'Unsaved' }))
        .rejects.toThrow('Group project update was not confirmed');
      expect(useGroupProjectStore.getState().projects).toEqual([project]);
    });

    it.each([
      { id: project.id, name: 'Partial response' },
      { ...project, instructions: 7 },
    ])('refuses an incomplete or malformed replacement and keeps the entire previous record: %j', async (response) => {
      useGroupProjectStore.setState({ projects: [project] });
      vi.mocked(window.clubhouse.groupProject.update).mockResolvedValue(response);
      await expect(useGroupProjectStore.getState().update(project.id, { instructions: 'Unsaved draft' }))
        .rejects.toThrow('Group project update was not confirmed');
      expect(useGroupProjectStore.getState().projects[0]).toBe(project);
    });

    it.each([
      { description: 7 },
      { createdAt: null },
      { metadata: [] },
      { scope: { level: 'project', reach: 'local', projectId: 7 } },
      { scope: { level: 'app', reach: 'unknown' } },
      { scope: { level: 'app', reach: 'local', projectId: 'contradictory' } },
    ])('refuses invalid required fields or nested scope before replacing the record: %j', async (invalid) => {
      useGroupProjectStore.setState({ projects: [project] });
      vi.mocked(window.clubhouse.groupProject.update).mockResolvedValue({ ...project, ...invalid });
      await expect(useGroupProjectStore.getState().update(project.id, { name: 'Unsaved' }))
        .rejects.toThrow('Group project update was not confirmed');
      expect(useGroupProjectStore.getState().projects[0]).toBe(project);
    });

    it.each([undefined, { level: 'project', reach: 'network', projectId: 'legacy-project' }])('preserves valid legacy records and their unknown fields: %j', async (scope) => {
      useGroupProjectStore.setState({ projects: [project] });
      const updated = { ...project, scope, legacySource: { retained: true }, metadata: { ...project.metadata, extra: [1, null, { kept: true }] } };
      vi.mocked(window.clubhouse.groupProject.update).mockResolvedValue(updated);
      await useGroupProjectStore.getState().update(project.id, { description: 'Requested' });
      expect(useGroupProjectStore.getState().projects[0]).toBe(updated);
    });

    it('publishes the actual confirmed update, preserving scope and metadata returned by the registry', async () => {
      useGroupProjectStore.setState({ projects: [project] });
      const updated = { ...project, name: 'Confirmed', instructions: '  exact\n' };
      vi.mocked(window.clubhouse.groupProject.update).mockResolvedValue(updated);
      await useGroupProjectStore.getState().update(project.id, { name: 'Requested' });
      expect(useGroupProjectStore.getState().projects).toEqual([updated]);
    });
  });
});
