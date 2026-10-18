import { useEffect } from 'react';
import { useFeedbackStore } from '../../stores/feedbackStore';
import { FeedbackReviewDialog } from './FeedbackReviewDialog';

/**
 * The feedback review dialog at app level, so a capture from the keyboard shortcut (#2101)
 * opens even when no Feedback button is on screen. A review in progress stays open even if
 * capture eligibility flips mid-Send (e.g. access expires), so the draft isn't orphaned.
 */
export function FeedbackDialogHost() {
  const draft = useFeedbackStore((s) => s.draft);
  const closeDraft = useFeedbackStore((s) => s.closeDraft);
  const init = useFeedbackStore((s) => s.init);
  // Start following main here too, so shortcut captures arrive with no Feedback button mounted.
  useEffect(() => { void init(); }, [init]);
  // Keyed by draft: a new capture is a fresh review (notes, ink, chosen window).
  return draft ? <FeedbackReviewDialog key={draft.draftId} draft={draft} onClose={closeDraft} /> : null;
}
