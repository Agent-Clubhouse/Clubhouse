/**
 * Chat for an agent on another desktop (#2390).
 *
 * A connected machine's agents have namespaced ids (`remote||<machine>||<id>`,
 * remoteProjectStore). For those, the chat store reads and acts through the
 * Annex client instead of the local chat runtime: the satellite's chat page
 * (transcript, state, pending prompts) and its chat commands, the same pinned
 * routes its phones use. Nothing here ever calls a local `window.clubhouse.chat`.
 */
import type { ChatEvent, MessageDelivery, PermissionLevel, RuntimeSendResult } from '../../shared/chat';
import { parseNamespacedId, namespacedAgentId } from './remoteProjectStore';

export interface RemoteChatTarget {
  satelliteId: string;
  agentId: string;
}

/** The satellite and its own agent id, for a namespaced id; null for a local agent. */
export function remoteChatTarget(agentId: string): RemoteChatTarget | null {
  return parseNamespacedId(agentId);
}

interface ChatPage {
  events?: ChatEvent[];
  pendingPermissions?: ChatEvent[];
  pendingQuestions?: ChatEvent[];
  queuedMessageIds?: string[];
  state?: string | null;
  sessionId?: string | null;
}

/** An event from the satellite, keyed by the namespaced id here. */
export function localizeRemoteEvent(satelliteId: string, event: ChatEvent): ChatEvent {
  return { ...event, agentId: namespacedAgentId(satelliteId, event.agentId) } as ChatEvent;
}

/**
 * The agent's transcript as the satellite has it (newest `tail`, at most 2000),
 * pending prompts included, and whether a chat session is running it now.
 */
export async function readRemoteTranscript(nsId: string, tail?: number): Promise<{ events: ChatEvent[]; live: boolean | undefined }> {
  const target = remoteChatTarget(nsId);
  if (!target) return { events: [], live: undefined };
  const page = (await window.clubhouse.annexClient.chatPage(target.satelliteId, target.agentId, { limit: Math.min(tail ?? 2000, 2000) })) as ChatPage;
  // A cut page lists what's pending separately; folding them in by seq keeps nothing twice.
  const bySeq = new Map<string, ChatEvent>();
  for (const event of [...(page.events ?? []), ...(page.pendingPermissions ?? []), ...(page.pendingQuestions ?? [])]) {
    bySeq.set(`${event.sessionId}:${event.seq}`, localizeRemoteEvent(target.satelliteId, event));
  }
  // One session's page (the current one): seq orders it.
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return { events, live: page.state === undefined ? undefined : page.state !== null };
}

interface Receipt {
  status?: string;
  result?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

/** Sends a chat command for a satellite's agent; resolves with its result, throws with its message when refused. */
async function command(nsId: string, type: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
  const target = remoteChatTarget(nsId);
  if (!target) throw new Error('Not an agent on another computer');
  const receipt = (await window.clubhouse.annexClient.chatCommand(target.satelliteId, { type, agentId: target.agentId, ...fields })) as Receipt;
  if (receipt?.status !== 'completed') {
    throw new Error(receipt?.error?.message || receipt?.error?.code || 'That computer refused the request.');
  }
  return receipt.result ?? {};
}

/** The session the commands act on: the satellite checks it, so a stale one is refused there. */
function needSession(sessionId: string | null | undefined): string {
  if (!sessionId) throw new Error('This chat has not loaded yet. Try again in a moment.');
  return sessionId;
}

export const remoteChat = {
  async send(nsId: string, sessionId: string | null | undefined, text: string, delivery?: 'auto' | MessageDelivery, attachmentIds?: string[]): Promise<RuntimeSendResult> {
    const result = await command(nsId, 'chat.send', {
      sessionId: needSession(sessionId), text,
      ...(delivery && { delivery }),
      ...(attachmentIds?.length && { attachmentIds }),
    });
    return { delivery: (result.delivery as MessageDelivery) ?? 'prompt', ...(typeof result.messageId === 'string' && { messageId: result.messageId }) };
  },
  async interrupt(nsId: string, sessionId: string | null | undefined): Promise<void> {
    await command(nsId, 'chat.interrupt', { sessionId: needSession(sessionId) });
  },
  async removeQueued(nsId: string, sessionId: string | null | undefined, messageIds: string[]): Promise<string[]> {
    if (messageIds.length === 0) return [];
    const result = await command(nsId, 'chat.queue.remove', { sessionId: needSession(sessionId), messageIds });
    return Array.isArray(result.removed) ? (result.removed as string[]) : [];
  },
  async respondPermission(nsId: string, sessionId: string | null | undefined, requestId: string, optionId: string): Promise<void> {
    await command(nsId, 'chat.permission', { sessionId: needSession(sessionId), requestId, optionId });
  },
  async answerQuestion(nsId: string, sessionId: string | null | undefined, requestId: string, answers: unknown): Promise<void> {
    await command(nsId, 'chat.question', { sessionId: needSession(sessionId), requestId, answers });
  },
  async setLevel(nsId: string, sessionId: string | null | undefined, level: PermissionLevel): Promise<void> {
    await command(nsId, 'chat.setLevel', { sessionId: needSession(sessionId), level });
  },
  async setModel(nsId: string, sessionId: string | null | undefined, model: string, effort?: string | null): Promise<void> {
    await command(nsId, 'chat.setModel', { sessionId: needSession(sessionId), model, ...(effort !== undefined && effort !== null && { effort }) });
  },
};
