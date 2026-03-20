/**
 * IPC handlers for group project management.
 */

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { groupProjectRegistry } from '../services/group-project-registry';
import { getBulletinBoard, destroyBulletinBoard } from '../services/group-project-bulletin';
import { registerGroupProjectTools } from '../services/clubhouse-mcp/tools/group-project-tools';
import { initGroupProjectLifecycle } from '../services/group-project-lifecycle';
import { executeShoulderTap } from '../services/group-project-shoulder-tap';
import { isMcpEnabledForAny } from '../services/mcp-settings';
import { appLog } from '../services/log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { withValidatedArgs, stringArg, objectArg, numberArg } from './validation';

function broadcastChanged(): void {
  groupProjectRegistry.list().then((projects) => {
    broadcastToAllWindows(IPC.GROUP_PROJECT.CHANGED, projects);
  }).catch(() => { /* ignore */ });
}

let handlersRegistered = false;

export function registerGroupProjectHandlers(): void {
  if (handlersRegistered) return;
  if (!isMcpEnabledForAny()) return;

  handlersRegistered = true;

  // Register tool templates and lifecycle hooks
  registerGroupProjectTools();
  initGroupProjectLifecycle();

  appLog('core:group-project', 'info', 'Group project handlers registered');

  // Subscribe to registry changes for renderer broadcast
  groupProjectRegistry.onChange(() => {
    broadcastChanged();
  });

  ipcMain.handle(IPC.GROUP_PROJECT.LIST, async () => {
    return groupProjectRegistry.list();
  });

  ipcMain.handle(IPC.GROUP_PROJECT.CREATE, withValidatedArgs(
    [stringArg()],
    async (_event, name) => {
      const project = await groupProjectRegistry.create(name as string);
      appLog('core:group-project', 'info', 'Group project created', { meta: { id: project.id, name: project.name } });
      return project;
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.GET, withValidatedArgs(
    [stringArg()],
    async (_event, id) => {
      return groupProjectRegistry.get(id as string);
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.UPDATE, withValidatedArgs(
    [stringArg(), objectArg<{ name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> }>()],
    async (_event, id, fields) => {
      const updated = await groupProjectRegistry.update(id as string, fields as { name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> });
      if (updated) {
        appLog('core:group-project', 'info', 'Group project updated', { meta: { id } });
      }
      return updated;
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.DELETE, withValidatedArgs(
    [stringArg()],
    async (_event, id) => {
      const deleted = await groupProjectRegistry.delete(id as string);
      if (deleted) {
        destroyBulletinBoard(id as string);
        appLog('core:group-project', 'info', 'Group project deleted', { meta: { id } });
      }
      return deleted;
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.GET_BULLETIN_DIGEST, withValidatedArgs(
    [stringArg(), stringArg({ optional: true })],
    async (_event, id, since) => {
      const board = getBulletinBoard(id as string);
      return board.getDigest(since as string | undefined);
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.GET_TOPIC_MESSAGES, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ optional: true }), numberArg({ optional: true })],
    async (_event, id, topic, since, limit) => {
      const board = getBulletinBoard(id as string);
      return board.getTopicMessages(
        topic as string,
        since as string | undefined,
        limit as number | undefined,
      );
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.GET_ALL_MESSAGES, withValidatedArgs(
    [stringArg(), stringArg({ optional: true }), numberArg({ optional: true })],
    async (_event, id, since, limit) => {
      const board = getBulletinBoard(id as string);
      return board.getAllMessages(
        since as string | undefined,
        limit as number | undefined,
      );
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.POST_BULLETIN_MESSAGE, withValidatedArgs(
    [stringArg(), stringArg(), stringArg()],
    async (_event, projectId, topic, body) => {
      const board = getBulletinBoard(projectId as string);
      return board.postMessage('user', topic as string, body as string);
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.SEND_SHOULDER_TAP, withValidatedArgs(
    [stringArg(), stringArg({ optional: true }), stringArg()],
    async (_event, projectId, targetAgentId, message) => {
      return executeShoulderTap({
        projectId: projectId as string,
        senderLabel: 'user',
        targetAgentId: (targetAgentId as string) || null,
        message: message as string,
      });
    },
  ));
}
