import { useMemo } from 'react';
import { createChatViewState } from '../../stores/chatStore';
import { ChatStream } from '../agents/chat/ChatStream';
import { useChatLoading, useChatState, useChatTranscript } from '../agents/chat/useChatSession';

/**
 * The Dispatcher debug view's read-only chat of its work agent (#3188): its
 * transcript and live events as any agent's chat shows them, everything
 * included, with no composer, approvals or controls. It reads; it never sends
 * or starts anything.
 */
export function DispatcherWorkView({ agentId }: { agentId: string }) {
  useChatTranscript(agentId);
  const stored = useChatState(agentId);
  const loading = useChatLoading(agentId);
  const empty = useMemo(() => createChatViewState(agentId), [agentId]);
  return (
    <div className="h-full flex flex-col bg-ctp-base" data-testid="dispatcher-work-view" data-agent-id={agentId}>
      <p className="flex-shrink-0 px-7 py-2 text-xs text-ctp-overlay1 border-b border-surface-0" data-testid="dispatcher-work-note">
        Debug view of the Dispatcher&rsquo;s work agent. Read only.
      </p>
      <div className="flex-1 min-h-0 flex flex-col">
        <ChatStream
          state={stored ?? empty}
          agentName="Dispatcher work"
          announce={false}
          emptyMessage={loading && !stored ? 'Loading' : 'Nothing here yet.'}
        />
      </div>
    </div>
  );
}
