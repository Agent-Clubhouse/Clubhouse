import React, { useEffect, useCallback } from 'react';

export interface UpgradeToCanvasDialogProps {
  hubName: string;
  onUpgrade: () => void;
  onUpgradeAndDelete: () => void;
  onClose: () => void;
}

export function UpgradeToCanvasDialog({
  hubName,
  onUpgrade,
  onUpgradeAndDelete,
  onClose,
}: UpgradeToCanvasDialogProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      data-testid="upgrade-to-canvas-backdrop"
    >
      <div
        className="bg-ctp-mantle border border-surface-0 rounded-xl p-5 w-[420px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="upgrade-to-canvas-dialog"
      >
        <h2 className="text-sm font-semibold text-ctp-text mb-3">
          Upgrade &ldquo;{hubName}&rdquo; to Canvas
        </h2>

        <div className="text-[11px] text-ctp-subtext0 space-y-2 mb-4">
          <p>
            This will create a new canvas with the same agent layout as this hub.
            Each pane becomes an agent card positioned at its approximate location.
          </p>
          <div className="bg-surface-0 rounded-lg p-3 space-y-1.5">
            <div className="flex items-start gap-2">
              <span className="text-ctp-warning mt-0.5">&#x26A0;</span>
              <span><strong className="text-ctp-text">Point-in-time conversion</strong> &mdash; future hub changes won&rsquo;t sync to the canvas.</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-ctp-info mt-0.5">&#x2192;</span>
              <span><strong className="text-ctp-text">One-way</strong> &mdash; canvases cannot be converted back to hubs.</span>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-[11px] rounded-md text-ctp-subtext0 hover:bg-surface-1 transition-colors"
            data-testid="upgrade-cancel"
          >
            Cancel
          </button>
          <button
            onClick={onUpgradeAndDelete}
            className="px-3 py-1.5 text-[11px] rounded-md bg-ctp-warning/10 text-ctp-warning hover:bg-ctp-warning/20 transition-colors"
            data-testid="upgrade-and-delete"
          >
            Upgrade &amp; Delete Hub
          </button>
          <button
            onClick={onUpgrade}
            className="px-3 py-1.5 text-[11px] rounded-md bg-ctp-accent/10 text-ctp-accent hover:bg-ctp-accent/20 transition-colors"
            data-testid="upgrade-keep"
          >
            Upgrade
          </button>
        </div>
      </div>
    </div>
  );
}
