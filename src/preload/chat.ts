import { ipcRenderer, webUtils } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { CheckpointTurn, ChangesResult, RevertResult } from '../shared/chat-checkpoints';
import type { ChatAgentRuntimeInfo, ChatEvent, ChatQuestionAnswers, ChatRuntimeSettings, MessageDelivery, PermissionLevel, PermissionResponseExtras, RuntimeSendResult, StagedChatAttachment } from '../shared/chat';
import { CHAT_IMAGE_MAX_BYTES } from '../shared/chat';
import type { ChatSessionSummary } from '../shared/chat';

export const chat = {
  chat: {
    readTranscript: (agentId: string, tail?: number, sessionId?: string): Promise<ChatEvent[]> =>
      ipcRenderer.invoke(IPC.CHAT.READ_TRANSCRIPT, agentId, tail, sessionId),
    listSessions: (agentId: string): Promise<ChatSessionSummary[]> =>
      ipcRenderer.invoke(IPC.CHAT.LIST_SESSIONS, agentId),
    /** `attachmentIds` come from stageAttachment. */
    sendMessage: (agentId: string, text: string, delivery?: 'auto' | MessageDelivery, attachmentIds?: string[]): Promise<RuntimeSendResult> =>
      ipcRenderer.invoke(IPC.CHAT.SEND_MESSAGE, agentId, text, delivery, attachmentIds),
    /**
     * Hand a dropped, picked or pasted File to main for checking. The path is
     * resolved here from the File itself, so page code can only stage files
     * the user actually gave it; a File with no path (pasted) goes as bytes.
     */
    stageAttachment: async (agentId: string, file: File, opts?: { imagesAllowed?: boolean }): Promise<StagedChatAttachment> => {
      const filePath = webUtils.getPathForFile(file);
      if (filePath) return ipcRenderer.invoke(IPC.CHAT.STAGE_ATTACHMENT, agentId, { path: filePath, name: file.name });
      if (opts?.imagesAllowed === false) throw new Error("This agent's chat can't take pasted images");
      if (file.size > CHAT_IMAGE_MAX_BYTES) throw new Error('Pasted images must be 3.75 MB or smaller');
      return ipcRenderer.invoke(IPC.CHAT.STAGE_ATTACHMENT, agentId, {
        data: new Uint8Array(await file.arrayBuffer()),
        name: file.name,
        ...(opts?.imagesAllowed !== undefined ? { imagesAllowed: opts.imagesAllowed } : {}),
      });
    },
    interrupt: (agentId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.CHAT.INTERRUPT, agentId),
    respondPermission: (agentId: string, requestId: string, optionId: string, extras?: PermissionResponseExtras): Promise<void> =>
      ipcRenderer.invoke(IPC.CHAT.RESPOND_PERMISSION, agentId, requestId, optionId, extras),
    answerQuestion: (agentId: string, requestId: string, answers: ChatQuestionAnswers): Promise<void> =>
      ipcRenderer.invoke(IPC.CHAT.ANSWER_QUESTION, agentId, requestId, answers),
    setLevel: (agentId: string, level: PermissionLevel): Promise<void> =>
      ipcRenderer.invoke(IPC.CHAT.SET_LEVEL, agentId, level),
    setModel: (agentId: string, modelId: string, effort?: string | null): Promise<void> =>
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
    undoRevert: (agentId: string, turnId: string): Promise<RevertResult> =>
      ipcRenderer.invoke(IPC.CHAT.UNDO_REVERT, agentId, turnId),
    /** An agent didn't get the chat it asked for: it fell back to another driver or the terminal. */
    onRuntimeNotice: (callback: (agentId: string, notice: { level: 'info' | 'warn'; code: string; message: string }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, agentId: string, notice: { level: 'info' | 'warn'; code: string; message: string }) =>
        callback(agentId, notice);
      ipcRenderer.on(IPC.CHAT.RUNTIME_NOTICE, listener);
      return () => { ipcRenderer.removeListener(IPC.CHAT.RUNTIME_NOTICE, listener); };
    },
    onEvent: (callback: (event: ChatEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, chatEvent: ChatEvent) => callback(chatEvent);
      ipcRenderer.on(IPC.CHAT.EVENT, listener);
      return () => { ipcRenderer.removeListener(IPC.CHAT.EVENT, listener); };
    },
  },
};
