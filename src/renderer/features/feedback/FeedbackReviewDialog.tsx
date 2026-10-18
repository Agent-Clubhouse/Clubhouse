import { useCallback, useEffect, useState } from 'react';
import { Modal } from '../../components/Modal';
import type { FeedbackCaptureResult } from '../../../shared/feedback-types';
import { useFeedbackStore } from '../../stores/feedbackStore';
import { useUIStore } from '../../stores/uiStore';
import { compositeAnnotatedPng, type Stroke } from './annotation';
import { ScreenshotAnnotator } from './ScreenshotAnnotator';

interface Props {
  draft: FeedbackCaptureResult;
  onClose: () => void;
}

type Phase = 'review' | 'sending' | 'saved';

/** A scene code for the report: the current Clubhouse tab, never user text. */
function currentScene(): string {
  const tab = useUIStore.getState().explorerTab;
  return typeof tab === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(tab) ? tab : 'app';
}

/**
 * Review a captured screenshot before it leaves the computer: preview, notes, and Send,
 * "Send without screenshot" or Cancel. After sending it shows "Saved" (queued on this
 * computer), then "Received" once the server acknowledges the report.
 */
export function FeedbackReviewDialog({ draft, onClose }: Props) {
  const [notes, setNotes] = useState('');
  const [phase, setPhase] = useState<Phase>('review');
  const [reportId, setReportId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const received = useFeedbackStore((s) => (reportId ? s.status?.received.includes(reportId) === true : false));
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const hasScreenshot = draft.preview !== null;

  // Ink belongs to one capture: a new capture starts clean.
  useEffect(() => { setStrokes([]); }, [draft.draftId]);

  const cancel = useCallback(() => {
    if (phase === 'review') void window.clubhouse.feedback.cancel(draft.draftId);
    onClose();
  }, [phase, draft.draftId, onClose]);

  const send = async (includeScreenshot: boolean) => {
    setPhase('sending');
    setError(null);
    try {
      // The drawing is baked into the capture at full size; main checks it is the same image size.
      const annotatedPng = includeScreenshot && draft.preview && strokes.length > 0
        ? await compositeAnnotatedPng(draft.preview, strokes)
        : undefined;
      const result = await window.clubhouse.feedback.send({
        draftId: draft.draftId,
        notes,
        includeScreenshot,
        scene: currentScene(),
        ...(annotatedPng !== undefined && { annotatedPng }),
      });
      setReportId(result.id);
      setPhase('saved');
    } catch (err) {
      // telemetry-exempt: shown to the user; the reviewed draft is kept for a retry.
      setError(err instanceof Error ? err.message : String(err));
      setPhase('review');
    }
  };

  return (
    <Modal open onClose={phase === 'sending' ? () => undefined : cancel} title="Send feedback" width="w-[560px]">
      <div className="px-5 pb-5 pt-3 space-y-3" data-testid="feedback-review">
        {phase === 'saved' ? (
          <div className="space-y-3">
            <p className="text-sm text-ctp-text" role="status" data-testid="feedback-sent-state">
              {received ? 'Received. Thanks for the feedback.' : 'Saved. It\'s queued on this computer and is sent as soon as Clubhouse can reach the server.'}
            </p>
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded-md bg-surface-0 text-ctp-text hover:bg-surface-1">Close</button>
            </div>
          </div>
        ) : (
          <>
            {hasScreenshot ? (
              <ScreenshotAnnotator src={draft.preview!} strokes={strokes} onChange={setStrokes} />
            ) : (
              <p className="text-sm text-ctp-subtext0">No screenshot could be taken. You can still send a note.</p>
            )}
            <label htmlFor="feedback-notes" className="block text-sm text-ctp-text">What happened?</label>
            <textarea
              id="feedback-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              rows={4}
              placeholder="What you were doing, what you expected, what went wrong"
              className="w-full px-3 py-2 text-sm rounded-md bg-ctp-base border border-surface-1 text-ctp-text placeholder:text-ctp-overlay0 resize-none"
            />
            <p className="text-xs text-ctp-subtext0">
              Only this Clubhouse window is captured. Links, email addresses and file paths in notes are removed before sending.
            </p>
            {error && <p className="text-sm text-ctp-error" role="alert" data-testid="feedback-error">{error}</p>}
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={cancel} disabled={phase === 'sending'} className="px-3 py-1.5 text-sm rounded-md text-ctp-subtext1 hover:text-ctp-text hover:bg-surface-0 disabled:opacity-50">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void send(false)}
                disabled={phase === 'sending' || notes.trim() === ''}
                title={notes.trim() === '' ? 'Add a note to send without the screenshot' : undefined}
                className="px-3 py-1.5 text-sm rounded-md bg-surface-0 text-ctp-text hover:bg-surface-1 disabled:opacity-50"
              >
                Send without screenshot
              </button>
              <button
                type="button"
                onClick={() => void send(hasScreenshot)}
                disabled={phase === 'sending' || (!hasScreenshot && notes.trim() === '')}
                className="px-3 py-1.5 text-sm rounded-md bg-ctp-accent text-white disabled:opacity-50"
              >
                {phase === 'sending' ? 'Sending…' : 'Send'}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
