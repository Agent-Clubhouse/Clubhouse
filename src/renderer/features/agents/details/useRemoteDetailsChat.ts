import { useEffect, useMemo, useRef } from 'react';
import type { RemoteAgentDetails } from '../../../../shared/remote-agent-details';
import { refreshRemoteTranscript, remoteTranscriptRevision, useChatStore } from '../../../stores/chatStore';
import { MINIMAL_CHAT_CAPABILITIES } from '../../../../shared/chat';

/** Session ids alone do not prove freshness after reconnect; require a successful new hydration. */
export function useRemoteDetailsChat(agentId: string, details: RemoteAgentDetails | null, connected: boolean, snapshot: unknown, generation: number) {
  const receipt = useChatStore((s) => s.remoteReadReceipts[agentId]);
  const chat = useChatStore((s) => s.agents[agentId]);
  const loading = useChatStore((s) => s.loading[agentId]);
  const live = useChatStore((s) => s.live[agentId]);
  const key = `${agentId}:${connected}:${generation}:${details?.providerId ?? ''}:${details?.sessionId ?? ''}:${details?.nativeSessionId ?? ''}:${details?.spawnedAt ?? ''}:${details?.status ?? ''}:${details?.providerEvidence?.runId ?? ''}`;
  const expected = useRef({ key: '', snapshot, revision: 0 });
  if (expected.current.key !== key || expected.current.snapshot !== snapshot) expected.current = { key, snapshot, revision: remoteTranscriptRevision(agentId) + 1 };
  useEffect(() => {
    if (!connected || !details?.sessionId) return;
    expected.current.revision = refreshRemoteTranscript(agentId);
  }, [key, snapshot, agentId, connected, details?.sessionId]);
  const evidence = details?.providerEvidence;
  const bound = connected && !!details?.sessionId && !loading && !!receipt && receipt.revision >= expected.current.revision
    && receipt.revision === remoteTranscriptRevision(agentId) && receipt.snapshot === snapshot
    && receipt.sessionId === details.sessionId && chat?.sessionId === details.sessionId
    && (!!evidence || chat.provider === details.providerId && (!details.nativeSessionId || chat.nativeSessionId === details.nativeSessionId));
  const sameRun = !evidence || receipt?.displayRunId === evidence.runId;
  const stopped = !!bound && (!sameRun || receipt.live === false || live === false || receipt.state === 'sleeping' || receipt.state === 'error' || chat.state === 'sleeping' || chat.state === 'error');
  const unavailable = !!details?.providerEvidenceState && details.providerEvidenceState !== 'current';
  const providerRefreshIdentity = evidence?.runId ?? receipt?.displayRunId;
  const providerRefreshSeq = bound && sameRun && !stopped && !!providerRefreshIdentity && (evidence ? (chat?.providerReportSeq ?? 0) > evidence.lastSeq : details?.providerEvidenceState === 'unavailable' && (chat?.providerReportSeq ?? 0) > 0) ? chat!.providerReportSeq! : 0;
  const ready = bound && receipt.live === true && live === true && !stopped && !providerRefreshSeq && !unavailable;
  const current = useMemo(() => {
    if (!ready || !chat) return undefined;
    if (!evidence) return chat;
    const v = evidence.values;
    // Display overlay only: never overwrite the stream, commands, prompts,
    // permissions or remote chat store with the separate Details response.
    return { ...chat, provider: evidence.providerId, driver: evidence.driver, nativeSessionId: evidence.nativeSessionId,
      items: chat.items.filter((item) => item.seq >= evidence.startSeq),
      cliVersion: v.cliVersion ?? null, model: v.model ?? null, modelUnknown: v.model === null,
      models: v.models ?? [], level: v.level ?? null,
      effort: v.effort?.value ?? null, effortReported: !!v.effort, effortIsDefault: v.effort?.isDefault ?? false,
      capabilities: v.capabilities ? { ...MINIMAL_CHAT_CAPABILITIES, ...v.capabilities } : null,
      contextLimits: v.contextLimits ?? null, mcpServers: v.mcpServers ?? null,
      providerSkills: v.skills ? { ...v.skills, sessionId: evidence.sessionId } : null,
      subagents: Object.fromEntries((v.subagents ?? []).map((s) => [s.subagentId, s])),
      usage: { turn: v.turnUsage ?? null, session: v.sessionUsage ?? null, turnTotal: v.turnTotal ?? null, context: v.context ?? null, limits: v.limits ?? [] },
    };
  }, [ready, chat, evidence]);
  return { chat: current, providerRefreshSeq, providerRefreshIdentity, evidence: ready ? evidence : undefined, stopped, loading: !!loading, partial: ready && receipt.truncated, waiting: !!details?.sessionId && !ready };
}
