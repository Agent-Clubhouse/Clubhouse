import type { FeedbackStatus } from '../../../shared/feedback-types';
import { useFeedbackStore } from '../../stores/feedbackStore';

export function feedbackStatus(over: Partial<FeedbackStatus> = {}): FeedbackStatus {
  return {
    started: true, state: 'connected', connected: true, enrolled: true, canCapture: true, notice: null,
    expiresAt: '2026-11-16T00:00:00.000Z', storage: { available: true },
    outbox: { state: 'available', pending: 0, blocked: 0, bytes: 0, maxItems: 10, maxBytes: 33554432 },
    received: [],
    ...over,
  };
}

/** Put the feedback store in a known state without it reloading from the (mocked) bridge. */
export function setFeedback(available: boolean, status: FeedbackStatus | null = available ? feedbackStatus() : null): void {
  useFeedbackStore.setState({ status, loaded: true, init: async () => {}, refresh: async () => {} });
}
