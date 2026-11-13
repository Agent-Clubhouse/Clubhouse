import { create } from 'zustand';
import type {
  GroupProject, GroupProjectCreateOptions, GroupProjectMemberView, GroupProjectScope, GroupProjectScopeOptions,
} from '../../shared/group-project-types';

function isGroupProject(v: unknown): v is GroupProject {
  return typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).id === 'string' && typeof (v as Record<string, unknown>).name === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCompleteGroupProject(value: unknown): value is GroupProject {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string'
    || typeof value.description !== 'string' || typeof value.instructions !== 'string'
    || typeof value.createdAt !== 'string' || !isRecord(value.metadata)) {
    return false;
  }
  const scope = value.scope;
  return scope === undefined || (isRecord(scope)
    && (scope.reach === 'local' || scope.reach === 'network')
    && (scope.level === 'app' ? scope.projectId === undefined
      : scope.level === 'project' && typeof scope.projectId === 'string' && scope.projectId.length > 0));
}

interface GroupProjectStoreState {
  projects: GroupProject[];
  loaded: boolean;
  loadError: string | null;
  loadProjects: () => Promise<void>;
  create: (name: string, options?: GroupProjectCreateOptions) => Promise<GroupProject>;
  update: (id: string, fields: { name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> }) => Promise<void>;
  setPolling: (id: string, enabled: boolean) => Promise<void>;
  scopeOptions: () => Promise<GroupProjectScopeOptions>;
  previewScope: (id: string, scope: GroupProjectScope) => Promise<{ leaving: GroupProjectMemberView[]; returning: GroupProjectMemberView[] }>;
  setScope: (id: string, scope: GroupProjectScope, confirmLeaving: string[]) => Promise<GroupProject>;
  remove: (id: string, token: string) => Promise<void>;
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

  create: async (name, options) => {
    const raw = await window.clubhouse.groupProject.create(name, options);
    if (!isGroupProject(raw)) throw new Error('create returned invalid GroupProject');
    set((state) => state.projects.some((project) => project.id === raw.id)
      ? state
      : { projects: [...state.projects, raw] });
    return raw;
  },

  update: async (id, fields) => {
    const updated = await window.clubhouse.groupProject.update(id, fields);
    if (!isCompleteGroupProject(updated) || updated.id !== id) {
      throw new Error('Group project update was not confirmed. Reload the directory and try again.');
    }
    set((state) => ({
      projects: state.projects.map((p) => p.id === id ? updated : p),
    }));
  },

  setPolling: async (id, enabled) => {
    // Delegates the persist + member start/stop side-effect to the main process
    // (setProjectPolling), the same code path the toggle_polling MCP command uses.
    // Optimistically reflect the new setting so the Polling switch updates
    // immediately; the CHANGED broadcast will reconcile shortly after.
    await window.clubhouse.groupProject.setPolling(id, enabled);
    set((state) => ({
      projects: state.projects.map((p) =>
        p.id === id ? { ...p, metadata: { ...p.metadata, pollingEnabled: enabled } } : p,
      ),
    }));
  },

  scopeOptions: () => window.clubhouse.groupProject.scopeOptions(),

  previewScope: async (id, scope) => {
    const { leaving, returning } = await window.clubhouse.groupProject.previewScope(id, scope);
    return { leaving, returning: returning ?? [] };
  },

  setScope: async (id, scope, confirmLeaving) => {
    const { project } = await window.clubhouse.groupProject.setScope(id, scope, { confirmLeaving });
    if (!isCompleteGroupProject(project) || project.id !== id) {
      throw new Error('The scope change was not confirmed. Reload the directory and try again.');
    }
    set((state) => ({ projects: state.projects.map((p) => (p.id === id ? project : p)) }));
    return project;
  },

  remove: async (id, token) => {
    await window.clubhouse.groupProject.delete(id, token);
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
    // A delivered list is authoritative: it also clears an earlier load failure,
    // which would otherwise leave group-project wires waiting all session.
    useGroupProjectStore.setState(Array.isArray(projects) ? { projects: valid, loaded: true, loadError: null } : { projects: valid });
  });
}
