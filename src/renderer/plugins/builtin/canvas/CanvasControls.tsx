import React from 'react';

interface CanvasControlsProps {
  zoom: number;
  hasViews?: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onCenter: () => void;
  onSizeToFit: () => void;
}

export function CanvasControls({ zoom, hasViews, onZoomIn, onZoomOut, onZoomReset, onCenter, onSizeToFit }: CanvasControlsProps) {
  const zoomPercent = Math.round(zoom * 100);

  const btnClass = 'w-6 h-6 flex items-center justify-center rounded text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text transition-colors';

  return (
    <div
      className="absolute top-3 right-3 flex items-center gap-1 bg-ctp-mantle/90 backdrop-blur-sm rounded-lg border border-surface-0 px-1.5 py-1 shadow-sm"
      data-testid="canvas-controls"
    >
      {/* Center viewport */}
      <button
        onClick={onCenter}
        className={btnClass}
        title="Center viewport"
        data-testid="canvas-center"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="3" />
          <line x1="12" y1="2" x2="12" y2="6" />
          <line x1="12" y1="18" x2="12" y2="22" />
          <line x1="2" y1="12" x2="6" y2="12" />
          <line x1="18" y1="12" x2="22" y2="12" />
        </svg>
      </button>

      {/* Size to fit */}
      {hasViews && (
        <button
          onClick={onSizeToFit}
          className={btnClass}
          title="Size to fit all views"
          data-testid="canvas-size-to-fit"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <rect x="7" y="7" width="10" height="10" rx="1" />
          </svg>
        </button>
      )}

      {/* Divider */}
      <div className="w-px h-4 bg-surface-0 mx-0.5" />

      {/* Zoom controls */}
      <button
        onClick={onZoomOut}
        className={btnClass}
        title="Zoom out"
        data-testid="canvas-zoom-out"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <button
        onClick={onZoomReset}
        className="min-w-[3rem] h-6 flex items-center justify-center rounded text-[10px] text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text transition-colors font-mono"
        title="Reset zoom"
        data-testid="canvas-zoom-reset"
      >
        {zoomPercent}%
      </button>
      <button
        onClick={onZoomIn}
        className={btnClass}
        title="Zoom in"
        data-testid="canvas-zoom-in"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  );
}
