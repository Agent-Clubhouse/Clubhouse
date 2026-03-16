import React, { useCallback, useState, useRef, useEffect } from 'react';
import type { CanvasInstance } from './canvas-types';

interface CanvasTabBarProps {
  canvases: CanvasInstance[];
  activeCanvasId: string;
  onSelectCanvas: (canvasId: string) => void;
  onAddCanvas: () => void;
  onRemoveCanvas: (canvasId: string) => void;
  onRenameCanvas: (canvasId: string, name: string) => void;
}

export function CanvasTabBar({
  canvases,
  activeCanvasId,
  onSelectCanvas,
  onAddCanvas,
  onRemoveCanvas,
  onRenameCanvas,
}: CanvasTabBarProps) {
  return (
    <div
      className="flex items-center gap-0.5 px-1.5 py-1 bg-ctp-mantle border-b border-surface-0 min-h-[32px] overflow-x-auto flex-shrink-0"
      data-testid="canvas-tab-bar"
    >
      {canvases.map((canvas) => (
        <CanvasTab
          key={canvas.id}
          canvas={canvas}
          active={canvas.id === activeCanvasId}
          canClose={canvases.length > 1}
          onSelect={() => onSelectCanvas(canvas.id)}
          onRemove={() => onRemoveCanvas(canvas.id)}
          onRename={(name) => onRenameCanvas(canvas.id, name)}
        />
      ))}
      <button
        onClick={onAddCanvas}
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text transition-colors text-sm"
        title="New canvas"
        data-testid="canvas-add-button"
      >
        +
      </button>
    </div>
  );
}

// ── Individual tab ─────────────────────────────────────────────────────

interface CanvasTabProps {
  canvas: CanvasInstance;
  active: boolean;
  canClose: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onRename: (name: string) => void;
}

function CanvasTab({ canvas, active, canClose, onSelect, onRemove, onRename }: CanvasTabProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(canvas.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(canvas.name);
    setEditing(true);
  }, [canvas.name]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== canvas.name) {
      onRename(trimmed);
    }
    setEditing(false);
  }, [editValue, canvas.name, onRename]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitRename();
    else if (e.key === 'Escape') setEditing(false);
  }, [commitRename]);

  const [hovered, setHovered] = useState(false);

  return (
    <div
      className={`
        group relative flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] cursor-pointer select-none
        transition-colors duration-100 flex-shrink-0 max-w-[200px]
        ${active
          ? 'bg-surface-1 text-ctp-text shadow-sm'
          : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text'
        }
      `}
      onClick={onSelect}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-testid={`canvas-tab-${canvas.id}`}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={handleKeyDown}
          onClick={(e) => e.stopPropagation()}
          className="bg-transparent border-none outline-none text-[11px] text-ctp-text w-full min-w-[40px] px-0"
          data-testid="canvas-tab-rename-input"
        />
      ) : (
        <span className="truncate">{canvas.name}</span>
      )}

      {!editing && (active || hovered) && canClose && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="w-4 h-4 flex items-center justify-center rounded text-[9px] text-ctp-overlay0 hover:bg-red-500/20 hover:text-red-400 ml-0.5 flex-shrink-0"
          title="Close canvas"
          data-testid="canvas-tab-close"
        >
          &times;
        </button>
      )}
    </div>
  );
}
