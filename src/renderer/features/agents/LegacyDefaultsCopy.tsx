import { useEffect, useState } from 'react';
import type { LegacyCopyPreview } from '../../../shared/legacy-defaults-types';

/**
 * Whether the project still has legacy agent defaults to offer a new plain
 * agent (#3245). Null while it's read, and false when it can't be.
 */
export function useHasLegacyDefaults(projectPath: string | undefined): boolean | null {
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    if (!projectPath) { setHas(false); return; }
    let live = true;
    setHas(null);
    Promise.resolve().then(() => window.clubhouse.legacyDefaults.describe(projectPath))
      .then((d) => { if (live) setHas(d?.hasValues === true); })
      .catch(() => { if (live) setHas(false); });
    return () => { live = false; };
  }, [projectPath]);
  return has;
}

/**
 * What the copy would put in a new agent's folder, as a plain list. Read again
 * when the name or CLI changes, since the files and wildcards follow them.
 */
export function LegacyCopyPreviewList({ projectPath, name, orchestrator }: { projectPath: string; name: string; orchestrator?: string }) {
  const [preview, setPreview] = useState<LegacyCopyPreview | null>(null);
  const [failed, setFailed] = useState(false);
  const agentName = name.trim() || 'new-agent';
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      Promise.resolve().then(() => window.clubhouse.legacyDefaults.previewCopyNew(projectPath, agentName, orchestrator))
        .then((p) => { if (live) { setPreview(p ?? null); setFailed(false); } })
        .catch(() => { if (live) setFailed(true); });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [projectPath, agentName, orchestrator]);
  if (failed) return <p className="text-xs text-ctp-subtext0">Couldn&apos;t work out what would be copied.</p>;
  if (!preview) return null;
  return <CopyChangeList preview={preview} />;
}

/** A copy's changes, one line each: the file or setting, then what happens to it. */
export function CopyChangeList({ preview }: { preview: LegacyCopyPreview }) {
  if (preview.blocked) return <p className="text-xs text-ctp-subtext0">{preview.blocked}</p>;
  if (preview.changes.length === 0) return <p className="text-xs text-ctp-subtext0">Nothing to copy.</p>;
  return (
    <ul className="text-xs text-ctp-subtext0 space-y-0.5" data-testid="legacy-copy-preview">
      {preview.changes.map((c) => (
        <li key={`${c.item}:${c.target}`}>
          <span className="font-mono text-ctp-subtext1">{c.target}</span>: {c.detail}
        </li>
      ))}
    </ul>
  );
}
