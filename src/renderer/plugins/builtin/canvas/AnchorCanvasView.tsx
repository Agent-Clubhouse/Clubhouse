import React from 'react';
import type { AnchorCanvasView as AnchorCanvasViewType, CanvasView } from './canvas-types';

interface AnchorCanvasViewProps {
  view: AnchorCanvasViewType;
  onUpdate: (updates: Partial<CanvasView>) => void;
}

export function AnchorCanvasView({ view }: AnchorCanvasViewProps) {
  return (
    <div
      className="flex flex-col items-center justify-center h-full gap-2 px-4 select-none"
      data-testid="anchor-canvas-view"
    >
      {/* Anchor icon */}
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-ctp-blue opacity-60 flex-shrink-0"
      >
        <circle cx="12" cy="5" r="3" />
        <line x1="12" y1="8" x2="12" y2="22" />
        <path d="M5 12H2a10 10 0 0 0 20 0h-3" />
      </svg>

      {/* Label (rename via title bar edit button) */}
      <span
        className="text-center text-sm font-medium text-ctp-subtext1 px-2 py-0.5 truncate max-w-full"
        data-testid="anchor-label-display"
      >
        {view.label}
      </span>
    </div>
  );
}
