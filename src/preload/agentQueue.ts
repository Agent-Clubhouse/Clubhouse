import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const agentQueue = {
  agentQueue: {
  list: (): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC.AGENT_QUEUE.LIST),
  create: (name: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.AGENT_QUEUE.CREATE, name),
  get: (id: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.AGENT_QUEUE.GET, id),
  update: (id: string, fields: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke(IPC.AGENT_QUEUE.UPDATE, id, fields),
  delete: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.AGENT_QUEUE.DELETE, id),
  listTasks: (queueId: string): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC.AGENT_QUEUE.LIST_TASKS, queueId),
  getTask: (queueId: string, taskId: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.AGENT_QUEUE.GET_TASK, queueId, taskId),
  onChanged: (callback: (queues: unknown[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, queues: unknown[]) => callback(queues);
    ipcRenderer.on(IPC.AGENT_QUEUE.CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.AGENT_QUEUE.CHANGED, listener); };
  },
  onTaskChanged: (callback: (data: { queueId: string; taskId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]) => callback(data);
    ipcRenderer.on(IPC.AGENT_QUEUE.TASK_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.AGENT_QUEUE.TASK_CHANGED, listener); };
  },
  },
};
