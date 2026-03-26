/**
 * ZoneDeleteDialog — prompts user whether to keep or remove contained widgets
 * when deleting a zone.
 */

import React from 'react';

interface ZoneDeleteDialogProps {
  zoneName: string;
  containedCount: number;
  onConfirm: (removeContents: boolean) => void;
  onCancel: () => void;
}

export function ZoneDeleteDialog({ zoneName, containedCount, onConfirm, onCancel }: ZoneDeleteDialogProps) {
  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-ctp-base border border-surface-2 rounded-lg p-5 max-w-sm shadow-xl">
        <h3 className="text-sm font-semibold text-ctp-text mb-2">
          Delete Zone &ldquo;{zoneName}&rdquo;?
        </h3>
        <p className="text-xs text-ctp-subtext0 mb-4">
          This zone contains {containedCount} widget{containedCount !== 1 ? 's' : ''}.
          Zone wires will be removed.
        </p>
        <div className="flex gap-2 justify-end">
          <button
            className="px-3 py-1.5 text-xs rounded bg-surface-1 text-ctp-text hover:bg-surface-2 transition-colors"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 text-xs rounded bg-surface-1 text-ctp-text hover:bg-surface-2 transition-colors"
            onClick={() => onConfirm(false)}
          >
            Keep Widgets
          </button>
          <button
            className="px-3 py-1.5 text-xs rounded bg-ctp-error/20 text-ctp-error hover:bg-ctp-error/30 transition-colors"
            onClick={() => onConfirm(true)}
          >
            Remove All
          </button>
        </div>
      </div>
    </div>
  );
}
