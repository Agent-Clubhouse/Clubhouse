/**
 * IPC handlers for agent queue management.
 */

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { agentQueueRegistry } from '../services/agent-queue-registry';
import { agentQueueTaskStore } from '../services/agent-queue-task-store';
import { initAgentQueueRunner } from '../services/agent-queue-runner';
import { isMcpEnabledForAny } from '../services/mcp-settings';
import { appLog } from '../services/log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { withValidatedArgs, stringArg, objectArg } from './validation';

function broadcastChanged(): void {
  agentQueueRegistry.list().then((queues) => {
    broadcastToAllWindows(IPC.AGENT_QUEUE.CHANGED, queues);
  }).catch(() => { /* ignore */ });
}

let handlersRegistered = false;

export function registerAgentQueueHandlers(): void {
  if (handlersRegistered) return;
  if (!isMcpEnabledForAny()) return;

  handlersRegistered = true;

  // Initialize the task runner (subscribes to agent exit events)
  initAgentQueueRunner();

  appLog('core:agent-queue', 'info', 'Agent queue handlers registered');

  // Subscribe to registry changes for renderer broadcast
  agentQueueRegistry.onChange(() => {
    broadcastChanged();
  });

  // Subscribe to task changes for renderer broadcast
  agentQueueTaskStore.onChange((queueId, taskId) => {
    broadcastToAllWindows(IPC.AGENT_QUEUE.TASK_CHANGED, { queueId, taskId });
  });

  ipcMain.handle(IPC.AGENT_QUEUE.LIST, async () => {
    return agentQueueRegistry.list();
  });

  ipcMain.handle(IPC.AGENT_QUEUE.CREATE, withValidatedArgs(
    [stringArg()],
    async (_event, name) => {
      const queue = await agentQueueRegistry.create(name as string);
      appLog('core:agent-queue', 'info', 'Agent queue created', { meta: { id: queue.id, name: queue.name } });
      return queue;
    },
  ));

  ipcMain.handle(IPC.AGENT_QUEUE.GET, withValidatedArgs(
    [stringArg()],
    async (_event, id) => {
      return agentQueueRegistry.get(id as string);
    },
  ));

  ipcMain.handle(IPC.AGENT_QUEUE.UPDATE, withValidatedArgs(
    [stringArg(), objectArg<Record<string, unknown>>()],
    async (_event, id, fields) => {
      const updated = await agentQueueRegistry.update(id as string, fields as Record<string, unknown>);
      if (updated) {
        appLog('core:agent-queue', 'info', 'Agent queue updated', { meta: { id } });
      }
      return updated;
    },
  ));

  ipcMain.handle(IPC.AGENT_QUEUE.DELETE, withValidatedArgs(
    [stringArg()],
    async (_event, id) => {
      const deleted = await agentQueueRegistry.delete(id as string);
      if (deleted) {
        await agentQueueTaskStore.deleteQueueTasks(id as string);
        appLog('core:agent-queue', 'info', 'Agent queue deleted', { meta: { id } });
      }
      return deleted;
    },
  ));

  ipcMain.handle(IPC.AGENT_QUEUE.LIST_TASKS, withValidatedArgs(
    [stringArg()],
    async (_event, queueId) => {
      return agentQueueTaskStore.listTaskSummaries(queueId as string);
    },
  ));

  ipcMain.handle(IPC.AGENT_QUEUE.GET_TASK, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, queueId, taskId) => {
      return agentQueueTaskStore.getTask(queueId as string, taskId as string);
    },
  ));
}
