import { useCallback, useEffect, useState } from 'react';
import type { Agent } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStore, type ChatViewState } from '../../stores/chatStore';
import { AgentAvatar } from '../agents/AgentAvatar';
import { agentDot, chatDot, DOT_LABEL, StatusDot } from '../agents/agent-status';

interface PoppedOutPlaceholderProps {
  /** The type of view that is popped out. */
  type: 'agent' | 'canvas';
  /** Optional name of the popped-out view (e.g. agent or canvas name). */
  name?: string;
  /** The windowId of the popout, used to focus or close it. */
  windowId: number;
  /** The popped-out agent, for its live status, latest line and changes. */
  agentId?: string;
}

const TYPE_LABELS: Record<string, string> = {
  agent: 'Agent',
  canvas: 'Canvas',
};

const PopIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6M10 14L21 3" />
  </svg>
);
const FilesIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M14 3v5h5" />
  </svg>
);

/** The newest line the agent wrote: its last chat message, or what its hooks last reported. */
function latestLine(chat: ChatViewState | undefined, hookMessage: string | undefined): string | null {
  if (chat) {
    for (let i = chat.items.length - 1; i >= 0; i--) {
      const it = chat.items[i];
      if (it.kind === 'agent_message' && !it.subagentId && it.text.trim()) {
        const lines = it.text.trim().split('\n').filter((l) => l.trim());
        return lines[lines.length - 1]?.trim() ?? null;
      }
    }
  }
  return hookMessage || null;
}

/** What a chat agent's session changed so far, from Clubhouse's checkpoints. */
function useSessionChanges(agentId: string, chat: ChatViewState | undefined) {
  const [changes, setChanges] = useState<{ files: number; added: number; removed: number } | null>(null);
  const sessionId = chat?.sessionId ?? null;
  const refreshKey = `${chat?.turnId ?? 'idle'}:${chat?.state ?? ''}`;
  useEffect(() => {
    if (!sessionId) { setChanges(null); return; }
    let cancelled = false;
    window.clubhouse.chat.getChanges(agentId, { sessionId }).then(
      (r) => {
        if (cancelled) return;
        if (!r.available || r.files.length === 0) { setChanges(null); return; }
        setChanges(r.files.reduce(
          (t, f) => ({ files: t.files + 1, added: t.added + f.additions, removed: t.removed + f.deletions }),
          { files: 0, added: 0, removed: 0 },
        ));
      },
      () => { if (!cancelled) setChanges(null); },
    );
    return () => { cancelled = true; };
  }, [agentId, sessionId, refreshKey]);
  return changes;
}

function AgentSummary({ agent }: { agent: Agent }) {
  const detailed = useAgentStore((s) => s.agentDetailedStatus[agent.id]);
  const chat = useChatStore((s) => s.agents[agent.id]);
  // Chat state counts only while chat runs the agent, not left over from an earlier session (#2208).
  const inChat = useChatStore((s) => s.live[agent.id] === true);
  const dot = inChat && chat?.sessionId && agent.status === 'running' ? chatDot(chat.state) : agentDot(agent, detailed);
  const line = latestLine(chat, agent.status === 'running' ? detailed?.message : agent.errorMessage);
  const changes = useSessionChanges(agent.id, chat);
  return (
    <>
      <div className="h-10 flex items-center gap-2 px-3 border-b border-surface-0">
        <StatusDot dot={dot} />
        <AgentAvatar agent={agent} size="2xs" />
        <span className="text-[13px] font-medium text-ctp-text truncate">{agent.name}</span>
        <span className="text-xs text-ctp-overlay1 flex-shrink-0" data-testid="popped-out-status">{DOT_LABEL[dot]}</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-ctp-overlay1 flex-shrink-0"><PopIcon />Own window</span>
      </div>
      {(line || changes) && (
        <div className="p-3 flex flex-col gap-2">
          {line && <p className="text-[13px] leading-normal text-ctp-subtext1 line-clamp-3 break-words" data-testid="popped-out-latest">{line}</p>}
          {changes && (
            <div className="flex items-center gap-2 text-xs text-ctp-overlay1" data-testid="popped-out-changes">
              <FilesIcon />
              {changes.files} {changes.files === 1 ? 'file' : 'files'} changed
              <span className="font-mono"><span className="text-ctp-success">+{changes.added}</span> <span className="text-ctp-error">−{changes.removed}</span></span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Where a popped-out view was (#2018): a small card that keeps the agent's
 * status, latest line and changes live, so the main window still says what it
 * is doing. Pop back in closes the popout; Show window brings it forward.
 */
export function PoppedOutPlaceholder({ type, name, windowId, agentId }: PoppedOutPlaceholderProps) {
  const agent = useAgentStore((s) => (type === 'agent' && agentId ? s.agents[agentId] : undefined));
  const label = name || agent?.name || TYPE_LABELS[type] || type;

  const handleGoToWindow = useCallback(() => {
    window.clubhouse.window.focusPopout(windowId);
  }, [windowId]);

  const handleCloseWindow = useCallback(() => {
    window.clubhouse.window.closePopout(windowId);
  }, [windowId]);

  return (
    <div className="flex items-center justify-center h-full bg-ctp-base p-4" data-testid="popped-out-placeholder">
      <div className="w-full max-w-[400px] rounded-lg border border-surface-0 bg-ctp-mantle overflow-hidden">
        {agent ? (
          <AgentSummary agent={agent} />
        ) : (
          <div className="px-3 py-3 flex flex-col gap-1">
            <p className="text-[13px] font-medium text-ctp-text">{label} is open in its own window</p>
            <p className="text-xs text-ctp-overlay1">It shows here again when you pop it back in.</p>
          </div>
        )}
        <div className="flex justify-end gap-2 px-3 py-2.5 border-t border-surface-0">
          <button
            type="button"
            onClick={handleCloseWindow}
            className="h-7 px-3 rounded-md border border-surface-1 text-xs text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text"
            data-testid="popped-out-close-window"
          >
            Pop back in
          </button>
          <button
            type="button"
            onClick={handleGoToWindow}
            className="h-7 px-3 rounded-md bg-ctp-accent text-xs font-medium text-ctp-crust hover:opacity-90"
            data-testid="popped-out-go-to-window"
          >
            Show window
          </button>
        </div>
      </div>
    </div>
  );
}
