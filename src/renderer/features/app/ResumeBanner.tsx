import { useEffect } from 'react';
import { Spinner } from '../../components/Spinner';
import { NoticeCard, NOTICE_DOT, type NoticeTone } from '../../components/NoticeCard';
import { Button } from '../../components/Button';

export type ResumeStatus = 'pending' | 'resuming' | 'resumed' | 'failed' | 'manual' | 'timed_out';

export interface ResumeBannerSession {
  agentId: string;
  agentName: string;
  status: ResumeStatus;
  error?: string;
}

interface ResumeBannerProps {
  sessions: ResumeBannerSession[];
  onManualResume: (agentId: string) => void;
  onDismiss: () => void;
  /** `bar` is the classic strip; `card` is the new chrome's sidebar notice. */
  variant?: 'bar' | 'card';
}

const STATUS_ICON: Record<ResumeStatus, string> = {
  resumed: '✓',
  resuming: '↻',
  pending: '○',
  manual: '▸',
  failed: '✗',
  timed_out: '⏱',
};

const STATUS_COLOR: Record<ResumeStatus, string> = {
  resumed: 'text-ctp-green',
  resuming: 'text-ctp-yellow',
  pending: 'text-ctp-subtext0',
  manual: 'text-ctp-peach',
  failed: 'text-ctp-red',
  timed_out: 'text-ctp-peach',
};

const CARD_STATUS: Record<ResumeStatus, [NoticeTone, string]> = {
  resumed: ['success', 'Done'],
  resuming: ['info', 'Working'],
  // Queued behind the others, not running yet.
  pending: ['neutral', 'Sleeping'],
  manual: ['warning', 'Needs you'],
  failed: ['error', 'Error'],
  timed_out: ['warning', 'Needs you'],
};

export function ResumeBanner({ sessions, onManualResume, onDismiss, variant = 'bar' }: ResumeBannerProps) {
  if (sessions.length === 0) return null;

  const allSucceeded = sessions.every((s) => s.status === 'resumed');

  // Auto-dismiss 3 seconds after ALL sessions resumed successfully.
  // If any failed or timed out, keep the banner visible so the user can see.
  useEffect(() => {
    if (!allSucceeded) return;
    const timer = setTimeout(onDismiss, 3000);
    return () => clearTimeout(timer);
  }, [allSucceeded, onDismiss]);

  if (variant === 'card') {
    const anyFailed = sessions.some((s) => s.status === 'failed');
    const count = `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`;
    return (
      <NoticeCard
        tone={anyFailed ? 'error' : allSucceeded ? 'success' : 'info'}
        title={allSucceeded ? `Resumed ${count}` : `Resuming ${count}`}
        meta="After update"
        testId="resume-banner"
        actions={<Button kind="quiet" onClick={onDismiss}>Dismiss</Button>}
      >
        <ul className="flex flex-col gap-1">
          {sessions.map((s) => {
            const [tone, word] = CARD_STATUS[s.status];
            return (
              <li key={s.agentId} className="flex flex-col">
                <div className="flex items-center gap-2 min-h-6">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${NOTICE_DOT[tone]}`} aria-hidden="true" />
                  <span className="min-w-0 truncate text-ctp-text">{s.agentName}</span>
                  <span className="flex-shrink-0">{word}</span>
                  {(s.status === 'manual' || s.status === 'timed_out') && (
                    <Button kind="ghost" className="ml-auto !h-6" onClick={() => onManualResume(s.agentId)}>
                      {s.status === 'manual' ? 'Resume' : 'Retry'}
                    </Button>
                  )}
                </div>
                {s.status === 'failed' && s.error && <span className="pl-4 text-ctp-error">{s.error}</span>}
              </li>
            );
          })}
        </ul>
      </NoticeCard>
    );
  }

  return (
    <div
      className="flex-shrink-0 bg-ctp-green/8 border-b border-ctp-green/15 text-sm px-4 py-2.5"
      data-testid="resume-banner"
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-ctp-green flex items-center gap-1.5">
          <Spinner size="xs" />
          Resuming {sessions.length} session{sessions.length !== 1 ? 's' : ''} after update
        </span>
        <button
          onClick={onDismiss}
          className="px-2 py-0.5 text-xs rounded-md bg-surface-1 border border-surface-2 text-ctp-subtext0
            hover:bg-surface-2 hover:text-ctp-text transition-colors cursor-pointer"
        >
          Dismiss
        </button>
      </div>
      {sessions.map((s) => (
        <div key={s.agentId} className="flex items-center gap-2 text-xs py-1">
          <span className={`${STATUS_COLOR[s.status]} font-mono`}>{STATUS_ICON[s.status]}</span>
          <span className="text-ctp-text font-medium">{s.agentName}</span>
          {s.status === 'resuming' && <span className="text-ctp-subtext0">resuming...</span>}
          {s.status === 'resumed' && <span className="text-ctp-green/60">done</span>}
          {s.status === 'manual' && (
            <button
              onClick={() => onManualResume(s.agentId)}
              className="px-2 py-0.5 rounded-md bg-ctp-peach/15 border border-ctp-peach/30 text-ctp-peach
                hover:bg-ctp-peach/25 transition-colors cursor-pointer font-medium"
            >
              Resume
            </button>
          )}
          {s.status === 'failed' && (
            <span className="px-2 py-0.5 rounded-md bg-ctp-red/10 border border-ctp-red/20 text-ctp-red">
              {s.error || 'Failed'}
            </span>
          )}
          {s.status === 'timed_out' && (
            <button
              onClick={() => onManualResume(s.agentId)}
              className="px-2 py-0.5 rounded-md bg-ctp-peach/15 border border-ctp-peach/30 text-ctp-peach
                hover:bg-ctp-peach/25 transition-colors cursor-pointer font-medium"
            >
              Retry
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
