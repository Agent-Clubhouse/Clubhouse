import { create } from 'zustand';
import { Project } from '../../shared/types';

interface ProjectState {
  projects: Project[];
  activeProjectId: string | null;
  gitStatus: Record<string, boolean>; // projectId -> hasGit
  setActiveProject: (id: string | null) => void;
  loadProjects: () => Promise<void>;
  addProject: (path: string) => Promise<Project>;
  removeProject: (id: string) => Promise<void>;
  pickAndAddProject: () => Promise<Project | null>;
  checkGit: (projectId: string, dirPath: string) => Promise<boolean>;
  gitInit: (projectId: string, dirPath: string) => Promise<boolean>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  gitStatus: {},

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
      const activeProjectId =
        s.activeProjectId === id
          ? projects[0]?.id ?? null
          : s.activeProjectId;
      return { projects, activeProjectId, gitStatus };
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
}));
