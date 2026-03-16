import React, { useCallback, useRef, useState, useEffect } from 'react';
import type { CanvasView, Position, Size } from './canvas-types';
import { MIN_VIEW_WIDTH, MIN_VIEW_HEIGHT } from './canvas-types';
import { AgentCanvasView } from './AgentCanvasView';
import { FileCanvasView } from './FileCanvasView';
import { BrowserCanvasView } from './BrowserCanvasView';
import type { PluginAPI } from '../../../../shared/plugin-types';

interface CanvasViewComponentProps {
  view: CanvasView;
  api: PluginAPI;
  zoom: number;
  onClose: () => void;
  onFocus: () => void;
  onDragEnd: (position: Position) => void;
  onResizeEnd: (size: Size) => void;
  onUpdate: (updates: Partial<CanvasView>) => void;
}

export function CanvasViewComponent({
  view,
  api,
  zoom,
  onClose,
  onFocus,
  onDragEnd,
  onResizeEnd,
  onUpdate,
}: CanvasViewComponentProps) {
  const [dragPos, setDragPos] = useState<Position | null>(null);
  const [resizeSize, setResizeSize] = useState<Size | null>(null);
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, startX: 0, startY: 0 });
  const resizeStartRef = useRef({ mouseX: 0, mouseY: 0, startW: 0, startH: 0 });

  const currentPos = dragPos ?? view.position;
  const currentSize = resizeSize ?? view.size;

  // ── Drag ───────────────────────────────────────────────────────

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus();
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startX: view.position.x,
      startY: view.position.y,
    };
    setDragPos(view.position);
  }, [view.position, onFocus]);

  useEffect(() => {
    if (dragPos === null) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = (e.clientX - dragStartRef.current.mouseX) / zoom;
      const dy = (e.clientY - dragStartRef.current.mouseY) / zoom;
      setDragPos({
        x: dragStartRef.current.startX + dx,
        y: dragStartRef.current.startY + dy,
      });
    };

    const handleMouseUp = () => {
      if (dragPos) {
        onDragEnd(dragPos);
      }
      setDragPos(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragPos, zoom, onDragEnd]);

  // ── Resize ─────────────────────────────────────────────────────

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onFocus();
    resizeStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startW: view.size.width,
      startH: view.size.height,
    };
    setResizeSize(view.size);
  }, [view.size, onFocus]);

  useEffect(() => {
    if (resizeSize === null) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = (e.clientX - resizeStartRef.current.mouseX) / zoom;
      const dy = (e.clientY - resizeStartRef.current.mouseY) / zoom;
      setResizeSize({
        width: Math.max(MIN_VIEW_WIDTH, resizeStartRef.current.startW + dx),
        height: Math.max(MIN_VIEW_HEIGHT, resizeStartRef.current.startH + dy),
      });
    };

    const handleMouseUp = () => {
      if (resizeSize) {
        onResizeEnd(resizeSize);
      }
      setResizeSize(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizeSize, zoom, onResizeEnd]);

  // ── Content based on view type ─────────────────────────────────

  const renderContent = () => {
    switch (view.type) {
      case 'agent':
        return <AgentCanvasView view={view} api={api} onUpdate={onUpdate} />;
      case 'file':
        return <FileCanvasView view={view} api={api} onUpdate={onUpdate} />;
      case 'browser':
        return <BrowserCanvasView view={view} onUpdate={onUpdate} />;
    }
  };

  return (
    <div
      className="absolute flex flex-col bg-ctp-base border border-surface-1 rounded-lg shadow-lg overflow-hidden"
      style={{
        left: currentPos.x,
        top: currentPos.y,
        width: currentSize.width,
        height: currentSize.height,
        zIndex: view.zIndex,
      }}
      onMouseDown={(e) => { e.stopPropagation(); onFocus(); }}
      data-testid={`canvas-view-${view.id}`}
    >
      {/* Title bar — drag handle */}
      <div
        className="flex items-center gap-1.5 px-2 py-1 bg-ctp-mantle border-b border-surface-0 cursor-grab active:cursor-grabbing flex-shrink-0"
        onMouseDown={handleDragStart}
        data-testid="canvas-view-titlebar"
      >
        <span className="text-[10px] text-ctp-overlay0 font-mono uppercase tracking-wider">
          {view.type}
        </span>
        <span className="text-[11px] text-ctp-subtext0 truncate flex-1">{view.title}</span>
        <button
          className="w-4 h-4 flex items-center justify-center rounded text-ctp-overlay0 hover:bg-red-500/20 hover:text-red-400 transition-colors text-[10px]"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          title="Close view"
          data-testid="canvas-view-close"
        >
          &times;
        </button>
      </div>

      {/* Content area — stop wheel events from propagating to canvas pan/zoom */}
      <div className="flex-1 min-h-0 overflow-auto" onWheel={(e) => e.stopPropagation()}>
        {renderContent()}
      </div>

      {/* Resize handle (bottom-right corner) */}
      <div
        className="absolute bottom-0 right-0 w-3 h-3 cursor-se-resize"
        onMouseDown={handleResizeStart}
        data-testid="canvas-view-resize"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" className="text-ctp-overlay0">
          <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1" />
          <line x1="10" y1="6" x2="6" y2="10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
}
