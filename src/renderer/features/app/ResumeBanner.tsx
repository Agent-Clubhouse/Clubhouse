import { useEffect } from 'react';

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

export function ResumeBanner({ sessions, onManualResume, onDismiss }: ResumeBannerProps) {
  if (sessions.length === 0) return null;

  const allSucceeded = sessions.every((s) => s.status === 'resumed');

  // Auto-dismiss 3 seconds after ALL sessions resumed successfully.
  // If any failed or timed out, keep the banner visible so the user can see.
  useEffect(() => {
    if (!allSucceeded) return;
    const timer = setTimeout(onDismiss, 3000);
    return () => clearTimeout(timer);
  }, [allSucceeded, onDismiss]);

  return (
    <div
      className="flex-shrink-0 bg-ctp-green/8 border-b border-ctp-green/15 text-sm px-4 py-2.5"
      data-testid="resume-banner"
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-ctp-green flex items-center gap-1.5">
          <span className="animate-spin inline-block" style={{ animationDuration: '2s' }}>↻</span>
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
