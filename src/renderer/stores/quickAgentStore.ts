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
  selectCompleted: (id: string | null) => void;
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
    const updated = [record, ...existing];
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

  selectCompleted: (id) => set({ selectedCompletedId: id }),
}));
