import { create } from 'zustand';
import type { AgentQueue, AgentQueueTaskSummary, AgentQueueTask } from '../../shared/agent-queue-types';

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
      const queues = await window.clubhouse.agentQueue.list() as AgentQueue[];
      set({ queues: queues || [], loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  create: async (name) => {
    const queue = await window.clubhouse.agentQueue.create(name) as AgentQueue;
    set((state) => ({ queues: [...state.queues, queue] }));
    return queue;
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
    return await window.clubhouse.agentQueue.listTasks(queueId) as AgentQueueTaskSummary[];
  },

  getTask: async (queueId, taskId) => {
    return await window.clubhouse.agentQueue.getTask(queueId, taskId) as AgentQueueTask | null;
  },
}));

/** Initialize listener for agent queue changes from main process. */
export function initAgentQueueListener(): () => void {
  return window.clubhouse.agentQueue.onChanged((queues) => {
    useAgentQueueStore.setState({
      queues: (queues || []) as AgentQueue[],
    });
  });
}
