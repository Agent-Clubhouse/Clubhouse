/**
 * A chat agent on another desktop (#2390). Its chat view reads and acts through
 * that desktop (stores/remoteChatBackend.ts); what only works on this machine
 * (file and media previews by path, attachments, past sessions, Changes review)
 * is left out while this context is set, rather than reading this machine's files.
 */
import { createContext, useContext } from 'react';

export interface RemoteChatInfo {
  /** The machine the agent runs on, as this machine knows it. */
  machineName: string;
}

export const RemoteChatContext = createContext<RemoteChatInfo | null>(null);

/** The machine a chat view's agent runs on, or null when it's this one. */
export function useRemoteChat(): RemoteChatInfo | null {
  return useContext(RemoteChatContext);
}
