import React, { useCallback, useState, useRef, useEffect } from 'react';
import type { CanvasInstance } from './canvas-types';
import { PopupMenu, type MenuItem } from '../../../chrome/sidebar/ProjectMenu';
import { PopOutIcon } from '../../../features/agents/useAgentRowActions';

interface CanvasTabBarProps {
  canvases: CanvasInstance[];
  activeCanvasId: string;
  onSelectCanvas: (canvasId: string) => void;
  onAddCanvas: () => void;
  onAddFromBlueprint?: () => void;
  onRemoveCanvas: (canvasId: string) => void;
  onRenameCanvas: (canvasId: string, name: string) => void;
  onPopOutCanvas?: (canvasId: string, canvasName: string) => void;
  onExportBlueprint?: (canvasId: string) => void;
}

const PlusIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

/**
 * The canvas strip (#2020): a 34px row of canvases styled like the title-bar
 * tabs, a labeled New canvas button, and pop out on the right.
 */
export function CanvasTabBar({
  canvases,
  activeCanvasId,
  onSelectCanvas,
  onAddCanvas,
  onAddFromBlueprint,
  onRemoveCanvas,
  onRenameCanvas,
  onPopOutCanvas,
  onExportBlueprint,
}: CanvasTabBarProps) {
  const [addMenuAt, setAddMenuAt] = useState<{ x: number; y: number } | null>(null);
  const activeCanvas = canvases.find((c) => c.id === activeCanvasId);

  const addItems: MenuItem[] = [
    { id: 'new', label: 'New canvas', onSelect: onAddCanvas },
    { id: 'from-blueprint', label: 'From blueprint', onSelect: () => onAddFromBlueprint?.() },
  ];

  return (
    <div
      className="flex items-center gap-0.5 h-[34px] px-1.5 bg-ctp-base border-b border-surface-0 flex-shrink-0"
      data-testid="canvas-tab-bar"
    >
      {/* Tabs scroll on their own so the buttons on the right stay pinned. */}
      <div role="tablist" aria-label="Canvases" className="flex items-center gap-0.5 overflow-x-auto min-w-0">
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
            onExportBlueprint={onExportBlueprint ? () => onExportBlueprint(canvas.id) : undefined}
          />
        ))}
      </div>
      <button
        type="button"
        // Keep the menu's outside-click handler from closing it before this click toggles it.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          if (!onAddFromBlueprint) { onAddCanvas(); return; }
          if (addMenuAt) { setAddMenuAt(null); return; }
          const rect = e.currentTarget.getBoundingClientRect();
          setAddMenuAt({ x: rect.left, y: rect.bottom + 4 });
        }}
        aria-haspopup={onAddFromBlueprint ? 'menu' : undefined}
        aria-expanded={onAddFromBlueprint ? !!addMenuAt : undefined}
        className="ml-1.5 flex-shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-surface-1 text-xs font-medium text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text transition-colors cursor-pointer"
        data-testid="canvas-add-button"
      >
        {PlusIcon}
        New canvas
      </button>
      {addMenuAt && (
        <PopupMenu items={addItems} position={addMenuAt} label="New canvas" testId="canvas-add" onClose={() => setAddMenuAt(null)} />
      )}
      <span className="flex-1" />
      {onPopOutCanvas && activeCanvas && (
        <button
          type="button"
          onClick={() => onPopOutCanvas(activeCanvas.id, activeCanvas.name)}
          className="flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text transition-colors cursor-pointer"
          title="Pop out canvas"
          aria-label="Pop out canvas"
          data-testid="canvas-tab-popout"
        >
          <PopOutIcon />
        </button>
      )}
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
  onExportBlueprint?: () => void;
}

function CanvasTab({ canvas, active, canClose, onSelect, onRemove, onRename, onPopOut, onExportBlueprint }: CanvasTabProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(canvas.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startRename = useCallback(() => {
    setEditValue(canvas.name);
    setEditing(true);
  }, [canvas.name]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    startRename();
  }, [startRename]);

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

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const menuItems: MenuItem[] = [
    { id: 'rename', label: 'Rename', onSelect: startRename },
    ...(onPopOut ? [{ id: 'popout', label: 'Pop out', onSelect: onPopOut }] : []),
    ...(onExportBlueprint ? [{ id: 'export-blueprint', label: 'Export as blueprint', onSelect: onExportBlueprint }] : []),
    ...(canClose ? [{ id: 'close', label: 'Close canvas', onSelect: onRemove }] : []),
  ];

  return (
    <>
      <div
        role="tab"
        aria-selected={active}
        className={`group relative flex-shrink-0 max-w-[200px] h-7 px-2.5 rounded-md flex items-center gap-1.5 text-xs cursor-pointer select-none transition-colors duration-100 ${
          active ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text'
        }`}
        onClick={onSelect}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
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
            className="bg-transparent outline-none text-xs text-ctp-text w-full min-w-[40px]"
            data-testid="canvas-tab-rename-input"
          />
        ) : (
          <span className="truncate">{canvas.name}</span>
        )}

        {!editing && canClose && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className={`w-4 h-4 -mr-1 flex-shrink-0 flex items-center justify-center rounded text-ctp-overlay1 hover:bg-surface-1 hover:text-ctp-text ${
              active ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
            }`}
            title="Close canvas"
            aria-label={`Close ${canvas.name}`}
            data-testid="canvas-tab-close"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {contextMenu && (
        <PopupMenu
          items={menuItems}
          position={contextMenu}
          label={canvas.name}
          testId="canvas-tab-menu"
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}
