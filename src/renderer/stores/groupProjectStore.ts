import { create } from 'zustand';
import type {
  GroupProject, GroupProjectCreateOptions, GroupProjectMemberView, GroupProjectOperations, GroupProjectScope, GroupProjectScopeOptions, RemoteCreateOutcome,
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
  /** #3550: each group project's changes waiting for its host or lately answered, as last read. */
  operations: Record<string, GroupProjectOperations>;
  loadOperations: (id: string) => Promise<void>;
  loadProjects: () => Promise<void>;
  create: (name: string, options?: GroupProjectCreateOptions) => Promise<GroupProject>;
  /** #3547: create on another computer; a created group's copy joins the list. */
  createOnHost: (host: string, name: string, options?: GroupProjectCreateOptions, retryOf?: string) => Promise<RemoteCreateOutcome>;
  update: (id: string, fields: { name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> }) => Promise<void>;
  scopeOptions: () => Promise<GroupProjectScopeOptions>;
  dismissRefusals: (id: string) => Promise<void>;
  previewScope: (id: string, scope: GroupProjectScope) => Promise<{ leaving: GroupProjectMemberView[]; returning: GroupProjectMemberView[] }>;
  setScope: (id: string, scope: GroupProjectScope, confirmLeaving: string[]) => Promise<GroupProject>;
  remove: (id: string, token: string) => Promise<void>;
  postBulletinMessage: (projectId: string, topic: string, body: string) => Promise<void>;
  deleteMessage: (projectId: string, topic: string, messageId: string) => Promise<boolean>;
  deleteTopic: (projectId: string, topic: string) => Promise<boolean>;
  setTopicProtection: (projectId: string, topic: string, isProtected: boolean) => Promise<boolean>;
  getRetentionConfig: (projectId: string) => Promise<{ maxPerTopic: number; maxTotal: number }>;
  saveRetentionConfig: (projectId: string, maxPerTopic: number, maxTotal: number) => Promise<{ saved: boolean; trimmed: number }>;
  clearAllMessages: (projectId: string) => Promise<{ removed: number }>;
  estimateTrim: (projectId: string, maxPerTopic: number, maxTotal: number) => Promise<{ wouldRemove: number }>;
}

/** Reads of one group project's operations that began; an older read never replaces a newer one. */
const operationReads = new Map<string, number>();

export const useGroupProjectStore = create<GroupProjectStoreState>((set) => ({
  projects: [],
  loaded: false,
  loadError: null,
  operations: {},

  loadOperations: async (id) => {
    const read = (operationReads.get(id) ?? 0) + 1;
    operationReads.set(id, read);
    try {
      const result = await window.clubhouse.groupProject.getOperations(id);
      if (operationReads.get(id) !== read || !result || !Array.isArray(result.operations)) return;
      set((state) => ({ operations: { ...state.operations, [id]: result } }));
    } catch {
      // telemetry-exempt: the last read stays; the next change in status reads again
    }
  },

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

  createOnHost: async (host, name, options, retryOf) => {
    const outcome = await window.clubhouse.groupProject.createOnHost(host, name, options, retryOf);
    if (outcome.status === 'created' && isGroupProject(outcome.project)) {
      const project = outcome.project;
      set((state) => state.projects.some((p) => p.id === project.id) ? state : { projects: [...state.projects, project] });
    }
    return outcome;
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



  scopeOptions: () => window.clubhouse.groupProject.scopeOptions(),

  dismissRefusals: async (id) => {
    await window.clubhouse.groupProject.dismissRefusals(id);
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id && p.network ? { ...p, network: { ...p.network, refusals: [] } } : p)),
    }));
  },

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
  const stopProjects = window.clubhouse.groupProject.onChanged((projects) => {
    const valid = Array.isArray(projects) ? (projects as unknown[]).filter(isGroupProject) : [];
    // A delivered list is authoritative: it also clears an earlier load failure,
    // which would otherwise leave group-project wires waiting all session.
    useGroupProjectStore.setState(Array.isArray(projects) ? { projects: valid, loaded: true, loadError: null } : { projects: valid });
  });
  // #3550: a change made on a copy moved (queued, applied or refused); read its status again.
  const stopOperations = window.clubhouse.groupProject.onOperationsChanged((id) => { void useGroupProjectStore.getState().loadOperations(id); });
  return () => { stopProjects(); stopOperations(); };
}
