import React from 'react';

export interface CanvasUpgradeBannerProps {
  onMigrateAll: () => void;
  onDismiss: () => void;
}

export function CanvasUpgradeBanner({ onMigrateAll, onDismiss }: CanvasUpgradeBannerProps) {
  return (
    <div
      className="mx-2 mt-2 rounded-lg border border-ctp-accent/30 bg-ctp-accent/5 px-4 py-3 flex items-start gap-3"
      data-testid="canvas-upgrade-banner"
    >
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-ctp-accent mb-1">
          Canvas is here
        </p>
        <p className="text-[11px] text-ctp-subtext0 leading-relaxed">
          Canvas is the next-generation Hub with a free-form spatial layout.
          Right-click any hub tab to upgrade it individually, or move everything at once.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0 pt-0.5">
        <button
          onClick={onMigrateAll}
          className="px-3 py-1.5 text-[11px] rounded-md bg-ctp-accent/10 text-ctp-accent hover:bg-ctp-accent/20 transition-colors"
          data-testid="canvas-upgrade-migrate-all"
        >
          Move All Hubs to Canvas
        </button>
        <button
          onClick={onDismiss}
          className="p-1 text-ctp-subtext0 hover:text-ctp-text transition-colors rounded"
          title="Dismiss"
          data-testid="canvas-upgrade-dismiss"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
