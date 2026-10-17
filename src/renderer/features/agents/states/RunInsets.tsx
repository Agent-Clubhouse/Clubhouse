import { useEffect, useState } from 'react';
import { DiffCard } from '../chat/ToolBlocks';
import { TranscriptViewer } from '../TranscriptViewer';
import { Button } from '../../../components/Button';

/** Inline diff of one changed file, against HEAD, shown above the activity. */
export function FileDiffInset({ cwd, path, onClose }: { cwd: string; path: string; onClose: () => void }) {
  const [diff, setDiff] = useState<{ original: string; modified: string } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setFailed(false);
    window.clubhouse.git.diff(cwd, path, false)
      .then((d: { original: string; modified: string }) => { if (!cancelled) setDiff(d); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [cwd, path]);

  return (
    <section aria-label={`Changes in ${path}`} data-testid="run-file-diff">
      <div className="h-7 flex items-center gap-2 text-xs">
        <span className="font-semibold text-ctp-overlay1">Changes</span>
        <Button kind="quiet" className="ml-auto" onClick={onClose}>Close</Button>
      </div>
      {failed ? (
        <p className="py-1 text-xs text-ctp-overlay1">Couldn&apos;t read the changes for {path}.</p>
      ) : diff ? (
        <DiffCard diff={{ type: 'diff', path, oldText: diff.original || undefined, newText: diff.modified || undefined }} />
      ) : (
        <p className="py-1 text-xs text-ctp-overlay1">Loading…</p>
      )}
    </section>
  );
}

/** The raw transcript, for the Transcript toolbar button. */
export function TranscriptInset({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  return (
    <section aria-label="Transcript" data-testid="run-transcript">
      <div className="h-7 flex items-center gap-2 text-xs">
        <span className="font-semibold text-ctp-overlay1">Transcript</span>
        <Button kind="quiet" className="ml-auto" onClick={onClose}>Close</Button>
      </div>
      <div className="h-[420px] border border-surface-0 rounded-lg overflow-hidden bg-ctp-mantle">
        <TranscriptViewer agentId={agentId} />
      </div>
    </section>
  );
}

export function TerminalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M12 15h5" />
    </svg>
  );
}

export function DiffIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v8M8 7h8M8 17h8" /><rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
  );
}
