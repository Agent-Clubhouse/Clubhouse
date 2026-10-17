/**
 * Framebriar screenshot feedback, renderer side: the Feedback switch and the live status
 * main pushes (access, outbox, receipts). Holds no secrets: main never sends them.
 */
import { create } from 'zustand';
import type { FeedbackNotice, FeedbackStatus } from '../../shared/feedback-types';
import { FEEDBACK_EXPERIMENTAL_FLAG } from '../../shared/feedback-types';
import { useToastStore } from './toastStore';

export const FEEDBACK_NOTICE_TEXT: Record<FeedbackNotice, string> = {
  expired: 'Your feedback access expired. Paste a new invitation in Settings, Feedback.',
  'access-required': 'Feedback access was revoked or isn\'t allowed any more. Paste a new invitation in Settings, Feedback.',
  'connection-uncertain': 'Clubhouse couldn\'t confirm the feedback connection. Paste the invitation again in Settings, Feedback.',
  'migration-required': 'Feedback needs to be set up again. Paste a new invitation in Settings, Feedback.',
};

interface FeedbackState {
  /** The Feedback switch is on (and the build is preview-eligible, like other experimental features). */
  enabled: boolean;
  status: FeedbackStatus | null;
  loaded: boolean;
  /** Load the switch and status once and follow main's changes. Safe to call repeatedly. */
  init: () => Promise<void>;
  /** Re-read the switch and status (after the Experimental toggle). */
  refresh: () => Promise<void>;
  setStatus: (status: FeedbackStatus) => void;
}

let initPromise: Promise<void> | null = null;
let unsubscribe: (() => void) | null = null;
/** Notices already toasted this run, so a persistent notice toasts once. */
const toastedNotices = new Set<string>();

async function loadEnabled(): Promise<boolean> {
  const [settings, eligible] = await Promise.all([
    window.clubhouse.app.getExperimentalSettings(),
    window.clubhouse.app.isPreviewEligible(),
  ]);
  return eligible === true && settings?.[FEEDBACK_EXPERIMENTAL_FLAG] === true;
}

export const useFeedbackStore = create<FeedbackState>((set, get) => ({
  enabled: false,
  status: null,
  loaded: false,

  init: () => {
    if (!initPromise) {
      initPromise = get().refresh();
      unsubscribe ??= window.clubhouse.feedback.onStatusChanged((status) => get().setStatus(status));
    }
    return initPromise;
  },

  refresh: async () => {
    try {
      const enabled = await loadEnabled();
      set({ enabled });
      if (enabled) get().setStatus(await window.clubhouse.feedback.getStatus());
      else set({ status: null });
    } catch {
      // telemetry-exempt: feedback is optional; without status the button and page stay hidden.
      set({ status: null });
    } finally {
      set({ loaded: true });
    }
  },

  setStatus: (status) => {
    if (!get().enabled) return;
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
  toastedNotices.clear();
  useFeedbackStore.setState({ enabled: false, status: null, loaded: false });
}
