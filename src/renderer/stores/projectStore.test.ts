import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Project } from '../../shared/types';

// ---------- IPC mock ----------
const mockProject = {
  list: vi.fn<() => Promise<Project[]>>().mockResolvedValue([]),
  add: vi.fn<(path: string) => Promise<Project>>(),
  remove: vi.fn().mockResolvedValue(undefined),
  pickDirectory: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
  checkGit: vi.fn<(dir: string) => Promise<boolean>>().mockResolvedValue(false),
  gitInit: vi.fn<(dir: string) => Promise<boolean>>().mockResolvedValue(true),
  update: vi.fn<(id: string, updates: Partial<Project>) => Promise<Project[]>>(),
  pickIcon: vi.fn<(id: string) => Promise<string | null>>().mockResolvedValue(null),
  reorder: vi.fn<(ids: string[]) => Promise<Project[]>>(),
  readIcon: vi.fn<(filename: string) => Promise<string | null>>().mockResolvedValue(null),
  pickImage: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
  saveCroppedIcon: vi.fn<(id: string, dataUrl: string) => Promise<string | null>>().mockResolvedValue(null),
};

Object.defineProperty(globalThis, 'window', {
  value: { clubhouse: { project: mockProject } },
  writable: true,
});

import { useProjectStore } from './projectStore';

// ---------- helpers ----------
function getState() {
  return useProjectStore.getState();
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj_1',
    name: 'my-project',
    path: '/home/user/my-project',
    ...overrides,
  };
}

// ---------- tests ----------
describe('projectStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({
      projects: [],
      activeProjectId: null,
      gitStatus: {},
      projectIcons: {},
    });
  });

  // ---- defaults ----
  describe('initialization', () => {
    it('has correct defaults', () => {
      const s = getState();
      expect(s.projects).toEqual([]);
      expect(s.activeProjectId).toBeNull();
      expect(s.gitStatus).toEqual({});
      expect(s.projectIcons).toEqual({});
    });
  });

  // ---- setActiveProject ----
  describe('setActiveProject', () => {
    it('sets activeProjectId', () => {
      getState().setActiveProject('proj_1');
      expect(getState().activeProjectId).toBe('proj_1');
    });

    it('sets activeProjectId to null', () => {
      useProjectStore.setState({ activeProjectId: 'proj_1' });
      getState().setActiveProject(null);
      expect(getState().activeProjectId).toBeNull();
    });

    it('triggers checkGit for unknown project', () => {
      const p = makeProject();
      useProjectStore.setState({ projects: [p] });
      mockProject.checkGit.mockResolvedValueOnce(true);

      getState().setActiveProject('proj_1');

      expect(mockProject.checkGit).toHaveBeenCalledWith(p.path);
    });

    it('does not re-check git when status already known', () => {
      const p = makeProject();
      useProjectStore.setState({ projects: [p], gitStatus: { proj_1: true } });

      getState().setActiveProject('proj_1');

      expect(mockProject.checkGit).not.toHaveBeenCalled();
    });

    it('does not check git when setting to null', () => {
      getState().setActiveProject(null);
      expect(mockProject.checkGit).not.toHaveBeenCalled();
    });
  });

  // ---- loadProjects ----
  describe('loadProjects', () => {
    it('loads projects from IPC and stores them', async () => {
      const projects = [makeProject(), makeProject({ id: 'proj_2', name: 'other', path: '/other' })];
      mockProject.list.mockResolvedValueOnce(projects);
      mockProject.checkGit.mockResolvedValue(false);

      await getState().loadProjects();

      expect(getState().projects).toEqual(projects);
    });

    it('checks git status for every project', async () => {
      const projects = [makeProject(), makeProject({ id: 'proj_2', name: 'other', path: '/other' })];
      mockProject.list.mockResolvedValueOnce(projects);
      mockProject.checkGit.mockResolvedValue(false);

      await getState().loadProjects();

      expect(mockProject.checkGit).toHaveBeenCalledTimes(2);
      expect(mockProject.checkGit).toHaveBeenCalledWith('/home/user/my-project');
      expect(mockProject.checkGit).toHaveBeenCalledWith('/other');
    });

    it('loads icons for projects that have them', async () => {
      const withIcon = makeProject({ icon: 'icon.png' });
      const withoutIcon = makeProject({ id: 'proj_2', name: 'other', path: '/other' });
      mockProject.list.mockResolvedValueOnce([withIcon, withoutIcon]);
      mockProject.checkGit.mockResolvedValue(false);
      mockProject.readIcon.mockResolvedValueOnce('data:image/png;base64,abc');

      await getState().loadProjects();

      expect(mockProject.readIcon).toHaveBeenCalledWith('icon.png');
    });
  });

  // ---- addProject ----
  describe('addProject', () => {
    it('adds a project and sets it active', async () => {
      const p = makeProject();
      mockProject.add.mockResolvedValueOnce(p);
      mockProject.checkGit.mockResolvedValueOnce(true);

      const result = await getState().addProject('/home/user/my-project');

      expect(result).toEqual(p);
      expect(getState().projects).toEqual([p]);
      expect(getState().activeProjectId).toBe('proj_1');
      expect(mockProject.checkGit).toHaveBeenCalledWith(p.path);
    });

    it('appends to existing projects', async () => {
      const existing = makeProject({ id: 'proj_0', name: 'existing', path: '/existing' });
      useProjectStore.setState({ projects: [existing] });

      const p = makeProject();
      mockProject.add.mockResolvedValueOnce(p);
      mockProject.checkGit.mockResolvedValueOnce(false);

      await getState().addProject(p.path);

      expect(getState().projects).toHaveLength(2);
    });
  });

  // ---- removeProject ----
  describe('removeProject', () => {
    it('removes project and cleans up gitStatus and projectIcons', async () => {
      const p = makeProject();
      useProjectStore.setState({
        projects: [p],
        activeProjectId: 'proj_1',
        gitStatus: { proj_1: true },
        projectIcons: { proj_1: 'data:image/png;base64,abc' },
      });

      await getState().removeProject('proj_1');

      expect(getState().projects).toEqual([]);
      expect(getState().gitStatus).toEqual({});
      expect(getState().projectIcons).toEqual({});
      expect(mockProject.remove).toHaveBeenCalledWith('proj_1');
    });

    it('falls back to first remaining project when active is removed', async () => {
      const p1 = makeProject();
      const p2 = makeProject({ id: 'proj_2', name: 'other', path: '/other' });
      useProjectStore.setState({ projects: [p1, p2], activeProjectId: 'proj_1' });

      await getState().removeProject('proj_1');

      expect(getState().activeProjectId).toBe('proj_2');
    });

    it('sets activeProjectId to null when all projects removed', async () => {
      const p = makeProject();
      useProjectStore.setState({ projects: [p], activeProjectId: 'proj_1' });

      await getState().removeProject('proj_1');

      expect(getState().activeProjectId).toBeNull();
    });

    it('keeps activeProjectId when a non-active project is removed', async () => {
      const p1 = makeProject();
      const p2 = makeProject({ id: 'proj_2', name: 'other', path: '/other' });
      useProjectStore.setState({ projects: [p1, p2], activeProjectId: 'proj_1' });

      await getState().removeProject('proj_2');

      expect(getState().activeProjectId).toBe('proj_1');
    });
  });

  // ---- pickAndAddProject ----
  describe('pickAndAddProject', () => {
    it('returns null when user cancels directory picker', async () => {
      mockProject.pickDirectory.mockResolvedValueOnce(null);

      const result = await getState().pickAndAddProject();

      expect(result).toBeNull();
    });

    it('adds project when directory is picked', async () => {
      const p = makeProject();
      mockProject.pickDirectory.mockResolvedValueOnce('/home/user/my-project');
      mockProject.add.mockResolvedValueOnce(p);
      mockProject.checkGit.mockResolvedValueOnce(false);

      const result = await getState().pickAndAddProject();

      expect(result).toEqual(p);
      expect(getState().activeProjectId).toBe('proj_1');
    });
  });

  // ---- checkGit ----
  describe('checkGit', () => {
    it('stores git status for a project', async () => {
      mockProject.checkGit.mockResolvedValueOnce(true);

      const result = await getState().checkGit('proj_1', '/home/user/proj');

      expect(result).toBe(true);
      expect(getState().gitStatus).toEqual({ proj_1: true });
    });

    it('preserves existing git statuses', async () => {
      useProjectStore.setState({ gitStatus: { proj_0: false } });
      mockProject.checkGit.mockResolvedValueOnce(true);

      await getState().checkGit('proj_1', '/home/user/proj');

      expect(getState().gitStatus).toEqual({ proj_0: false, proj_1: true });
    });
  });

  // ---- gitInit ----
  describe('gitInit', () => {
    it('sets git status to true on success', async () => {
      mockProject.gitInit.mockResolvedValueOnce(true);

      const result = await getState().gitInit('proj_1', '/home/user/proj');

      expect(result).toBe(true);
      expect(getState().gitStatus).toEqual({ proj_1: true });
    });

    it('does not update status on failure', async () => {
      mockProject.gitInit.mockResolvedValueOnce(false);

      const result = await getState().gitInit('proj_1', '/home/user/proj');

      expect(result).toBe(false);
      expect(getState().gitStatus).toEqual({});
    });
  });

  // ---- updateProject ----
  describe('updateProject', () => {
    it('updates projects from IPC response', async () => {
      const updated = [makeProject({ name: 'renamed' })];
      mockProject.update.mockResolvedValueOnce(updated);

      await getState().updateProject('proj_1', { name: 'renamed' });

      expect(getState().projects).toEqual(updated);
      expect(mockProject.update).toHaveBeenCalledWith('proj_1', { name: 'renamed' });
    });

    it('clears icon cache when icon is removed', async () => {
      useProjectStore.setState({ projectIcons: { proj_1: 'data:image/png;base64,abc' } });
      mockProject.update.mockResolvedValueOnce([makeProject({ icon: '' })]);

      await getState().updateProject('proj_1', { icon: '' });

      expect(getState().projectIcons).toEqual({});
    });

    it('keeps icon cache when icon is not removed', async () => {
      useProjectStore.setState({ projectIcons: { proj_1: 'data:image/png;base64,abc' } });
      mockProject.update.mockResolvedValueOnce([makeProject({ name: 'new-name' })]);

      await getState().updateProject('proj_1', { name: 'new-name' });

      expect(getState().projectIcons).toEqual({ proj_1: 'data:image/png;base64,abc' });
    });
  });

  // ---- pickProjectIcon ----
  describe('pickProjectIcon', () => {
    it('does nothing when pick is cancelled', async () => {
      mockProject.pickIcon.mockResolvedValueOnce(null);

      await getState().pickProjectIcon('proj_1');

      expect(mockProject.list).not.toHaveBeenCalled();
    });

    it('reloads projects and icon on success', async () => {
      const p = makeProject({ icon: 'new-icon.png' });
      mockProject.pickIcon.mockResolvedValueOnce('new-icon.png');
      mockProject.list.mockResolvedValueOnce([p]);
      mockProject.readIcon.mockResolvedValueOnce('data:image/png;base64,newicon');

      await getState().pickProjectIcon('proj_1');

      expect(getState().projects).toEqual([p]);
      expect(mockProject.readIcon).toHaveBeenCalledWith('new-icon.png');
    });
  });

  // ---- pickProjectImage ----
  describe('pickProjectImage', () => {
    it('delegates to IPC', async () => {
      mockProject.pickImage.mockResolvedValueOnce('data:image/png;base64,img');

      const result = await getState().pickProjectImage();

      expect(result).toBe('data:image/png;base64,img');
    });
  });

  // ---- saveCroppedProjectIcon ----
  describe('saveCroppedProjectIcon', () => {
    it('does nothing when save returns no filename', async () => {
      mockProject.saveCroppedIcon.mockResolvedValueOnce(null);

      await getState().saveCroppedProjectIcon('proj_1', 'data:image/png;base64,cropped');

      expect(mockProject.list).not.toHaveBeenCalled();
    });

    it('reloads projects and caches data URL directly', async () => {
      const p = makeProject({ icon: 'cropped.png' });
      mockProject.saveCroppedIcon.mockResolvedValueOnce('cropped.png');
      mockProject.list.mockResolvedValueOnce([p]);

      const dataUrl = 'data:image/png;base64,cropped';
      await getState().saveCroppedProjectIcon('proj_1', dataUrl);

      expect(getState().projects).toEqual([p]);
      expect(getState().projectIcons).toEqual({ proj_1: dataUrl });
    });
  });

  // ---- reorderProjects ----
  describe('reorderProjects', () => {
    it('updates projects from IPC response', async () => {
      const reordered = [
        makeProject({ id: 'proj_2', name: 'second', path: '/second' }),
        makeProject(),
      ];
      mockProject.reorder.mockResolvedValueOnce(reordered);

      await getState().reorderProjects(['proj_2', 'proj_1']);

      expect(getState().projects).toEqual(reordered);
      expect(mockProject.reorder).toHaveBeenCalledWith(['proj_2', 'proj_1']);
    });
  });

  // ---- loadProjectIcon ----
  describe('loadProjectIcon', () => {
    it('loads icon into cache', async () => {
      mockProject.readIcon.mockResolvedValueOnce('data:image/png;base64,loaded');
      const p = makeProject({ icon: 'icon.png' });

      await getState().loadProjectIcon(p);

      expect(getState().projectIcons).toEqual({ proj_1: 'data:image/png;base64,loaded' });
    });

    it('does nothing when project has no icon', async () => {
      const p = makeProject({ icon: undefined });

      await getState().loadProjectIcon(p);

      expect(mockProject.readIcon).not.toHaveBeenCalled();
      expect(getState().projectIcons).toEqual({});
    });

    it('does nothing when readIcon returns null', async () => {
      mockProject.readIcon.mockResolvedValueOnce(null);
      const p = makeProject({ icon: 'missing.png' });

      await getState().loadProjectIcon(p);

      expect(getState().projectIcons).toEqual({});
    });
  });
});
