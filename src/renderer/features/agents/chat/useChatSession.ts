/**
 * The one seam between ChatView and the chat store. Components read state and
 * call actions through these hooks only, so the store (or a fixture replayer)
 * can be swapped without touching them.
 */

import { useCallback, useEffect, useMemo } from 'react';
import type { ChatQuestionAnswers, MessageDelivery, PermissionLevel, PermissionResponseExtras, RuntimeSendResult } from '../../../../shared/chat';
import { useChatStore, type ChatViewState } from '../../../stores/chatStore';
import { useToastStore } from '../../../stores/toastStore';

export interface ChatActions {
  send: (text: string, delivery?: 'auto' | MessageDelivery) => Promise<RuntimeSendResult | null>;
  interrupt: () => Promise<void>;
  respondPermission: (requestId: string, optionId: string, extras?: PermissionResponseExtras) => Promise<void>;
  answerQuestion: (requestId: string, answers: ChatQuestionAnswers) => Promise<void>;
  setLevel: (level: PermissionLevel) => Promise<void>;
}

export function useChatState(agentId: string): ChatViewState | undefined {
  return useChatStore((s) => s.agents[agentId]);
}

export function useChatLoading(agentId: string): boolean {
  return useChatStore((s) => !!s.loading[agentId]);
}

/** Load the agent's transcript once per mount; live events merge on top. */
export function useChatTranscript(agentId: string): void {
  const loadTranscript = useChatStore((s) => s.loadTranscript);
  useEffect(() => {
    void loadTranscript(agentId);
  }, [agentId, loadTranscript]);
}

function reportFailure(what: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  useToastStore.getState().addToast(`${what}: ${detail}`, 'error');
}

export function useChatActions(agentId: string): ChatActions {
  const store = useChatStore;
  const wrap = useCallback(<A extends unknown[], R>(what: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R | undefined> => {
      try {
        return await fn(...args);
      } catch (err) {
        reportFailure(what, err);
        return undefined;
      }
    }, []);

  return useMemo<ChatActions>(() => ({
    send: async (text, delivery) => (await wrap('Message not sent', store.getState().send)(agentId, text, delivery)) ?? null,
    interrupt: async () => { await wrap("Couldn't stop the turn", store.getState().interrupt)(agentId); },
    respondPermission: async (requestId, optionId, extras) => {
      await wrap("Couldn't answer the request", store.getState().respondPermission)(agentId, requestId, optionId, extras);
    },
    answerQuestion: async (requestId, answers) => {
      await wrap("Couldn't send the answer", store.getState().answerQuestion)(agentId, requestId, answers);
    },
    setLevel: async (level) => { await wrap("Couldn't change the permission level", store.getState().setLevel)(agentId, level); },
  }), [agentId, store, wrap]);
}
