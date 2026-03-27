import React from 'react';

interface AnnexUnsupportedPlaceholderProps {
  /** Human-readable widget type name (e.g. "Browser", "Custom Widget"). */
  widgetType: string;
  /** Optional extra context about why the widget can't be rendered. */
  reason?: string;
}

/**
 * Placeholder shown inside canvas widget frames for widget types that
 * cannot be rendered over an annex connection (e.g. browser webviews).
 *
 * This is a generic component — new widget types that can't be streamed
 * should use this rather than building bespoke placeholders.
 */
export function AnnexUnsupportedPlaceholder({ widgetType, reason }: AnnexUnsupportedPlaceholderProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-4 text-center">
      <div className="w-10 h-10 rounded-lg bg-surface-1 flex items-center justify-center">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-ctp-overlay1">
          <circle cx="12" cy="12" r="10" />
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
        </svg>
      </div>
      <div className="space-y-1">
        <div className="text-xs font-medium text-ctp-subtext1">
          {widgetType} unavailable over Annex
        </div>
        <div className="text-[10px] text-ctp-overlay0 max-w-[200px]">
          {reason || 'This widget type cannot be viewed over a remote connection.'}
        </div>
      </div>
    </div>
  );
}
