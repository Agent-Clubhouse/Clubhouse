/**
 * The one seam between ChatView and the chat store. Components read state and
 * call actions through these hooks only, so the store (or a fixture replayer)
 * can be swapped without touching them.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { ChatQuestionAnswers, MessageDelivery, PermissionLevel, PermissionResponseExtras, RuntimeSendResult } from '../../../../shared/chat';
import { useChatStore, type ChatViewState } from '../../../stores/chatStore';
import { useToastStore } from '../../../stores/toastStore';
import type { ComposerAttachment } from './attachments';

export interface ChatActions {
  /** Read the runtime identity synchronously after an asynchronous interruption. */
  isSessionCurrent?: (sessionId: string | null) => boolean;
  /** `attachmentIds` are staged attachment ids. */
  send: (text: string, delivery?: 'auto' | MessageDelivery, attachmentIds?: string[]) => Promise<RuntimeSendResult | null>;
  /** Resolves false when the turn couldn't be stopped (a toast says why). */
  interrupt: () => Promise<boolean>;
  /** Drop queued messages by id. Resolves false when nothing was removed (already sent). */
  removeQueued?: (messageIds: string[]) => Promise<boolean>;
  /** Resolves false when the answer didn't reach the agent (a toast says why). */
  respondPermission: (requestId: string, optionId: string, extras?: PermissionResponseExtras) => Promise<boolean>;
  answerQuestion: (requestId: string, answers: ChatQuestionAnswers) => Promise<boolean>;
  /** Resolves false when the level didn't change (a toast says why). */
  setLevel: (level: PermissionLevel) => Promise<boolean>;
  /** Omitted effort keeps the current one; null returns it to the provider's default. */
  setModel?: (modelId: string, effort?: string | null) => Promise<void>;
  /** Effort alone, for an agent that offers no model choice. */
  setEffort?: (effort: string | null) => Promise<void>;
}

/**
 * Unsent composer text per agent. It lives outside the composer so a draft
 * survives the composer being swapped for an approval card, or switching agents.
 */
export interface PendingChatSend {
  sessionId: string | null;
  /** True when delivery is unconfirmed, including a rejected or lost acknowledgement. */
  uncertain: boolean;
  startedAt: number;
  text: string;
  attachments: ComposerAttachment[];
}

interface DraftState {
  uncertainDrafts: Record<string, boolean>;
  pendingSends: Record<string, PendingChatSend>;
  failedSends: Record<string, PendingChatSend[]>;
  retireSend: (agentId: string, sessionId: string | null) => void;
  beginSend: (agentId: string, send: PendingChatSend) => boolean;
  finishSend: (agentId: string, send: PendingChatSend, ok: boolean, uncertain?: boolean) => void;
  restoreSend: (agentId: string) => void;
  drafts: Record<string, string>;
  setDraft: (agentId: string, text: string) => void;
  /** Unsent attachments per agent, kept alongside the text for the same reason. */
  attachments: Record<string, ComposerAttachment[]>;
  setAttachments: (agentId: string, attachments: ComposerAttachment[]) => void;
}

export const useChatDraftStore = create<DraftState>((set, get) => ({
  uncertainDrafts: {},
  pendingSends: {},
  failedSends: {},
  retireSend: (agentId, sessionId) => set((s) => {
    const previous = s.pendingSends[agentId];
    if (!previous || previous.sessionId === sessionId) return s;
    const pendingSends = { ...s.pendingSends };
    delete pendingSends[agentId];
    return { pendingSends, failedSends: { ...s.failedSends, [agentId]: [...(s.failedSends[agentId] ?? []), previous] } };
  }),
  beginSend: (agentId, send) => {
    get().retireSend(agentId, send.sessionId);
    if (get().pendingSends[agentId]) return false;
    set((s) => ({ pendingSends: { ...s.pendingSends, [agentId]: send } }));
    return true;
  },
  finishSend: (agentId, send, ok, uncertain = true) => set((s) => {
    if (s.pendingSends[agentId] !== send) {
      // A new session retired this send. Its eventual result must never touch the new draft or lock.
      const saved = s.failedSends[agentId];
      if (!saved?.includes(send)) return s;
      return { failedSends: { ...s.failedSends, [agentId]: ok ? saved.filter((item) => item !== send)
        : saved.map((item) => item === send ? { ...send, uncertain } : item) } };
    }
    const failed = { ...send, uncertain };
    const pendingSends = { ...s.pendingSends };
    delete pendingSends[agentId];
    if (ok) return { pendingSends };
    // Restore atomically, without overwriting text or files added while awaiting acknowledgement.
    if (!s.drafts[agentId] && !s.attachments[agentId]?.length) {
      return { pendingSends, uncertainDrafts: { ...s.uncertainDrafts, [agentId]: uncertain }, drafts: { ...s.drafts, [agentId]: send.text }, attachments: { ...s.attachments, [agentId]: send.attachments } };
    }
    return { pendingSends, failedSends: { ...s.failedSends, [agentId]: [...(s.failedSends[agentId] ?? []), failed] } };
  }),
  restoreSend: (agentId) => set((s) => {
    const [send, ...rest] = s.failedSends[agentId] ?? [];
    if (!send || s.pendingSends[agentId] || s.drafts[agentId] || s.attachments[agentId]?.length) return s;
    return {
      uncertainDrafts: { ...s.uncertainDrafts, [agentId]: send.uncertain },
      drafts: { ...s.drafts, [agentId]: send.text },
      attachments: { ...s.attachments, [agentId]: send.attachments },
      failedSends: { ...s.failedSends, [agentId]: rest },
    };
  }),
  drafts: {},
  setDraft: (agentId, text) => set((s) => {
    const drafts = { ...s.drafts };
    if (text) drafts[agentId] = text;
    else delete drafts[agentId];
    return { drafts, ...(!text && !s.attachments[agentId]?.length ? { uncertainDrafts: { ...s.uncertainDrafts, [agentId]: false } } : {}) };
  }),
  attachments: {},
  setAttachments: (agentId, list) => set((s) => {
    const attachments = { ...s.attachments };
    if (list.length) attachments[agentId] = list;
    else delete attachments[agentId];
    return { attachments, ...(!list.length && !s.drafts[agentId] ? { uncertainDrafts: { ...s.uncertainDrafts, [agentId]: false } } : {}) };
  }),
}));

const NO_ATTACHMENTS: ComposerAttachment[] = [];

export function useChatAttachments(agentId: string): [ComposerAttachment[], (list: ComposerAttachment[]) => void] {
  const list = useChatDraftStore((s) => s.attachments[agentId] ?? NO_ATTACHMENTS);
  const setAttachments = useChatDraftStore((s) => s.setAttachments);
  const set = useCallback((l: ComposerAttachment[]) => setAttachments(agentId, l), [agentId, setAttachments]);
  return [list, set];
}

export function useChatDraft(agentId: string): [string, (text: string) => void] {
  const text = useChatDraftStore((s) => s.drafts[agentId] ?? '');
  const setDraft = useChatDraftStore((s) => s.setDraft);
  const set = useCallback((t: string) => setDraft(agentId, t), [agentId, setDraft]);
  return [text, set];
}

export function useChatState(agentId: string): ChatViewState | undefined {
  return useChatStore((s) => s.agents[agentId]);
}

export function useChatLoading(agentId: string): boolean {
  return useChatStore((s) => !!s.loading[agentId]);
}

/**
 * Load the agent's transcript unless this window has already read it. Live
 * events keep loaded state current, so a remount (a canvas card zooming, a
 * second view of the same agent) reuses it instead of re-reading and flashing
 * a loading state. State built only from live events doesn't count: a running
 * agent in a freshly opened window gets live events before any view loads its
 * history, and that history must still be read (#2150). `tail` reads only the
 * last events; a view that wants the whole history (no tail) reloads state
 * that came from a tail.
 */
export function useChatTranscript(agentId: string, tail?: number): void {
  const loadTranscript = useChatStore((s) => s.loadTranscript);
  useEffect(() => {
    const s = useChatStore.getState();
    if (s.loading[agentId]) return;
    if (s.loaded[agentId] && (tail !== undefined || !s.partial[agentId])) return;
    void loadTranscript(agentId, tail);
  }, [agentId, tail, loadTranscript]);
}

/** Whether earlier history exists that wasn't loaded, and a way to load all of it. */
export function useEarlierHistory(agentId: string): { partial: boolean; loadAll: () => void } {
  const partial = useChatStore((s) => !!s.partial[agentId]);
  const loadTranscript = useChatStore((s) => s.loadTranscript);
  const loadAll = useCallback(() => {
    // A load already running owns the live events held for it; a second one would replace them.
    if (useChatStore.getState().loading[agentId]) return;
    void loadTranscript(agentId);
  }, [agentId, loadTranscript]);
  return { partial, loadAll };
}

function reportFailure(what: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  useToastStore.getState().addToast(`${what}: ${detail}`, 'error');
}

function stillWaiting(state: ChatViewState | undefined, requestId: string): boolean {
  return !!state && (state.pendingPermissions.some((p) => p.requestId === requestId) || state.pendingQuestions.some((q) => q.requestId === requestId));
}

export function useChatActions(agentId: string): ChatActions {
  const store = useChatStore;
  const wrap = useCallback(<A extends unknown[], R>(what: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<{ ok: true; value: R } | { ok: false }> => {
      try {
        return { ok: true, value: await fn(...args) };
      } catch (err) {
        // telemetry-exempt: shown to the user; chat stays independent of telemetry (research §7.3), which maps chat events itself.
        reportFailure(what, err);
        return { ok: false };
      }
    }, []);

  return useMemo<ChatActions>(() => ({
    isSessionCurrent: (sessionId) => store.getState().agents[agentId]?.sessionId === sessionId,
    send: async (text, delivery, attachments) => {
      const r = attachments?.length
        ? await wrap('Message delivery unconfirmed', store.getState().send)(agentId, text, delivery, attachments)
        : await wrap('Message delivery unconfirmed', store.getState().send)(agentId, text, delivery);
      return r.ok ? r.value : null;
    },
    interrupt: async () => (await wrap("Couldn't stop the turn", store.getState().interrupt)(agentId)).ok,
    removeQueued: async (messageIds) => {
      const r = await wrap("Couldn't remove the queued message", store.getState().removeQueued)(agentId, messageIds);
      if (!r.ok) return false;
      // Too late: the turn ending already sent it.
      if (r.value.length === 0) useToastStore.getState().addToast('Already sent, so not removed', 'info');
      return r.value.length > 0;
    },
    // An answer goes to the request the user acted on, read live: not to one that resolved after the card was drawn.
    respondPermission: async (requestId, optionId, extras) =>
      stillWaiting(store.getState().agents[agentId], requestId)
      && (await wrap("Couldn't answer the request", store.getState().respondPermission)(agentId, requestId, optionId, extras)).ok,
    answerQuestion: async (requestId, answers) =>
      stillWaiting(store.getState().agents[agentId], requestId)
      && (await wrap("Couldn't send the answer", store.getState().answerQuestion)(agentId, requestId, answers)).ok,
    setLevel: async (level) => (await wrap("Couldn't change the permission level", store.getState().setLevel)(agentId, level)).ok,
    setModel: async (modelId, effort) => { await wrap("Couldn't change the model", store.getState().setModel)(agentId, modelId, effort); },
    setEffort: async (effort) => { await wrap("Couldn't change the effort", store.getState().setEffort)(agentId, effort); },
  }), [agentId, store, wrap]);
}
