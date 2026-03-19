import React, { useState, useCallback, useRef, useEffect } from 'react';

interface InlineRenameProps {
  value: string;
  onCommit: (newName: string) => void;
}

export function InlineRename({ value, onCommit }: InlineRenameProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  // Sync edit value when external value changes while not editing
  useEffect(() => {
    if (!isEditing) {
      setEditValue(value);
    }
  }, [value, isEditing]);

  const handleCommit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== value) {
      onCommit(trimmed);
    } else {
      setEditValue(value);
    }
    setIsEditing(false);
  }, [editValue, value, onCommit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCommit();
    } else if (e.key === 'Escape') {
      setEditValue(value);
      setIsEditing(false);
    }
  }, [handleCommit, value]);

  const startEditing = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setEditValue(value);
    setIsEditing(true);
  }, [value]);

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleCommit}
        onKeyDown={handleKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
        className="text-xs text-ctp-text bg-surface-0 border border-ctp-blue/40 rounded px-1 py-0 outline-none flex-1 min-w-0"
        data-testid="inline-rename-input"
      />
    );
  }

  return (
    <div className="flex items-center gap-0.5 truncate flex-1 min-w-0">
      <span className="text-xs text-ctp-subtext0 truncate" data-testid="inline-rename-display">{value}</span>
      <button
        className="w-4 h-4 flex items-center justify-center rounded text-ctp-overlay0 hover:text-ctp-text opacity-0 group-hover/titlebar:opacity-100 transition-opacity flex-shrink-0"
        onClick={startEditing}
        onMouseDown={(e) => e.stopPropagation()}
        title="Rename"
        data-testid="inline-rename-button"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
        </svg>
      </button>
    </div>
  );
}
