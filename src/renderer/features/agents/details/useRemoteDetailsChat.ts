import { useEffect, useRef } from 'react';
import type { RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import { refreshRemoteTranscript, remoteTranscriptRevision, useChatStore } from '../../../stores/chatStore';

/** Session ids alone do not prove freshness after reconnect; require a successful new hydration. */
export function useRemoteDetailsChat(agentId: string, details: RemoteAgentDetails | null, connected: boolean, snapshot: unknown, generation: number) {
  const receipt = useChatStore((s) => s.remoteReadReceipts[agentId]);
  const chat = useChatStore((s) => s.agents[agentId]);
  const loading = useChatStore((s) => s.loading[agentId]);
  const live = useChatStore((s) => s.live[agentId]);
  const key = `${agentId}:${connected}:${generation}:${details?.providerId ?? ''}:${details?.sessionId ?? ''}:${details?.nativeSessionId ?? ''}:${details?.spawnedAt ?? ''}:${details?.status ?? ''}`;
  const expected = useRef({ key: '', snapshot, revision: 0 });
  if (expected.current.key !== key || expected.current.snapshot !== snapshot) expected.current = { key, snapshot, revision: remoteTranscriptRevision(agentId) + 1 };
  useEffect(() => {
    if (!connected || !details?.sessionId) return;
    expected.current.revision = refreshRemoteTranscript(agentId);
  }, [key, snapshot, agentId, connected, details?.sessionId]);
  const bound = connected && !!details?.sessionId && !loading && !!receipt && receipt.revision >= expected.current.revision
    && receipt.revision === remoteTranscriptRevision(agentId) && receipt.snapshot === snapshot
    && receipt.sessionId === details.sessionId && chat?.sessionId === details.sessionId
    && chat.provider === details.providerId && (!details.nativeSessionId || chat.nativeSessionId === details.nativeSessionId);
  const stopped = !!bound && (receipt.live === false || live === false || receipt.state === 'sleeping' || receipt.state === 'error' || chat.state === 'sleeping' || chat.state === 'error');
  const ready = bound && receipt.live === true && live === true && !stopped;
  return { chat: ready ? chat : undefined, stopped, loading: !!loading, partial: ready && receipt.truncated, waiting: !!details?.sessionId && !ready };
}
