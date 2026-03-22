import { create } from 'zustand';
import type { GroupProject } from '../../shared/group-project-types';

interface GroupProjectStoreState {
  projects: GroupProject[];
  loaded: boolean;
  loadProjects: () => Promise<void>;
  create: (name: string) => Promise<GroupProject>;
  update: (id: string, fields: { name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  postBulletinMessage: (projectId: string, topic: string, body: string) => Promise<void>;
  sendShoulderTap: (projectId: string, targetAgentId: string | null, message: string) => Promise<unknown>;
}

export const useGroupProjectStore = create<GroupProjectStoreState>((set) => ({
  projects: [],
  loaded: false,

  loadProjects: async () => {
    try {
      const projects = await window.clubhouse.groupProject.list() as GroupProject[];
      set({ projects: projects || [], loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  create: async (name) => {
    const project = await window.clubhouse.groupProject.create(name) as GroupProject;
    set((state) => ({ projects: [...state.projects, project] }));
    return project;
  },

  update: async (id, fields) => {
    await window.clubhouse.groupProject.update(id, fields);
    set((state) => ({
      projects: state.projects.map((p) => {
        if (p.id !== id) return p;
        const updated = { ...p, ...fields };
        // Merge metadata rather than replacing it (matches main process behavior)
        if (fields.metadata) {
          updated.metadata = { ...p.metadata, ...fields.metadata };
        }
        return updated;
      }),
    }));
  },

  remove: async (id) => {
    await window.clubhouse.groupProject.delete(id);
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
    }));
  },

  postBulletinMessage: async (projectId, topic, body) => {
    await window.clubhouse.groupProject.postBulletinMessage(projectId, topic, body);
  },

  sendShoulderTap: async (projectId, targetAgentId, message) => {
    return window.clubhouse.groupProject.sendShoulderTap(projectId, targetAgentId, message);
  },
}));

/** Initialize listener for group project changes from main process. */
export function initGroupProjectListener(): () => void {
  return window.clubhouse.groupProject.onChanged((projects) => {
    useGroupProjectStore.setState({
      projects: (projects || []) as GroupProject[],
    });
  });
}
