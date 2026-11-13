/**
 * IPC handlers for group project management.
 */

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { groupProjectRegistry } from '../services/group-project-registry';
import { listPausedPolling, onPollingPauseChanged, resumePausedPolling, setProjectPolling, watchPollingForMcp } from '../services/group-project-polling';
import { groupProjectHost } from '../services/group-project-host';
import { initGroupProjectLifecycle } from '../services/group-project-lifecycle';
import { describeGroupProjectRoles, grantGroupProjectRole, setOwnGrant } from '../services/group-project-roles';
import { addMember, answerAutoJoinOffer, beginAutoJoin, describeMembership, excludeMember, onMembershipChanged, previewAutoJoin, releaseMembershipBindings } from '../services/group-project-membership';
import { executeShoulderTap } from '../services/group-project-shoulder-tap';
import * as annexEventBus from '../services/annex-event-bus';
import { appLog } from '../services/log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { withValidatedArgs, stringArg, objectArg, numberArg, booleanArg, digestSinceArg } from './validation';
import type { DigestSince, GroupProjectCreateOptions, GroupProjectScope } from '../../shared/group-project-types';
import { agentRegistry } from '../services/agent-registry';
import { getAgentRuntime } from '../services/agent-runtime';
import { injectPtyText } from '../services/agent-runtime/pty-input';
import { getProvider } from '../orchestrators';
import type { PasteSubmitTiming } from '../orchestrators';
import { createLocalGroupProjectDeleteService } from '../services/group-project-delete-service';
import { flushOpenCanvases } from '../services/canvas-flush';
import { bindingManager } from '../services/clubhouse-mcp/binding-manager';

const deletion = createLocalGroupProjectDeleteService((id) => {
  releaseMembershipBindings(id);
  for (const binding of bindingManager.getAllBindings()) {
    if (binding.targetKind === 'group-project' && binding.targetId === id) bindingManager.unbind(binding.agentId, id);
  }
});

function broadcastChanged(): void {
  groupProjectHost.list().then((projects) => {
    broadcastToAllWindows(IPC.GROUP_PROJECT.CHANGED, projects);
  }).catch((err) => {
    appLog('core:group-project', 'warn', 'Failed to broadcast group project changes', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
}

let handlersRegistered = false;

/** For testing only: reset the registration guard so handlers can be re-registered. */
export function _resetHandlersForTesting(): void {
  handlersRegistered = false;
}

export function registerGroupProjectHandlers(): void {
  if (handlersRegistered) return;

  // NOTE: Group-project creation and its bulletin board are local features,
  // registered on their own. The MCP tools are registered in
  // registerMcpBindingHandlers(), and the Clubhouse MCP always runs.
  // initGroupProjectLifecycle() is idempotent and its bindingManager
  // subscription stays dormant until an agent actually binds to a project.
  handlersRegistered = true;

  // Tool registration is handled centrally in registerMcpBindingHandlers().
  initGroupProjectLifecycle();
  watchPollingForMcp();

  appLog('core:group-project', 'info', 'Group project handlers registered');

  // Subscribe to registry changes for renderer broadcast
  groupProjectRegistry.onChange(() => {
    broadcastChanged();
  });
  // Every delete, whichever path began it (IPC, the #3364 cascade, Annex), tells Annex once, when it begins.
  groupProjectHost.onChange((change) => {
    if (change.part === 'deleted' && change.project) annexEventBus.emitGroupProjectChanged('deleted', change.project);
  });
  onMembershipChanged((projectId) => broadcastToAllWindows(IPC.GROUP_PROJECT.MEMBERSHIP_CHANGED, projectId));

  // Membership (#3357): the record, not canvas wires.
  ipcMain.handle(IPC.GROUP_PROJECT.LIST_MEMBERS, withValidatedArgs([stringArg()], (_event, id) => describeMembership(id as string)));
  ipcMain.handle(IPC.GROUP_PROJECT.ADD_MEMBER, withValidatedArgs([stringArg(), stringArg()], (_event, id, agentId) => addMember(id as string, agentId as string)));
  ipcMain.handle(IPC.GROUP_PROJECT.EXCLUDE_MEMBER, withValidatedArgs([stringArg(), stringArg()], (_event, id, agentId) => excludeMember(id as string, agentId as string)));
  // The group project as a principal (#3360): its own grants, and lead and admin as grants.
  ipcMain.handle(IPC.GROUP_PROJECT.GET_ROLES, withValidatedArgs([stringArg()], (_event, id) => describeGroupProjectRoles(id as string)));
  ipcMain.handle(IPC.GROUP_PROJECT.SET_ROLE, withValidatedArgs(
    [stringArg(), stringArg(), stringArg(), stringArg()],
    async (_event, id, agentId, role, mode) => {
      if (role !== 'lead' && role !== 'admin') throw new Error('Role must be lead or admin.');
      if (mode !== 'allow' && mode !== 'ask' && mode !== 'off') throw new Error('Mode must be allow, ask or off.');
      await grantGroupProjectRole(id as string, agentId as string, role, mode);
      return describeGroupProjectRoles(id as string);
    },
  ));
  ipcMain.handle(IPC.GROUP_PROJECT.SET_OWN_GRANT, withValidatedArgs(
    [stringArg(), stringArg(), stringArg()],
    async (_event, id, grant, mode) => {
      if (grant !== 'deliver' && grant !== 'wake') throw new Error('Grant must be deliver or wake.');
      if (mode !== 'allow' && mode !== 'off') throw new Error('Mode must be allow or off.');
      await setOwnGrant(id as string, grant, mode);
      return describeGroupProjectRoles(id as string);
    },
  ));
  ipcMain.handle(IPC.GROUP_PROJECT.PREVIEW_AUTO_JOIN, withValidatedArgs(
    [objectArg<GroupProjectScope>()], (_event, scope) => previewAutoJoin(scope),
  ));
  ipcMain.handle(IPC.GROUP_PROJECT.ANSWER_AUTO_JOIN_OFFER, withValidatedArgs(
    [stringArg(), booleanArg()], (_event, id, accept) => answerAutoJoinOffer(id as string, accept as boolean),
  ));
  groupProjectHost.onChange((event) => {
    if (event.part === 'deleted') broadcastToAllWindows(IPC.GROUP_PROJECT.DELETED, event.groupProjectId);
  });
  void deletion.recoverPending().catch((err) => {
    appLog('core:group-project', 'error', 'Failed to recover group project deletions', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });

  ipcMain.handle(IPC.GROUP_PROJECT.LIST, async () => {
    return groupProjectHost.list();
  });

  ipcMain.handle(IPC.GROUP_PROJECT.CREATE, withValidatedArgs(
    [stringArg(), objectArg<GroupProjectCreateOptions>({ optional: true })],
    async (_event, name, options) => {
      const project = await groupProjectHost.create(name as string, options as GroupProjectCreateOptions | undefined);
      // Everyone in scope joins a new group project (#3357).
      await beginAutoJoin(project.id);
      annexEventBus.emitGroupProjectChanged('created', project);
      appLog('core:group-project', 'info', 'Group project created', { meta: { id: project.id, name: project.name } });
      return project;
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.GET, withValidatedArgs(
    [stringArg()],
    async (_event, id) => {
      return groupProjectHost.get(id as string);
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.UPDATE, withValidatedArgs(
    [stringArg(), objectArg<{ name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> }>()],
    async (_event, id, fields) => {
      const updated = await groupProjectHost.update(id as string, fields as { name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> });
      if (updated) {
        annexEventBus.emitGroupProjectChanged('updated', updated);
        appLog('core:group-project', 'info', 'Group project updated', { meta: { id } });
      }
      return updated;
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.PREVIEW_DELETE, withValidatedArgs(
    [stringArg()],
    async (event, id) => {
      const flushed = await flushOpenCanvases();
      const impact = await deletion.preview(id as string, event.sender.id);
      return { ...impact, incompleteWindows: !flushed.complete };
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.DELETE, withValidatedArgs(
    [stringArg(), stringArg()],
    async (event, id, token) => {
      await deletion.confirm(id as string, event.sender.id, token as string);
      appLog('core:group-project', 'info', 'Group project deleted', { meta: { id } });
      return true;
    },
  ));

  // Scope (#3355): a person changes it here, after reviewing who would leave.
  ipcMain.handle(IPC.GROUP_PROJECT.SCOPE_OPTIONS, () => groupProjectHost.scopeOptions());

  ipcMain.handle(IPC.GROUP_PROJECT.PREVIEW_SCOPE, withValidatedArgs(
    [stringArg(), objectArg<GroupProjectScope>()],
    async (_event, id, scope) => groupProjectHost.previewScope(id as string, scope),
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.SET_SCOPE, withValidatedArgs(
    [stringArg(), objectArg<GroupProjectScope>(), objectArg<{ confirmLeaving?: string[] }>({ optional: true })],
    async (_event, id, scope, options) => {
      const confirmLeaving = (options as { confirmLeaving?: unknown } | undefined)?.confirmLeaving;
      if (confirmLeaving !== undefined && (!Array.isArray(confirmLeaving) || confirmLeaving.some((a) => typeof a !== 'string'))) {
        throw new Error('confirmLeaving must be a list of member addresses.');
      }
      const result = await groupProjectHost.setScope(id as string, scope, { confirmLeaving: confirmLeaving as string[] | undefined });
      annexEventBus.emitGroupProjectChanged('updated', result.project);
      appLog('core:group-project', 'info', 'Group project scope set', { meta: { id, left: result.left.length } });
      return result;
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.GET_BULLETIN_DIGEST, withValidatedArgs(
    [stringArg(), digestSinceArg()],
    async (_event, id, since) => {
      return groupProjectHost.readDigest(id as string, since as DigestSince | undefined);
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.GET_TOPIC_MESSAGES, withValidatedArgs(
    [stringArg(), stringArg(), stringArg({ optional: true }), numberArg({ optional: true })],
    async (_event, id, topic, since, limit) => {
      return groupProjectHost.readTopic(id as string, topic as string, since as string | undefined, limit as number | undefined);
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.GET_ALL_MESSAGES, withValidatedArgs(
    [stringArg(), stringArg({ optional: true }), numberArg({ optional: true })],
    async (_event, id, since, limit) => {
      return groupProjectHost.readAll(id as string, since as string | undefined, limit as number | undefined);
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.POST_BULLETIN_MESSAGE, withValidatedArgs(
    [stringArg(), stringArg(), stringArg()],
    async (_event, projectId, topic, body) => {
      const message = await groupProjectHost.post(projectId as string, 'user', topic as string, body as string);
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
      return groupProjectHost.deleteMessage(projectId as string, topic as string, messageId as string);
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.DELETE_TOPIC, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectId, topic) => {
      return groupProjectHost.deleteTopic(projectId as string, topic as string);
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.SET_TOPIC_PROTECTION, withValidatedArgs(
    [stringArg(), stringArg(), booleanArg()],
    async (_event, projectId, topic, isProtected) => {
      await groupProjectHost.setTopicProtected(projectId as string, topic as string, isProtected as boolean);
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
      const trimmed = await groupProjectHost.setRetention(projectId as string, maxPerTopic as number, maxTotal as number);
      broadcastChanged();
      return { saved: true, trimmed };
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.CLEAR_ALL_MESSAGES, withValidatedArgs(
    [stringArg()],
    async (_event, projectId) => {
      const removed = await groupProjectHost.clearAll(projectId as string);
      appLog('core:group-project', 'info', 'Cleared all messages', { meta: { projectId, removed } });
      return { removed };
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.ESTIMATE_TRIM, withValidatedArgs(
    [stringArg(), numberArg({ integer: true, min: 1 }), numberArg({ integer: true, min: 1 })],
    async (_event, projectId, maxPerTopic, maxTotal) => {
      const wouldRemove = await groupProjectHost.estimateTrim(projectId as string, maxPerTopic as number, maxTotal as number);
      return { wouldRemove };
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.GET_MESSAGE, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, projectId, messageId) => {
      return groupProjectHost.getMessage(projectId as string, messageId as string);
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.INJECT_MESSAGE, withValidatedArgs(
    [stringArg(), stringArg()],
    async (_event, agentId, message) => {
      const reg = agentRegistry.get(agentId as string);
      if (!reg) throw new Error(`Agent ${agentId} is not registered`);

      const runtime = getAgentRuntime(agentId as string);
      if (!runtime) throw new Error(`Agent runtime "${reg.runtime}" does not support input`);
      if (runtime.kind === 'pty') {
        const timing: PasteSubmitTiming = getProvider(reg.orchestrator)?.getPasteSubmitTiming()
          ?? { initialDelayMs: 350, retryDelayMs: 300, finalCheckDelayMs: 250, chunkSize: 512, chunkDelayMs: 30 };
        await injectPtyText(agentId as string, message as string, timing);
      } else {
        await runtime.sendMessage(message as string, { source: 'group_project' });
      }

      return true;
    },
  ));

  // Set the project-wide polling setting (persist + member start/stop side-effect).
  // Shared with the toggle_polling admin MCP command via setProjectPolling so the
  // UI toggle and the command can't diverge.
  ipcMain.handle(IPC.GROUP_PROJECT.SET_POLLING, withValidatedArgs(
    [stringArg(), booleanArg()],
    async (_event, projectId, enabled) => {
      return setProjectPolling(projectId as string, enabled as boolean);
    },
  ));

  ipcMain.handle(IPC.GROUP_PROJECT.GET_PAUSED_POLLING, withValidatedArgs(
    [stringArg()],
    (_event, projectId) => listPausedPolling(projectId as string),
  ));
  ipcMain.handle(IPC.GROUP_PROJECT.RESUME_POLLING, withValidatedArgs(
    [stringArg(), stringArg()],
    (_event, projectId, agentId) => resumePausedPolling(projectId as string, agentId as string),
  ));
  onPollingPauseChanged(() => broadcastToAllWindows(IPC.GROUP_PROJECT.PAUSED_POLLING_CHANGED));
}
