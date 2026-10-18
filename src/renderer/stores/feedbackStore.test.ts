import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFeedbackStore, useFeedbackStore, FEEDBACK_NOTICE_TEXT } from './feedbackStore';
import { useToastStore } from './toastStore';
import { feedbackStatus } from '../features/feedback/feedback-test-utils';
import type { FeedbackStatus } from '../../shared/feedback-types';

let push: ((s: FeedbackStatus) => void) | null = null;

beforeEach(() => {
  resetFeedbackStore();
  useToastStore.setState({ toasts: [] });
  window.clubhouse.feedback.getStatus = vi.fn(async () => feedbackStatus());
  window.clubhouse.feedback.onStatusChanged = vi.fn((cb) => { push = cb; return () => { push = null; }; });
});
afterEach(() => resetFeedbackStore());

describe('feedbackStore', () => {
  it('loads the status with no switch, then follows main', async () => {
    await useFeedbackStore.getState().init();
    expect(useFeedbackStore.getState()).toMatchObject({ loaded: true, status: { connected: true } });
    push!(feedbackStatus({ connected: false }));
    expect(useFeedbackStore.getState().status?.connected).toBe(false);
    await useFeedbackStore.getState().init();
    expect(window.clubhouse.feedback.onStatusChanged).toHaveBeenCalledTimes(1);
  });

  it('clears the status when main says Feedback stopped (quit)', async () => {
    await useFeedbackStore.getState().init();
    push!(null as never);
    expect(useFeedbackStore.getState().status).toBeNull();
  });

  it('toasts a persistent notice once per run, outside Settings', async () => {
    await useFeedbackStore.getState().init();
    push!(feedbackStatus({ notice: 'access-required' }));
    push!(feedbackStatus({ notice: 'access-required' }));
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([FEEDBACK_NOTICE_TEXT['access-required']]);
  });

  it('opens a draft captured with the keyboard shortcut (#2101), subscribing once', async () => {
    let deliver: ((d: { draftId: string; preview: string | null; shots: [] }) => void) | null = null;
    window.clubhouse.feedback.onCaptured = vi.fn((cb) => { deliver = cb as typeof deliver; return () => { deliver = null; }; });
    await useFeedbackStore.getState().init();
    await useFeedbackStore.getState().init();
    expect(window.clubhouse.feedback.onCaptured).toHaveBeenCalledTimes(1);
    deliver!({ draftId: 'd-1', preview: null, shots: [] });
    expect(useFeedbackStore.getState().draft?.draftId).toBe('d-1');
    useFeedbackStore.getState().closeDraft();
    expect(useFeedbackStore.getState().draft).toBeNull();
  });
});
