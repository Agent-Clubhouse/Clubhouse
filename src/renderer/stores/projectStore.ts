import { create } from 'zustand';
import { Project } from '../../shared/types';

interface ProjectState {
  projects: Project[];
  activeProjectId: string | null;
  gitStatus: Record<string, boolean>; // projectId -> hasGit
  projectIcons: Record<string, string>; // projectId -> data URL
  setActiveProject: (id: string | null) => void;
  loadProjects: () => Promise<void>;
  addProject: (path: string) => Promise<Project>;
  removeProject: (id: string) => Promise<void>;
  pickAndAddProject: () => Promise<Project | null>;
  checkGit: (projectId: string, dirPath: string) => Promise<boolean>;
  gitInit: (projectId: string, dirPath: string) => Promise<boolean>;
  updateProject: (id: string, updates: Partial<Pick<Project, 'color' | 'icon' | 'name' | 'displayName' | 'orchestrator'>>) => Promise<void>;
  pickProjectIcon: (projectId: string) => Promise<void>;
  pickProjectImage: () => Promise<string | null>;
  saveCroppedProjectIcon: (projectId: string, dataUrl: string) => Promise<void>;
  reorderProjects: (orderedIds: string[]) => Promise<void>;
  loadProjectIcon: (project: Project) => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  gitStatus: {},
  projectIcons: {},

  setActiveProject: (id) => {
    set({ activeProjectId: id });
    // Check git when switching to a project
    if (id) {
      const project = get().projects.find((p) => p.id === id);
      if (project && get().gitStatus[id] === undefined) {
        get().checkGit(id, project.path);
      }
    }
  },

  loadProjects: async () => {
    const projects = await window.clubhouse.project.list();
    set({ projects });
    // Check git status for all projects
    for (const p of projects) {
      get().checkGit(p.id, p.path);
    }
    // Load icons for projects that have them
    for (const p of projects) {
      if (p.icon) {
        get().loadProjectIcon(p);
      }
    }
  },

  addProject: async (path) => {
    const project = await window.clubhouse.project.add(path);
    set((s) => ({ projects: [...s.projects, project] }));
    set({ activeProjectId: project.id });
    get().checkGit(project.id, project.path);
    return project;
  },

  removeProject: async (id) => {
    await window.clubhouse.project.remove(id);
    set((s) => {
      const projects = s.projects.filter((p) => p.id !== id);
      const { [id]: _, ...gitStatus } = s.gitStatus;
      const { [id]: __, ...projectIcons } = s.projectIcons;
      const activeProjectId =
        s.activeProjectId === id
          ? projects[0]?.id ?? null
          : s.activeProjectId;
      return { projects, activeProjectId, gitStatus, projectIcons };
    });
  },

  pickAndAddProject: async () => {
    const dirPath = await window.clubhouse.project.pickDirectory();
    if (!dirPath) return null;
    return get().addProject(dirPath);
  },

  checkGit: async (projectId, dirPath) => {
    const hasGit = await window.clubhouse.project.checkGit(dirPath);
    set((s) => ({ gitStatus: { ...s.gitStatus, [projectId]: hasGit } }));
    return hasGit;
  },

  gitInit: async (projectId, dirPath) => {
    const ok = await window.clubhouse.project.gitInit(dirPath);
    if (ok) {
      set((s) => ({ gitStatus: { ...s.gitStatus, [projectId]: true } }));
    }
    return ok;
  },

  updateProject: async (id, updates) => {
    const projects = await window.clubhouse.project.update(id, updates);
    set({ projects });
    // If icon was removed, clear from cache
    if (updates.icon === '') {
      set((s) => {
        const { [id]: _, ...projectIcons } = s.projectIcons;
        return { projectIcons };
      });
    }
  },

  pickProjectIcon: async (projectId) => {
    const filename = await window.clubhouse.project.pickIcon(projectId);
    if (!filename) return;
    // Reload projects to get updated icon field
    const projects = await window.clubhouse.project.list();
    set({ projects });
    // Load the new icon into cache
    const project = projects.find((p: Project) => p.id === projectId);
    if (project?.icon) {
      get().loadProjectIcon(project);
    }
  },

  pickProjectImage: async () => {
    return window.clubhouse.project.pickImage();
  },

  saveCroppedProjectIcon: async (projectId, dataUrl) => {
    const filename = await window.clubhouse.project.saveCroppedIcon(projectId, dataUrl);
    if (!filename) return;
    // Reload projects to get updated icon field
    const projects = await window.clubhouse.project.list();
    set({ projects });
    // Store the cropped data URL directly (no need to re-read)
    set((s) => ({
      projectIcons: { ...s.projectIcons, [projectId]: dataUrl },
    }));
  },

  reorderProjects: async (orderedIds) => {
    const projects = await window.clubhouse.project.reorder(orderedIds);
    set({ projects });
  },

  loadProjectIcon: async (project) => {
    if (!project.icon) return;
    const dataUrl = await window.clubhouse.project.readIcon(project.icon);
    if (dataUrl) {
      set((s) => ({
        projectIcons: { ...s.projectIcons, [project.id]: dataUrl },
      }));
    }
  },
}));
