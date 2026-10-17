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
  /** `attachmentIds` are staged attachment ids. */
  send: (text: string, delivery?: 'auto' | MessageDelivery, attachmentIds?: string[]) => Promise<RuntimeSendResult | null>;
  interrupt: () => Promise<void>;
  /** Resolves false when the answer didn't reach the agent (a toast says why). */
  respondPermission: (requestId: string, optionId: string, extras?: PermissionResponseExtras) => Promise<boolean>;
  answerQuestion: (requestId: string, answers: ChatQuestionAnswers) => Promise<boolean>;
  setLevel: (level: PermissionLevel) => Promise<void>;
  setModel?: (modelId: string, effort?: string) => Promise<void>;
}

/**
 * Unsent composer text per agent. It lives outside the composer so a draft
 * survives the composer being swapped for an approval card, or switching agents.
 */
interface DraftState {
  drafts: Record<string, string>;
  setDraft: (agentId: string, text: string) => void;
  /** Unsent attachments per agent, kept alongside the text for the same reason. */
  attachments: Record<string, ComposerAttachment[]>;
  setAttachments: (agentId: string, attachments: ComposerAttachment[]) => void;
}

export const useChatDraftStore = create<DraftState>((set) => ({
  drafts: {},
  setDraft: (agentId, text) => set((s) => {
    const drafts = { ...s.drafts };
    if (text) drafts[agentId] = text;
    else delete drafts[agentId];
    return { drafts };
  }),
  attachments: {},
  setAttachments: (agentId, list) => set((s) => {
    const attachments = { ...s.attachments };
    if (list.length) attachments[agentId] = list;
    else delete attachments[agentId];
    return { attachments };
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
 * Load the agent's transcript unless the store already has it. Live events
 * keep loaded state current, so a remount (a canvas card zooming, a second
 * view of the same agent) reuses it instead of re-reading and flashing a
 * loading state. `tail` reads only the last events; a view that wants the
 * whole history (no tail) reloads state that came from a tail.
 */
export function useChatTranscript(agentId: string, tail?: number): void {
  const loadTranscript = useChatStore((s) => s.loadTranscript);
  useEffect(() => {
    const s = useChatStore.getState();
    if (s.loading[agentId]) return;
    if (s.agents[agentId] && (tail !== undefined || !s.partial[agentId])) return;
    void loadTranscript(agentId, tail);
  }, [agentId, tail, loadTranscript]);
}

/** Whether earlier history exists that wasn't loaded, and a way to load all of it. */
export function useEarlierHistory(agentId: string): { partial: boolean; loadAll: () => void } {
  const partial = useChatStore((s) => !!s.partial[agentId]);
  const loadTranscript = useChatStore((s) => s.loadTranscript);
  return { partial, loadAll: useCallback(() => { void loadTranscript(agentId); }, [agentId, loadTranscript]) };
}

function reportFailure(what: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  useToastStore.getState().addToast(`${what}: ${detail}`, 'error');
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
    send: async (text, delivery, attachments) => {
      const r = attachments?.length
        ? await wrap('Message not sent', store.getState().send)(agentId, text, delivery, attachments)
        : await wrap('Message not sent', store.getState().send)(agentId, text, delivery);
      return r.ok ? r.value : null;
    },
    interrupt: async () => { await wrap("Couldn't stop the turn", store.getState().interrupt)(agentId); },
    respondPermission: async (requestId, optionId, extras) =>
      (await wrap("Couldn't answer the request", store.getState().respondPermission)(agentId, requestId, optionId, extras)).ok,
    answerQuestion: async (requestId, answers) =>
      (await wrap("Couldn't send the answer", store.getState().answerQuestion)(agentId, requestId, answers)).ok,
    setLevel: async (level) => { await wrap("Couldn't change the permission level", store.getState().setLevel)(agentId, level); },
    setModel: async (modelId, effort) => { await wrap("Couldn't change the model", store.getState().setModel)(agentId, modelId, effort); },
  }), [agentId, store, wrap]);
}
