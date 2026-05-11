import { create } from 'zustand';
import type { AgentQueue, AgentQueueTaskSummary, AgentQueueTask } from '../../shared/agent-queue-types';

function isAgentQueue(v: unknown): v is AgentQueue {
  return typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).id === 'string';
}

function isAgentQueueTaskSummary(v: unknown): v is AgentQueueTaskSummary {
  return typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).id === 'string' && typeof (v as Record<string, unknown>).queueId === 'string';
}

function isAgentQueueTask(v: unknown): v is AgentQueueTask {
  return typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).id === 'string' && typeof (v as Record<string, unknown>).status === 'string';
}

interface AgentQueueStoreState {
  queues: AgentQueue[];
  loaded: boolean;
  loadQueues: () => Promise<void>;
  create: (name: string) => Promise<AgentQueue>;
  update: (id: string, fields: Record<string, unknown>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  listTasks: (queueId: string) => Promise<AgentQueueTaskSummary[]>;
  getTask: (queueId: string, taskId: string) => Promise<AgentQueueTask | null>;
}

export const useAgentQueueStore = create<AgentQueueStoreState>((set) => ({
  queues: [],
  loaded: false,

  loadQueues: async () => {
    try {
      const raw = await window.clubhouse.agentQueue.list() as unknown[];
      const queues = Array.isArray(raw) ? raw.filter(isAgentQueue) : [];
      set({ queues, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  create: async (name) => {
    const raw = await window.clubhouse.agentQueue.create(name);
    if (!isAgentQueue(raw)) throw new Error('create returned invalid AgentQueue');
    set((state) => ({ queues: [...state.queues, raw] }));
    return raw;
  },

  update: async (id, fields) => {
    await window.clubhouse.agentQueue.update(id, fields);
    set((state) => ({
      queues: state.queues.map((q) => {
        if (q.id !== id) return q;
        const updated = { ...q, ...fields };
        if (fields.metadata) {
          updated.metadata = { ...q.metadata, ...(fields.metadata as Record<string, unknown>) };
        }
        return updated as AgentQueue;
      }),
    }));
  },

  remove: async (id) => {
    await window.clubhouse.agentQueue.delete(id);
    set((state) => ({
      queues: state.queues.filter((q) => q.id !== id),
    }));
  },

  listTasks: async (queueId) => {
    const raw = await window.clubhouse.agentQueue.listTasks(queueId) as unknown[];
    return Array.isArray(raw) ? raw.filter(isAgentQueueTaskSummary) : [];
  },

  getTask: async (queueId, taskId) => {
    const raw = await window.clubhouse.agentQueue.getTask(queueId, taskId);
    return isAgentQueueTask(raw) ? raw : null;
  },
}));

/** Initialize listener for agent queue changes from main process. */
export function initAgentQueueListener(): () => void {
  return window.clubhouse.agentQueue.onChanged((queues) => {
    const valid = Array.isArray(queues) ? (queues as unknown[]).filter(isAgentQueue) : [];
    useAgentQueueStore.setState({ queues: valid });
  });
}
