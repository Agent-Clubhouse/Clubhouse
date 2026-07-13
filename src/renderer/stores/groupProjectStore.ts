import { create } from 'zustand';
import type { GroupProject } from '../../shared/group-project-types';

function isGroupProject(v: unknown): v is GroupProject {
  return typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).id === 'string' && typeof (v as Record<string, unknown>).name === 'string';
}

interface GroupProjectStoreState {
  projects: GroupProject[];
  loaded: boolean;
  loadError: string | null;
  loadProjects: () => Promise<void>;
  create: (name: string) => Promise<GroupProject>;
  update: (id: string, fields: { name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> }) => Promise<void>;
  setPolling: (id: string, enabled: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
  postBulletinMessage: (projectId: string, topic: string, body: string) => Promise<void>;
  sendShoulderTap: (projectId: string, targetAgentId: string | null, message: string) => Promise<unknown>;
  deleteMessage: (projectId: string, topic: string, messageId: string) => Promise<boolean>;
  deleteTopic: (projectId: string, topic: string) => Promise<boolean>;
  setTopicProtection: (projectId: string, topic: string, isProtected: boolean) => Promise<boolean>;
  getRetentionConfig: (projectId: string) => Promise<{ maxPerTopic: number; maxTotal: number }>;
  saveRetentionConfig: (projectId: string, maxPerTopic: number, maxTotal: number) => Promise<{ saved: boolean; trimmed: number }>;
  clearAllMessages: (projectId: string) => Promise<{ removed: number }>;
  estimateTrim: (projectId: string, maxPerTopic: number, maxTotal: number) => Promise<{ wouldRemove: number }>;
}

export const useGroupProjectStore = create<GroupProjectStoreState>((set) => ({
  projects: [],
  loaded: false,
  loadError: null,

  loadProjects: async () => {
    try {
      const raw = await window.clubhouse.groupProject.list() as unknown[];
      const projects = Array.isArray(raw) ? raw.filter(isGroupProject) : [];
      set({ projects, loaded: true, loadError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[group-project] loadProjects failed:', message);
      set({ loaded: true, loadError: message });
    }
  },

  create: async (name) => {
    const raw = await window.clubhouse.groupProject.create(name);
    if (!isGroupProject(raw)) throw new Error('create returned invalid GroupProject');
    set((state) => ({ projects: [...state.projects, raw] }));
    return raw;
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

  setPolling: async (id, enabled) => {
    // Delegates the persist + member start/stop side-effect to the main process
    // (setProjectPolling), the same code path the toggle_polling MCP command uses.
    // Optimistically reflect the new setting so the "Poll: On/Off" label updates
    // immediately; the CHANGED broadcast will reconcile shortly after.
    await window.clubhouse.groupProject.setPolling(id, enabled);
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === id ? { ...p, metadata: { ...p.metadata, pollingEnabled: enabled } } : p,
      ),
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

  deleteMessage: async (projectId, topic, messageId) => {
    return window.clubhouse.groupProject.deleteMessage(projectId, topic, messageId);
  },

  deleteTopic: async (projectId, topic) => {
    return window.clubhouse.groupProject.deleteTopic(projectId, topic);
  },

  setTopicProtection: async (projectId, topic, isProtected) => {
    return window.clubhouse.groupProject.setTopicProtection(projectId, topic, isProtected);
  },

  getRetentionConfig: async (projectId) => {
    return window.clubhouse.groupProject.getRetentionConfig(projectId);
  },

  saveRetentionConfig: async (projectId, maxPerTopic, maxTotal) => {
    return window.clubhouse.groupProject.saveRetentionConfig(projectId, maxPerTopic, maxTotal);
  },

  clearAllMessages: async (projectId) => {
    return window.clubhouse.groupProject.clearAllMessages(projectId);
  },

  estimateTrim: async (projectId, maxPerTopic, maxTotal) => {
    return window.clubhouse.groupProject.estimateTrim(projectId, maxPerTopic, maxTotal);
  },
}));

/** Initialize listener for group project changes from main process. */
export function initGroupProjectListener(): () => void {
  return window.clubhouse.groupProject.onChanged((projects) => {
    const valid = Array.isArray(projects) ? (projects as unknown[]).filter(isGroupProject) : [];
    useGroupProjectStore.setState({ projects: valid });
  });
}
