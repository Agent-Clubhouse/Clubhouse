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
import * as annexEventBus from '../services/annex-event-bus';
import { isMcpEnabledForAny } from '../services/mcp-settings';
import { appLog } from '../services/log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { withValidatedArgs, stringArg, objectArg, numberArg, booleanArg } from './validation';
import { agentRegistry } from '../services/agent-registry';
import * as ptyManager from '../services/pty-manager';
import * as structuredManager from '../services/structured-manager';
import { writeChunkedBracketedPaste, submitAfterPaste } from '../services/clubhouse-mcp/tools/agent-tools';
import { getProvider } from '../orchestrators';
import type { PasteSubmitTiming } from '../orchestrators';

function broadcastChanged(): void {
  groupProjectRegistry.list().then((projects) => {
    broadcastToAllWindows(IPC.GROUP_PROJECT.CHANGED, projects);
  }).catch(() => { /* ignore */ });
}

let handlersRegistered = false;

/** For testing only: reset the registration guard so handlers can be re-registered. */
export function _resetHandlersForTesting(): void {
  handlersRegistered = false;
}

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
      annexEventBus.emitGroupProjectChanged('created', project);
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
        annexEventBus.emitGroupProjectChanged('updated', updated);
        appLog('core:group-project', 'info', 'Group project updated', { meta: { id } });
      }
      return updated;
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.DELETE, withValidatedArgs(
    [stringArg()],
    async (_event, id) => {
      const project = await groupProjectRegistry.get(id as string);
      const deleted = await groupProjectRegistry.delete(id as string);
      if (deleted) {
        if (project) annexEventBus.emitGroupProjectChanged('deleted', project);
        await destroyBulletinBoard(id as string);
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
      const message = await board.postMessage('user', topic as string, body as string);
      annexEventBus.emitBulletinMessage(projectId as string, message);
      return message;
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

  ipcMain.handle(IPC.GROUP_PROJECT.DELETE_MESSAGE, withValidatedArgs(
    [stringArg(), stringArg(), stringArg()],
    async (_event, projectId, topic, messageId) => {
      const board = getBulletinBoard(projectId as string);
      return board.deleteMessage(topic as string, messageId as string);
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.DELETE_TOPIC, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectId, topic) => {
      const board = getBulletinBoard(projectId as string);
      return board.deleteTopic(topic as string);
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.SET_TOPIC_PROTECTION, withValidatedArgs(
    [stringArg(), stringArg(), booleanArg()],
    async (_event, projectId, topic, isProtected) => {
      const board = getBulletinBoard(projectId as string);
      board.setTopicProtected(topic as string, isProtected as boolean);
      return true;
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.GET_RETENTION_CONFIG, withValidatedArgs(
    [stringArg()],
    async (_event, projectId) => {
      const project = await groupProjectRegistry.get(projectId as string);
      return {
        maxPerTopic: (project?.metadata?.maxPerTopic as number) ?? 500,
        maxTotal: (project?.metadata?.maxTotal as number) ?? 2500,
      };
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.SAVE_RETENTION_CONFIG, withValidatedArgs(
    [stringArg(), numberArg({ integer: true, min: 1 }), numberArg({ integer: true, min: 1 })],
    async (_event, projectId, maxPerTopic, maxTotal) => {
      await groupProjectRegistry.update(projectId as string, {
        metadata: { maxPerTopic: maxPerTopic as number, maxTotal: maxTotal as number },
      });
      const board = getBulletinBoard(projectId as string);
      board.setLimits(maxPerTopic as number, maxTotal as number);
      broadcastChanged();
      return true;
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.INJECT_MESSAGE, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, agentId, message) => {
      const reg = agentRegistry.get(agentId as string);
      if (!reg) throw new Error(`Agent ${agentId} is not registered`);

      if (reg.runtime === 'pty') {
        const isMultiLine = (message as string).includes('\n');
        if (isMultiLine) {
          const provider = getProvider(reg.orchestrator);
          const timing: PasteSubmitTiming = provider?.getPasteSubmitTiming()
            ?? { initialDelayMs: 350, retryDelayMs: 300, finalCheckDelayMs: 250, chunkSize: 512, chunkDelayMs: 30 };

          await writeChunkedBracketedPaste(agentId as string, message as string, timing.chunkSize, timing.chunkDelayMs);
          await submitAfterPaste(agentId as string, timing);
        } else {
          ptyManager.write(agentId as string, message as string);
          ptyManager.write(agentId as string, '\r');
        }
      } else if (reg.runtime === 'structured') {
        await structuredManager.sendMessage(agentId as string, message as string);
      } else {
        throw new Error(`Agent runtime "${reg.runtime}" does not support input`);
      }

      return true;
    },
  ));
}
