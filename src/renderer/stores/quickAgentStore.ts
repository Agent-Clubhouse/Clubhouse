import { create } from 'zustand';
import { CompletedQuickAgent } from '../../shared/types';

function storageKey(projectId: string): string {
  return `quick_completed_${projectId}`;
}

function loadFromStorage(projectId: string): CompletedQuickAgent[] {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveToStorage(projectId: string, records: CompletedQuickAgent[]): void {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(records));
  } catch {
    // Ignore quota errors
  }
}

interface QuickAgentState {
  completedAgents: Record<string, CompletedQuickAgent[]>;
  selectedCompletedId: string | null;
  loadCompleted: (projectId: string) => void;
  addCompleted: (record: CompletedQuickAgent) => void;
  dismissCompleted: (projectId: string, agentId: string) => void;
  clearCompleted: (projectId: string) => void;
  getCompleted: (projectId: string) => CompletedQuickAgent[];
  getCompletedByParent: (projectId: string, parentAgentId: string) => CompletedQuickAgent[];
  getCompletedOrphans: (projectId: string) => CompletedQuickAgent[];
  selectCompleted: (id: string | null) => void;
  getSelectedCompleted: () => CompletedQuickAgent | null;
}

export const useQuickAgentStore = create<QuickAgentState>((set, get) => ({
  completedAgents: {},
  selectedCompletedId: null,

  loadCompleted: (projectId) => {
    const records = loadFromStorage(projectId);
    set((s) => ({
      completedAgents: { ...s.completedAgents, [projectId]: records },
    }));
  },

  addCompleted: (record) => {
    const existing = get().completedAgents[record.projectId] || [];
    const updated = [...existing, record];
    saveToStorage(record.projectId, updated);
    set((s) => ({
      completedAgents: { ...s.completedAgents, [record.projectId]: updated },
    }));
  },

  dismissCompleted: (projectId, agentId) => {
    const existing = get().completedAgents[projectId] || [];
    const updated = existing.filter((r) => r.id !== agentId);
    saveToStorage(projectId, updated);
    set((s) => ({
      completedAgents: { ...s.completedAgents, [projectId]: updated },
    }));
  },

  clearCompleted: (projectId) => {
    saveToStorage(projectId, []);
    set((s) => ({
      completedAgents: { ...s.completedAgents, [projectId]: [] },
    }));
  },

  getCompleted: (projectId) => {
    return get().completedAgents[projectId] || [];
  },

  getCompletedByParent: (projectId, parentAgentId) => {
    return (get().completedAgents[projectId] || []).filter(
      (r) => r.parentAgentId === parentAgentId
    );
  },

  getCompletedOrphans: (projectId) => {
    return (get().completedAgents[projectId] || []).filter(
      (r) => !r.parentAgentId
    );
  },

  selectCompleted: (id) => set({ selectedCompletedId: id }),

  getSelectedCompleted: () => {
    const id = get().selectedCompletedId;
    if (!id) return null;
    for (const records of Object.values(get().completedAgents)) {
      const found = records.find((r) => r.id === id);
      if (found) return found;
    }
    return null;
  },
}));
