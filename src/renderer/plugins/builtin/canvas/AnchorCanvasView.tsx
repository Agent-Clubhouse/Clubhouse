import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { AnchorCanvasView as AnchorCanvasViewType, CanvasView } from './canvas-types';

interface AnchorCanvasViewProps {
  view: AnchorCanvasViewType;
  onUpdate: (updates: Partial<CanvasView>) => void;
}

export function AnchorCanvasView({ view, onUpdate }: AnchorCanvasViewProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(view.label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const handleCommit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== view.label) {
      onUpdate({ label: trimmed, displayName: trimmed, title: trimmed } as Partial<AnchorCanvasViewType>);
    } else {
      setEditValue(view.label);
    }
    setIsEditing(false);
  }, [editValue, view.label, onUpdate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCommit();
    } else if (e.key === 'Escape') {
      setEditValue(view.label);
      setIsEditing(false);
    }
  }, [handleCommit, view.label]);

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

      {/* Editable label */}
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleCommit}
          onKeyDown={handleKeyDown}
          className="text-center text-sm font-medium text-ctp-text bg-surface-0 border border-ctp-blue/40 rounded px-2 py-0.5 outline-none w-full max-w-[200px]"
          data-testid="anchor-label-input"
        />
      ) : (
        <button
          className="text-center text-sm font-medium text-ctp-subtext1 hover:text-ctp-text transition-colors cursor-text px-2 py-0.5 rounded hover:bg-surface-0 truncate max-w-full"
          onClick={() => { setEditValue(view.label); setIsEditing(true); }}
          title="Click to rename anchor"
          data-testid="anchor-label-display"
        >
          {view.label}
        </button>
      )}
    </div>
  );
}
