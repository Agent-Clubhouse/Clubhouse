import React, { useCallback, useState, useRef, useEffect } from 'react';
import type { CanvasInstance } from './canvas-types';

interface CanvasTabBarProps {
  canvases: CanvasInstance[];
  activeCanvasId: string;
  onSelectCanvas: (canvasId: string) => void;
  onAddCanvas: () => void;
  onRemoveCanvas: (canvasId: string) => void;
  onRenameCanvas: (canvasId: string, name: string) => void;
  onPopOutCanvas?: (canvasId: string, canvasName: string) => void;
}

export function CanvasTabBar({
  canvases,
  activeCanvasId,
  onSelectCanvas,
  onAddCanvas,
  onRemoveCanvas,
  onRenameCanvas,
  onPopOutCanvas,
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
          onPopOut={onPopOutCanvas ? () => onPopOutCanvas(canvas.id, canvas.name) : undefined}
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
  onPopOut?: () => void;
}

function CanvasTab({ canvas, active, canClose, onSelect, onRemove, onRename, onPopOut }: CanvasTabProps) {
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

      {!editing && (active || hovered) && (
        <div className="flex items-center gap-0.5 ml-0.5 flex-shrink-0">
          {onPopOut && (
            <button
              onClick={(e) => { e.stopPropagation(); onPopOut(); }}
              className="w-4 h-4 flex items-center justify-center rounded text-[9px] text-ctp-overlay0 hover:bg-surface-2 hover:text-ctp-text"
              title="Pop out canvas"
              data-testid="canvas-tab-popout"
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 2 14 2 14 7" />
                <line x1="14" y1="2" x2="7" y2="9" />
                <path d="M12 9v5a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1h5" />
              </svg>
            </button>
          )}
          {canClose && (
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
              className="w-4 h-4 flex items-center justify-center rounded text-[9px] text-ctp-overlay0 hover:bg-ctp-error/20 hover:text-ctp-error"
              title="Close canvas"
              data-testid="canvas-tab-close"
            >
              &times;
            </button>
          )}
        </div>
      )}
    </div>
  );
}
