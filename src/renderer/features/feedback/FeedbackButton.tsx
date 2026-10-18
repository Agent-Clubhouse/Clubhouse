import { useEffect, useState } from 'react';
import { FEEDBACK_CAPTURE_SHORTCUT_LABEL } from '../../../shared/feedback-types';
import { FEEDBACK_NOTICE_TEXT, useFeedbackStore } from '../../stores/feedbackStore';
import { useToastStore } from '../../stores/toastStore';

interface Props {
  /** 'rail': classic project rail footer row. 'sidebar': new layout sidebar footer icon. */
  variant: 'rail' | 'sidebar';
  /** Rail only: the rail is expanded and shows labels. */
  expanded?: boolean;
}

function FeedbackIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M12 7v4" /><path d="M12 14h.01" />
    </svg>
  );
}

/**
 * Feedback: screenshot this Clubhouse window, then review and send. Shown only once an
 * invitation is connected and Framebriar says feedback can be captured. A
 * marker stays on the button while a notice or unsent feedback is pending.
 */
export function FeedbackButton({ variant, expanded = false }: Props) {
  const canCapture = useFeedbackStore((s) => s.status?.canCapture === true);
  const notice = useFeedbackStore((s) => s.status?.notice ?? null);
  const pending = useFeedbackStore((s) => s.status?.outbox.pending ?? 0);
  const init = useFeedbackStore((s) => s.init);
  const openDraft = useFeedbackStore((s) => s.openDraft);
  const [capturing, setCapturing] = useState(false);

  useEffect(() => { void init(); }, [init]);

  // The review dialog itself lives in FeedbackDialogHost, at app level.
  if (!canCapture) return null;

  const open = async () => {
    if (capturing) return;
    setCapturing(true);
    try {
      // Captured before the dialog draws, so the screenshot shows what the user saw.
      openDraft(await window.clubhouse.feedback.capture());
    } catch (err) {
      // telemetry-exempt: shown to the user
      useToastStore.getState().addToast(`Couldn't capture feedback: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setCapturing(false);
    }
  };

  const pendingText = pending > 0 ? `${pending} feedback ${pending === 1 ? 'report' : 'reports'} waiting to send` : null;
  const shortcut = window.clubhouse.platform === 'darwin' ? FEEDBACK_CAPTURE_SHORTCUT_LABEL.mac : FEEDBACK_CAPTURE_SHORTCUT_LABEL.other;
  const label = ['Send feedback', notice ? FEEDBACK_NOTICE_TEXT[notice] : null, pendingText].filter(Boolean).join('. ');
  // The tooltip also names the capture shortcut; the accessible name stays short.
  const title = [`Send feedback (${shortcut} captures what's under the pointer)`, notice ? FEEDBACK_NOTICE_TEXT[notice] : null, pendingText].filter(Boolean).join('. ');
  const marker = notice || pending > 0 ? (
    <span
      className={`absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full ${notice ? 'bg-ctp-warning' : 'bg-ctp-subtext0'}`}
      data-testid="feedback-marker"
      data-kind={notice ? 'notice' : 'pending'}
    />
  ) : null;

  const button = variant === 'sidebar' ? (
    <button
      type="button"
      onClick={() => void open()}
      disabled={capturing}
      title={title}
      aria-label={label}
      data-testid="nav-feedback"
      className="relative w-7 h-7 rounded-md flex items-center justify-center text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text cursor-pointer disabled:opacity-50"
    >
      <FeedbackIcon size={15} />
      {marker}
    </button>
  ) : (
    <button
      type="button"
      onClick={() => void open()}
      disabled={capturing}
      title={title}
      aria-label={label}
      data-testid="nav-feedback"
      className={`w-full h-10 flex items-center gap-3 cursor-pointer rounded-lg flex-shrink-0 disabled:opacity-50 ${expanded ? 'hover:bg-surface-0' : ''}`}
    >
      <div
        className={`relative w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors duration-100 ${
          expanded ? 'text-ctp-subtext0' : 'text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text'
        }`}
      >
        <FeedbackIcon size={18} />
        {marker}
      </div>
      <span className={`text-xs font-medium truncate pr-3 whitespace-nowrap text-ctp-text transition-opacity duration-200 ${expanded ? 'opacity-100' : 'opacity-0'}`}>Feedback</span>
    </button>
  );

  return button;
}
