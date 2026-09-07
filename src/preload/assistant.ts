import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const assistant = {
  assistant: {
  /** Spawn the assistant agent with explicit execution mode. */
  spawn: (params: {
    agentId: string;
    mission: string;
    systemPrompt: string;
    executionMode: 'interactive' | 'structured' | 'headless';
    orchestrator?: string;
    model?: string;
  }) => ipcRenderer.invoke(IPC.ASSISTANT.SPAWN, params),
  /** Create the assistant MCP binding for the given agent. */
  bind: (agentId: string) =>
    ipcRenderer.invoke(IPC.ASSISTANT.BIND, agentId),
  /** Remove the assistant MCP binding. */
  unbind: (agentId: string) =>
    ipcRenderer.invoke(IPC.ASSISTANT.UNBIND, agentId),
  /** Send a follow-up message to a conversational headless session. */
  sendFollowup: (params: { message: string; orchestrator?: string; model?: string }) =>
    ipcRenderer.invoke(IPC.ASSISTANT.SEND_FOLLOWUP, params),
  /** Send a follow-up message to a structured session (spawns new --continue session). */
  sendStructuredFollowup: (params: { message: string; orchestrator?: string; model?: string }) =>
    ipcRenderer.invoke(IPC.ASSISTANT.SEND_STRUCTURED_FOLLOWUP, params),
  /** Listen for headless agent completion events. */
  onResult: (callback: (result: { agentId: string; exitCode: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: Parameters<typeof callback>[0]) => callback(result);
    ipcRenderer.on(IPC.ASSISTANT.RESULT, listener);
    return () => { ipcRenderer.removeListener(IPC.ASSISTANT.RESULT, listener); };
  },
  /** Clean up all assistant resources (MCP binding, agent registry, config). */
  reset: (agentId: string) =>
    ipcRenderer.invoke(IPC.ASSISTANT.RESET, agentId),
  /** Save chat history to disk for session persistence. */
  saveHistory: (items: unknown[]) =>
    ipcRenderer.invoke(IPC.ASSISTANT.SAVE_HISTORY, { items }),
  /** Load chat history from disk. */
  loadHistory: () =>
    ipcRenderer.invoke(IPC.ASSISTANT.LOAD_HISTORY) as Promise<unknown[] | null>,
  },
};
