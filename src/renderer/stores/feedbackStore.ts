/**
 * Framebriar screenshot feedback, renderer side: the live status main pushes (access,
 * outbox, receipts). Holds no secrets: main never sends them.
 */
import { create } from 'zustand';
import type { FeedbackCaptureResult, FeedbackNotice, FeedbackStatus } from '../../shared/feedback-types';
import { useToastStore } from './toastStore';

export const FEEDBACK_NOTICE_TEXT: Record<FeedbackNotice, string> = {
  expired: 'Your feedback access expired. Paste a new invitation in Settings, Feedback.',
  'access-required': 'Feedback access was revoked or isn\'t allowed any more. Paste a new invitation in Settings, Feedback.',
  'connection-uncertain': 'Clubhouse couldn\'t confirm the feedback connection. The server may still have accepted it, so paste the same invitation again in Settings, Feedback.',
  'migration-required': 'Feedback needs to be set up again. Paste a new invitation in Settings, Feedback.',
};

interface FeedbackState {
  status: FeedbackStatus | null;
  loaded: boolean;
  /** Load the status once and follow main's changes. Safe to call repeatedly. */
  init: () => Promise<void>;
  /** Re-read the status. */
  refresh: () => Promise<void>;
  setStatus: (status: FeedbackStatus) => void;
  /** The capture being reviewed, from the button or the keyboard shortcut (#2101). */
  draft: FeedbackCaptureResult | null;
  /** Open a capture for review. One that was already open is cancelled first. */
  openDraft: (draft: FeedbackCaptureResult) => void;
  closeDraft: () => void;
}

let initPromise: Promise<void> | null = null;
let unsubscribe: (() => void) | null = null;
let unsubscribeCaptured: (() => void) | null = null;
/** Notices already toasted this run, so a persistent notice toasts once. */
const toastedNotices = new Set<string>();

export const useFeedbackStore = create<FeedbackState>((set, get) => ({
  status: null,
  loaded: false,
  draft: null,

  openDraft: (draft) => {
    const previous = get().draft;
    if (previous && previous.draftId !== draft.draftId) void window.clubhouse.feedback.cancel(previous.draftId);
    set({ draft });
  },

  closeDraft: () => set({ draft: null }),

  init: () => {
    if (!initPromise) {
      initPromise = get().refresh();
      unsubscribe ??= window.clubhouse.feedback.onStatusChanged((status) => {
        // null: Feedback stopped in main (app quitting).
        if (status === null) set({ status: null });
        else get().setStatus(status);
      });
      // Main captures on the keyboard shortcut and sends the draft here to review.
      unsubscribeCaptured ??= window.clubhouse.feedback.onCaptured((draft) => get().openDraft(draft));
    }
    return initPromise;
  },

  refresh: async () => {
    try {
      get().setStatus(await window.clubhouse.feedback.getStatus());
    } catch {
      // telemetry-exempt: feedback is optional; without status the button and page stay hidden.
      set({ status: null });
    } finally {
      set({ loaded: true });
    }
  },

  setStatus: (status) => {
    set({ status });
    // Persistent notices are shown outside Settings too: a toast once per run, and the
    // Feedback button keeps a marker until the notice clears.
    const notice = status.notice;
    if (notice && !toastedNotices.has(notice)) {
      toastedNotices.add(notice);
      useToastStore.getState().addToast(FEEDBACK_NOTICE_TEXT[notice], 'info');
    }
  },
}));

/** For tests. */
export function resetFeedbackStore(): void {
  initPromise = null;
  unsubscribe?.();
  unsubscribe = null;
  unsubscribeCaptured?.();
  unsubscribeCaptured = null;
  toastedNotices.clear();
  useFeedbackStore.setState({ status: null, loaded: false, draft: null });
}
