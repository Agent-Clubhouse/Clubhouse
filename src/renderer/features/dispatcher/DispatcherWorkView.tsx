import { useMemo } from 'react';
import { createChatViewState } from '../../stores/chatStore';
import { ChatStream } from '../agents/chat/ChatStream';
import { formatWhen } from '../agents/chat/MessageBlocks';
import { useChatLoading, useChatState, useChatTranscript } from '../agents/chat/useChatSession';
import { activeRunSince, startedFreshNotice } from './work-conversation';

/**
 * The Dispatcher debug view's read-only chat of its controller (#3188): its
 * transcript and live events as any agent's chat shows them, everything
 * included, with no composer, approvals or controls. It reads; it never sends
 * or starts anything.
 *
 * It tells now from history (#3242): the header names the current native
 * conversation, when it started, whether it is active, and a fresh start;
 * each CLI run gets a boundary saying whether it is active or ended; and
 * errors carry their time, with those of an ended run marked as such.
 */
export function DispatcherWorkView({ agentId }: { agentId: string }) {
  useChatTranscript(agentId);
  const stored = useChatState(agentId);
  const loading = useChatLoading(agentId);
  const empty = useMemo(() => createChatViewState(agentId), [agentId]);
  const state = stored ?? empty;
  const activeSince = activeRunSince(stored);
  const runList = state.runs;
  const runs = useMemo(() => ({ list: runList, activeSince }), [runList, activeSince]);
  const fresh = startedFreshNotice(stored);
  const startedAt = state.runs[0]?.startedAt ?? state.sessionStartedAt;
  return (
    <div className="h-full flex flex-col bg-ctp-base" data-testid="dispatcher-work-view" data-agent-id={agentId}>
      <div className="flex-shrink-0 px-7 py-2 flex flex-col gap-0.5 text-xs text-ctp-overlay1 border-b border-surface-0">
        <p data-testid="dispatcher-work-note">Debug view of the Dispatcher&rsquo;s controller. Read only.</p>
        {state.sessionId && (
          <p data-testid="dispatcher-work-conversation" data-active={activeSince !== null}>
            Conversation{' '}
            <span className="font-mono select-text text-ctp-subtext0" data-testid="dispatcher-work-native-id">{state.nativeSessionId ?? 'not reported yet'}</span>
            {startedAt !== null && <>, started {formatWhen(startedAt)}</>}
            , {activeSince !== null ? 'active' : 'ended'}.
          </p>
        )}
        {fresh && (
          <p data-testid="dispatcher-work-started-fresh">Started fresh {formatWhen(fresh.ts)}. Earlier conversations are not resumed.</p>
        )}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <ChatStream
          state={state}
          agentName="Dispatcher controller"
          announce={false}
          emptyMessage={loading && !stored ? 'Loading' : 'Nothing here yet.'}
          runs={runs}
        />
      </div>
    </div>
  );
}
