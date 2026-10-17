import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { CheckpointTurn, ChangesResult, RevertResult } from '../shared/chat-checkpoints';
import type { ChatAgentRuntimeInfo, ChatEvent, ChatQuestionAnswers, ChatRuntimeSettings, MessageDelivery, PermissionLevel, PermissionResponseExtras, RuntimeSendResult } from '../shared/chat';

export const chat = {
  chat: {
    readTranscript: (agentId: string, tail?: number): Promise<ChatEvent[]> =>
      ipcRenderer.invoke(IPC.CHAT.READ_TRANSCRIPT, agentId, tail),
    sendMessage: (agentId: string, text: string, delivery?: 'auto' | MessageDelivery): Promise<RuntimeSendResult> =>
      ipcRenderer.invoke(IPC.CHAT.SEND_MESSAGE, agentId, text, delivery),
    interrupt: (agentId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.CHAT.INTERRUPT, agentId),
    respondPermission: (agentId: string, requestId: string, optionId: string, extras?: PermissionResponseExtras): Promise<void> =>
      ipcRenderer.invoke(IPC.CHAT.RESPOND_PERMISSION, agentId, requestId, optionId, extras),
    answerQuestion: (agentId: string, requestId: string, answers: ChatQuestionAnswers): Promise<void> =>
      ipcRenderer.invoke(IPC.CHAT.ANSWER_QUESTION, agentId, requestId, answers),
    setLevel: (agentId: string, level: PermissionLevel): Promise<void> =>
      ipcRenderer.invoke(IPC.CHAT.SET_LEVEL, agentId, level),
    setModel: (agentId: string, modelId: string, effort?: string): Promise<void> =>
      ipcRenderer.invoke(IPC.CHAT.SET_MODEL, agentId, modelId, effort),
    getRuntimeSettings: (): Promise<ChatRuntimeSettings> =>
      ipcRenderer.invoke(IPC.CHAT.GET_RUNTIME_SETTINGS),
    saveRuntimeSettings: (settings: ChatRuntimeSettings): Promise<void> =>
      ipcRenderer.invoke(IPC.CHAT.SAVE_RUNTIME_SETTINGS, settings),
    getAgentRuntime: (agentId: string, provider?: string): Promise<ChatAgentRuntimeInfo> =>
      ipcRenderer.invoke(IPC.CHAT.GET_AGENT_RUNTIME, agentId, provider),
    listCheckpoints: (agentId: string): Promise<CheckpointTurn[]> =>
      ipcRenderer.invoke(IPC.CHAT.LIST_CHECKPOINTS, agentId),
    getChanges: (agentId: string, scope: { turnId: string } | { sessionId: string }, filePath?: string): Promise<ChangesResult> =>
      ipcRenderer.invoke(IPC.CHAT.GET_CHANGES, agentId, scope, filePath),
    revertTurn: (agentId: string, turnId: string, force?: boolean): Promise<RevertResult> =>
      ipcRenderer.invoke(IPC.CHAT.REVERT_TURN, agentId, turnId, force),
    onEvent: (callback: (event: ChatEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, chatEvent: ChatEvent) => callback(chatEvent);
      ipcRenderer.on(IPC.CHAT.EVENT, listener);
      return () => { ipcRenderer.removeListener(IPC.CHAT.EVENT, listener); };
    },
  },
};
