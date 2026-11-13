import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { AutoJoinPreview, GroupProjectCreateOptions, GroupProjectMembershipView, GroupProjectScope } from '../shared/group-project-types';

export const groupProject = {
  groupProject: {
  list: (): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.LIST),
  create: (name: string, options?: GroupProjectCreateOptions): Promise<unknown> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.CREATE, name, options),
  get: (id: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.GET, id),
  update: (id: string, fields: { name?: string; description?: string; instructions?: string; metadata?: Record<string, unknown> }): Promise<unknown> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.UPDATE, id, fields),
  delete: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.DELETE, id),
  // `since` is either one ISO timestamp for all topics, or a per-topic
  // `topic -> ISO timestamp` map (used for per-channel unread counts).
  getBulletinDigest: (id: string, since?: string | Record<string, string>): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.GET_BULLETIN_DIGEST, id, since),
  getTopicMessages: (id: string, topic: string, since?: string, limit?: number): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.GET_TOPIC_MESSAGES, id, topic, since, limit),
  getAllMessages: (id: string, since?: string, limit?: number): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.GET_ALL_MESSAGES, id, since, limit),
  postBulletinMessage: (projectId: string, topic: string, body: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.POST_BULLETIN_MESSAGE, projectId, topic, body),
  sendShoulderTap: (projectId: string, targetAgentId: string | null, message: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.SEND_SHOULDER_TAP, projectId, targetAgentId, message),
  deleteMessage: (projectId: string, topic: string, messageId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.DELETE_MESSAGE, projectId, topic, messageId),
  deleteTopic: (projectId: string, topic: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.DELETE_TOPIC, projectId, topic),
  setTopicProtection: (projectId: string, topic: string, isProtected: boolean): Promise<boolean> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.SET_TOPIC_PROTECTION, projectId, topic, isProtected),
  getRetentionConfig: (projectId: string): Promise<{ maxPerTopic: number; maxTotal: number }> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.GET_RETENTION_CONFIG, projectId),
  saveRetentionConfig: (projectId: string, maxPerTopic: number, maxTotal: number): Promise<{ saved: boolean; trimmed: number }> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.SAVE_RETENTION_CONFIG, projectId, maxPerTopic, maxTotal),
  clearAllMessages: (projectId: string): Promise<{ removed: number }> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.CLEAR_ALL_MESSAGES, projectId),
  estimateTrim: (projectId: string, maxPerTopic: number, maxTotal: number): Promise<{ wouldRemove: number }> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.ESTIMATE_TRIM, projectId, maxPerTopic, maxTotal),
  getMessage: (projectId: string, messageId: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.GET_MESSAGE, projectId, messageId),
  injectMessage: (agentId: string, message: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.INJECT_MESSAGE, agentId, message),
  setPolling: (projectId: string, enabled: boolean): Promise<unknown> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.SET_POLLING, projectId, enabled),
  getPausedPolling: (projectId: string): Promise<Array<{ agentId: string; agentName: string }>> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.GET_PAUSED_POLLING, projectId),
  resumePolling: (projectId: string, agentId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.RESUME_POLLING, projectId, agentId),
  listMembers: (projectId: string): Promise<GroupProjectMembershipView> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.LIST_MEMBERS, projectId),
  addMember: (projectId: string, agentId: string): Promise<GroupProjectMembershipView> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.ADD_MEMBER, projectId, agentId),
  excludeMember: (projectId: string, agentId: string): Promise<GroupProjectMembershipView> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.EXCLUDE_MEMBER, projectId, agentId),
  answerAutoJoinOffer: (projectId: string, accept: boolean): Promise<GroupProjectMembershipView> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.ANSWER_AUTO_JOIN_OFFER, projectId, accept),
  previewAutoJoin: (scope: GroupProjectScope): Promise<AutoJoinPreview> =>
    ipcRenderer.invoke(IPC.GROUP_PROJECT.PREVIEW_AUTO_JOIN, scope),
  onMembershipChanged: (callback: (projectId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, projectId: string) => callback(projectId);
    ipcRenderer.on(IPC.GROUP_PROJECT.MEMBERSHIP_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.GROUP_PROJECT.MEMBERSHIP_CHANGED, listener); };
  },
  onPausedPollingChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC.GROUP_PROJECT.PAUSED_POLLING_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.GROUP_PROJECT.PAUSED_POLLING_CHANGED, listener); };
  },
  onChanged: (callback: (projects: unknown[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, projects: unknown[]) => callback(projects);
    ipcRenderer.on(IPC.GROUP_PROJECT.CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.GROUP_PROJECT.CHANGED, listener); };
  },
  },
};
