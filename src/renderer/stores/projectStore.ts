import { create } from 'zustand';
import { Project } from '../../shared/types';
import { useBadgeStore } from './badgeStore';
import { useUIStore } from './uiStore';

interface ProjectState {
  projects: Project[];
  activeProjectId: string | null;
  gitStatus: Record<string, boolean>; // projectId -> hasGit
  projectIcons: Record<string, string>; // projectId -> data URL
  setActiveProject: (id: string | null) => void;
  /** False until the first loadProjects settles, so an empty list can be told from "not loaded yet". */
  projectsLoaded: boolean;
  loadProjects: () => Promise<void>;
  /** Re-read how the known projects look, leaving the list and its order alone (#2597). */
  syncProjectDisplay: () => Promise<void>;
  addProject: (path: string) => Promise<Project>;
  removeProject: (id: string) => Promise<void>;
  pickAndAddProject: () => Promise<Project | null>;
  checkGit: (projectId: string, dirPath: string) => Promise<boolean>;
  gitInit: (projectId: string, dirPath: string) => Promise<boolean>;
  updateProject: (id: string, updates: Partial<Pick<Project, 'color' | 'icon' | 'emoji' | 'name' | 'displayName' | 'orchestrator'>>) => Promise<void>;
  pickProjectIcon: (projectId: string) => Promise<void>;
  pickProjectImage: () => Promise<string | null>;
  saveCroppedProjectIcon: (projectId: string, dataUrl: string) => Promise<void>;
  reorderProjects: (orderedIds: string[]) => Promise<void>;
  loadProjectIcon: (project: Project) => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  projectsLoaded: false,
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
    let projects: Project[];
    try {
      projects = await window.clubhouse.project.list();
    } catch (err) {
      set({ projectsLoaded: true });
      throw err;
    }
    set({ projects, projectsLoaded: true });
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

  syncProjectDisplay: async () => {
    const latest = new Map<string, Project>((await window.clubhouse.project.list()).map((p: Project) => [p.id, p]));
    const known = get().projects;
    // Adds and removes belong to whoever made them: their own replies update the list.
    const projects = known.map((p) => {
      const next = latest.get(p.id);
      if (!next) return p;
      const same = p.name === next.name && p.displayName === next.displayName && p.color === next.color && p.emoji === next.emoji && p.icon === next.icon;
      return same ? p : { ...p, name: next.name, displayName: next.displayName, color: next.color, emoji: next.emoji, icon: next.icon };
    });
    if (projects.every((p, i) => p === known[i])) return;
    set({ projects });
    const iconChanged = projects.filter((p, i) => p.icon !== known[i].icon);
    set((s) => {
      const projectIcons = { ...s.projectIcons };
      for (const p of iconChanged) delete projectIcons[p.id];
      return { projectIcons };
    });
    for (const p of iconChanged) void get().loadProjectIcon(p);
  },

  addProject: async (path) => {
    const project = await window.clubhouse.project.add(path);
    set((s) => ({ projects: [...s.projects, project] }));
    set({ activeProjectId: project.id });
    get().checkGit(project.id, project.path);
    if (project.icon) {
      get().loadProjectIcon(project);
    }
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
    useBadgeStore.getState().clearProjectBadges(id);
    // If settings was scoped to the removed project, fall back to app-level
    // so re-entering settings doesn't land on an empty "Select a project" state.
    if (useUIStore.getState().settingsContext === id) {
      useUIStore.getState().setSettingsContext('app');
    }
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
    // If icon was removed (or emoji set which clears icon), clear from cache
    if (updates.icon === '' || updates.emoji) {
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
