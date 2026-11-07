import { useEffect, useState } from 'react';
import type { ChatFilePreview } from '../../shared/chat';
import { PreviewBody } from '../features/agents/chat/rich/FileChips';
import { useFilePreviewStore } from '../stores/filePreviewStore';
import { Modal } from './Modal';

/** A scratch file needs no project registration, and never gets an editable API. */
export function FilePreviewHost() {
  const target = useFilePreviewStore((s) => s.target);
  const close = useFilePreviewStore((s) => s.close);
  const [loaded, setLoaded] = useState<{ target: typeof target; path?: string; preview?: ChatFilePreview; error?: string } | null>(null);
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    window.clubhouse.file.preview(target.path).then(
      ({ path, preview }) => { if (!cancelled) setLoaded({ target, path, preview }); },
      // telemetry-exempt: the error is shown locally, never exported.
      (err: unknown) => { if (!cancelled) setLoaded({ target, error: err instanceof Error ? err.message : 'This file is not available.' }); },
    );
    return () => { cancelled = true; };
  }, [target]);
  const current = loaded?.target === target ? loaded : null;
  return (
    <Modal open={!!target} onClose={close} title="File preview" width="w-[min(900px,calc(100vw-48px))]" padding="none" testId="local-file-preview">
      {target && <div className="flex flex-col h-[min(640px,calc(100vh-140px))] min-h-0">
        <div className="px-4 py-2 text-xs text-ctp-subtext0 break-all border-b border-surface-0">{current?.path ?? target.path} <span className="text-ctp-overlay1">(Read-only)</span></div>
        {current?.error ? <div role="alert" className="p-4 text-xs text-ctp-error">{current.error}</div>
          : current?.preview ? <PreviewBody preview={current.preview} target={target} showOpenHint={false} />
            : <div className="p-4 text-xs text-ctp-subtext0">Loading…</div>}
      </div>}
    </Modal>
  );
}
