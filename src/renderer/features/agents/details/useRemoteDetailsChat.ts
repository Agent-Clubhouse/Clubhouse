import { useEffect, useRef } from 'react';
import type { RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import { refreshRemoteTranscript, remoteTranscriptRevision, useChatStore } from '../../../stores/chatStore';

/** Session ids alone do not prove freshness after reconnect; require a successful new hydration. */
export function useRemoteDetailsChat(agentId: string, details: RemoteAgentDetails | null, connected: boolean, snapshot: unknown, generation: number) {
  const receipt = useChatStore((s) => s.remoteReadReceipts[agentId]);
  const chat = useChatStore((s) => s.agents[agentId]);
  const loading = useChatStore((s) => s.loading[agentId]);
  const key = `${agentId}:${connected}:${generation}:${details?.sessionId ?? ''}:${details?.nativeSessionId ?? ''}:${details?.status ?? ''}`;
  const expected = useRef({ key: '', snapshot, revision: 0 });
  if (expected.current.key !== key || expected.current.snapshot !== snapshot) expected.current = { key, snapshot, revision: remoteTranscriptRevision(agentId) + 1 };
  useEffect(() => {
    if (!connected || !details?.sessionId) return;
    expected.current.revision = refreshRemoteTranscript(agentId);
  }, [key, snapshot, agentId, connected, details?.sessionId]);
  const ready = connected && !!details?.sessionId && !loading && !!receipt && receipt.revision >= expected.current.revision
    && receipt.revision === remoteTranscriptRevision(agentId) && receipt.snapshot === snapshot
    && receipt.sessionId === details.sessionId && chat?.sessionId === details.sessionId
    && chat.provider === details.providerId && (!details.nativeSessionId || chat.nativeSessionId === details.nativeSessionId);
  return { chat: ready ? chat : undefined, loading: !!loading, partial: ready && receipt.truncated, waiting: !!details?.sessionId && !ready };
}
