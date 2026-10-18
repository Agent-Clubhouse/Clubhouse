import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { Modal } from '../../components/Modal';
import type { FeedbackCaptureResult, FeedbackShot } from '../../../shared/feedback-types';
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

/** The windows captured, falling back to the single preview from an older main. */
function shotsOf(draft: FeedbackCaptureResult): FeedbackShot[] {
  if (draft.shots?.length) return draft.shots;
  return draft.preview ? [{ shotId: '', label: 'This window', preview: draft.preview }] : [];
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
  const shots = shotsOf(draft);
  const [shotIndex, setShotIndex] = useState(0);
  // Ink is per window: switching windows keeps each one's drawing.
  const [inkByShot, setInkByShot] = useState<Stroke[][]>([]);
  const shot = shots[shotIndex] ?? null;
  const strokes = inkByShot[shotIndex] ?? [];
  const setStrokes = useCallback((next: Stroke[]) => {
    setInkByShot((all) => { const copy = [...all]; copy[shotIndex] = next; return copy; });
  }, [shotIndex]);
  const hasScreenshot = shot !== null;

  // Ink belongs to one capture: a new capture starts clean.
  useEffect(() => { setInkByShot([]); setShotIndex(0); }, [draft.draftId]);

  const onShotKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step || phase === 'sending') return;
    e.preventDefault();
    const next = (shotIndex + step + shots.length) % shots.length;
    setShotIndex(next);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  const cancel = useCallback(() => {
    if (phase === 'review') void window.clubhouse.feedback.cancel(draft.draftId);
    onClose();
  }, [phase, draft.draftId, onClose]);

  const send = async (includeScreenshot: boolean) => {
    setPhase('sending');
    setError(null);
    try {
      // The drawing is baked into the capture at full size; main checks it is the same image size.
      const annotatedPng = includeScreenshot && shot && strokes.length > 0
        ? await compositeAnnotatedPng(shot.preview, strokes)
        : undefined;
      const result = await window.clubhouse.feedback.send({
        draftId: draft.draftId,
        notes,
        includeScreenshot,
        scene: currentScene(),
        ...(annotatedPng !== undefined && { annotatedPng }),
        ...(includeScreenshot && shot?.shotId && { shotId: shot.shotId }),
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
            {shots.length > 1 && (
              <div className="flex gap-2 overflow-x-auto" role="radiogroup" aria-label="Window to send" onKeyDown={onShotKey} data-testid="feedback-shots">
                {shots.map((s, i) => (
                  <button
                    key={s.shotId || i}
                    type="button"
                    role="radio"
                    aria-checked={i === shotIndex}
                    // Roving tabindex: one Tab stop for the group, arrows move between windows.
                    tabIndex={i === shotIndex ? 0 : -1}
                    disabled={phase === 'sending'}
                    onClick={() => setShotIndex(i)}
                    className={`flex-shrink-0 w-32 p-1 rounded-md border text-left focus-ring disabled:opacity-50 ${i === shotIndex ? 'border-ctp-accent bg-surface-0' : 'border-surface-1 hover:bg-surface-0'}`}
                    data-testid={`feedback-shot-${i}`}
                  >
                    <img src={s.preview} alt="" className="block w-full h-16 object-cover rounded-sm bg-ctp-base" draggable={false} />
                    <span className="block mt-1 text-xs text-ctp-subtext1 truncate" title={s.label}>{s.label}</span>
                  </button>
                ))}
              </div>
            )}
            {shot ? (
              <ScreenshotAnnotator key={shotIndex} src={shot.preview} strokes={strokes} onChange={setStrokes} disabled={phase === 'sending'} />
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
              Only Clubhouse windows are captured, and only the one you choose is sent. Links, email addresses and file paths in notes are removed before sending.
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
