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
  resuming: '◌',
  pending: '◌',
  manual: '⚠',
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

  return (
    <div className="flex-shrink-0 bg-ctp-info/10 border-b border-ctp-info/20 text-ctp-info text-sm px-4 py-2" data-testid="resume-banner">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium">
          ↻ Resuming {sessions.length} session{sessions.length !== 1 ? 's' : ''} after update...
        </span>
        <button onClick={onDismiss} className="text-ctp-info/50 hover:text-ctp-info transition-colors cursor-pointer px-1 text-xs">Dismiss</button>
      </div>
      {sessions.map((s) => (
        <div key={s.agentId} className="flex items-center gap-2 text-xs py-0.5">
          <span className={STATUS_COLOR[s.status]}>{STATUS_ICON[s.status]}</span>
          <span className="text-ctp-text">{s.agentName}</span>
          {s.status === 'resuming' && <span className="text-ctp-subtext0">resuming...</span>}
          {s.status === 'manual' && (
            <button onClick={() => onManualResume(s.agentId)} className="text-ctp-peach hover:text-ctp-peach/80 underline cursor-pointer">tap to resume</button>
          )}
          {s.status === 'failed' && <span className="text-ctp-red">{s.error || 'Resume failed'}</span>}
          {s.status === 'timed_out' && (
            <button onClick={() => onManualResume(s.agentId)} className="text-ctp-peach hover:text-ctp-peach/80 underline cursor-pointer">retry</button>
          )}
        </div>
      ))}
    </div>
  );
}
