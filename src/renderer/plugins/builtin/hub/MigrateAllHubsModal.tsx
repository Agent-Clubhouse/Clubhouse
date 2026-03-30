import React, { useEffect, useCallback } from 'react';

export interface MigrateAllHubsModalProps {
  hubCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function MigrateAllHubsModal({ hubCount, onConfirm, onCancel }: MigrateAllHubsModalProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onCancel();
  }, [onCancel]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
      data-testid="migrate-all-hubs-backdrop"
    >
      <div
        className="bg-ctp-mantle border border-surface-0 rounded-xl p-5 w-[440px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="migrate-all-hubs-dialog"
      >
        <h2 className="text-sm font-semibold text-ctp-text mb-3">
          Move All Hubs to Canvas
        </h2>

        <div className="text-[11px] text-ctp-subtext0 space-y-2 mb-4">
          <p>
            This will convert {hubCount === 1 ? 'your hub' : `all ${hubCount} of your hubs`} into
            canvases and disable the Hub plugin. Each hub&rsquo;s pane layout will
            be recreated as agent cards on a canvas.
          </p>
          <div className="bg-surface-0 rounded-lg p-3 space-y-1.5">
            <div className="flex items-start gap-2">
              <span className="text-ctp-accent mt-0.5">&#x2713;</span>
              <span>
                <strong className="text-ctp-text">Your hubs are preserved</strong> &mdash;
                originals are kept; only the Hub plugin is disabled.
              </span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-ctp-info mt-0.5">&#x2192;</span>
              <span>
                <strong className="text-ctp-text">Re-enable anytime</strong> &mdash;
                you can turn Hub back on in Settings &gt; Plugins.
              </span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-ctp-warning mt-0.5">&#x26A0;</span>
              <span>
                <strong className="text-ctp-text">Point-in-time conversion</strong> &mdash;
                future hub changes won&rsquo;t sync to the new canvases.
              </span>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-[11px] rounded-md text-ctp-subtext0 hover:bg-surface-1 transition-colors"
            data-testid="migrate-all-cancel"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-[11px] rounded-md bg-ctp-accent/10 text-ctp-accent hover:bg-ctp-accent/20 transition-colors"
            data-testid="migrate-all-confirm"
          >
            Move All to Canvas
          </button>
        </div>
      </div>
    </div>
  );
}
