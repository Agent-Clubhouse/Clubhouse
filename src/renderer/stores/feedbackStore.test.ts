import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFeedbackStore, useFeedbackStore, FEEDBACK_NOTICE_TEXT } from './feedbackStore';
import { useToastStore } from './toastStore';
import { feedbackStatus } from '../features/feedback/feedback-test-utils';
import type { FeedbackStatus } from '../../shared/feedback-types';

let push: ((s: FeedbackStatus) => void) | null = null;

beforeEach(() => {
  resetFeedbackStore();
  useToastStore.setState({ toasts: [] });
  window.clubhouse.app.getExperimentalSettings = vi.fn(async () => ({ feedback: true }));
  window.clubhouse.app.isPreviewEligible = vi.fn(async () => true);
  window.clubhouse.feedback.getStatus = vi.fn(async () => feedbackStatus());
  window.clubhouse.feedback.onStatusChanged = vi.fn((cb) => { push = cb; return () => { push = null; }; });
});
afterEach(() => resetFeedbackStore());

describe('feedbackStore', () => {
  it('loads the switch and status, then follows main', async () => {
    await useFeedbackStore.getState().init();
    expect(useFeedbackStore.getState()).toMatchObject({ enabled: true, loaded: true, status: { connected: true } });
    push!(feedbackStatus({ connected: false }));
    expect(useFeedbackStore.getState().status?.connected).toBe(false);
    await useFeedbackStore.getState().init();
    expect(window.clubhouse.feedback.onStatusChanged).toHaveBeenCalledTimes(1);
  });

  it('stays off (and never asks for status) without the switch or a preview build', async () => {
    window.clubhouse.app.isPreviewEligible = vi.fn(async () => false);
    await useFeedbackStore.getState().init();
    expect(useFeedbackStore.getState()).toMatchObject({ enabled: false, status: null });
    expect(window.clubhouse.feedback.getStatus).not.toHaveBeenCalled();
    push?.(feedbackStatus());
    expect(useFeedbackStore.getState().status).toBeNull();
  });

  it('re-reads the switch when main says Feedback stopped', async () => {
    await useFeedbackStore.getState().init();
    window.clubhouse.app.getExperimentalSettings = vi.fn(async () => ({ feedback: false }));
    push!(null as never);
    await vi.waitFor(() => expect(useFeedbackStore.getState()).toMatchObject({ enabled: false, status: null }));
  });

  it('toasts a persistent notice once per run, outside Settings', async () => {
    await useFeedbackStore.getState().init();
    push!(feedbackStatus({ notice: 'access-required' }));
    push!(feedbackStatus({ notice: 'access-required' }));
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([FEEDBACK_NOTICE_TEXT['access-required']]);
  });
});
