import React from 'react';

interface CanvasControlsProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}

export function CanvasControls({ zoom, onZoomIn, onZoomOut, onZoomReset }: CanvasControlsProps) {
  const zoomPercent = Math.round(zoom * 100);

  return (
    <div
      className="absolute top-3 right-3 flex items-center gap-1 bg-ctp-mantle/90 backdrop-blur-sm rounded-lg border border-surface-0 px-1.5 py-1 shadow-sm"
      data-testid="canvas-controls"
    >
      <button
        onClick={onZoomOut}
        className="w-6 h-6 flex items-center justify-center rounded text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text transition-colors text-xs"
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
        className="w-6 h-6 flex items-center justify-center rounded text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text transition-colors text-xs"
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
