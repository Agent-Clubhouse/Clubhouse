import React, { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import type { CanvasView, AgentCanvasView as AgentCanvasViewType, Position, Size } from './canvas-types';
import { MIN_VIEW_WIDTH, MIN_VIEW_HEIGHT } from './canvas-types';
import { AgentCanvasView } from './AgentCanvasView';
import { FileCanvasView } from './FileCanvasView';
import { BrowserCanvasView } from './BrowserCanvasView';
import { GitDiffCanvasView } from './GitDiffCanvasView';
import type { PluginAPI, PluginAgentDetailedStatus } from '../../../../shared/plugin-types';

interface CanvasViewComponentProps {
  view: CanvasView;
  api: PluginAPI;
  zoom: number;
  isZoomed?: boolean;
  onClose: () => void;
  onFocus: () => void;
  onCenterView: () => void;
  onZoomView: () => void;
  onDragEnd: (position: Position) => void;
  onResizeEnd: (size: Size) => void;
  onUpdate: (updates: Partial<CanvasView>) => void;
}

export function CanvasViewComponent({
  view,
  api,
  zoom,
  isZoomed,
  onClose,
  onFocus,
  onCenterView,
  onZoomView,
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

  // ── Permission state (agent views only) ─────────────────────────

  const [agentTick, setAgentTick] = useState(0);
  useEffect(() => {
    if (view.type !== 'agent') return;
    const sub = api.agents.onAnyChange(() => setAgentTick((n) => n + 1));
    return () => sub.dispose();
  }, [api, view.type]);

  const detailedStatus: PluginAgentDetailedStatus | null = useMemo(() => {
    if (view.type !== 'agent') return null;
    const agentId = (view as AgentCanvasViewType).agentId;
    if (!agentId) return null;
    return api.agents.getDetailedStatus(agentId);
  }, [api, view, agentTick]);

  const isPermission = detailedStatus?.state === 'needs_permission';
  const isToolError = detailedStatus?.state === 'tool_error';

  // Agent info for identity chip
  const agentInfo = useMemo(() => {
    if (view.type !== 'agent') return null;
    const agentId = (view as AgentCanvasViewType).agentId;
    if (!agentId) return null;
    return api.agents.list().find((a) => a.id === agentId) ?? null;
  }, [api, view, agentTick]);

  // ── Border styles (matching hub pane) ───────────────────────────

  const borderColor = isPermission
    ? 'rgb(249,115,22)'
    : isToolError
      ? 'rgb(234,179,8)'
      : 'transparent';
  const borderWidth = (isPermission || isToolError) ? 2 : 0;

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
      case 'git-diff':
        return <GitDiffCanvasView view={view} api={api} onUpdate={onUpdate} />;
    }
  };

  const { AgentAvatar } = api.widgets;

  return (
    <div
      className={`absolute flex flex-col bg-ctp-base border border-surface-2 rounded-lg overflow-hidden ${isPermission ? 'animate-pulse' : ''}`}
      style={{
        left: currentPos.x,
        top: currentPos.y,
        width: currentSize.width,
        height: currentSize.height,
        zIndex: view.zIndex,
        boxShadow: borderWidth > 0
          ? `inset 0 0 0 ${borderWidth}px ${borderColor}, 0 4px 24px rgba(0, 0, 0, 0.5)`
          : '0 4px 24px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(88, 91, 112, 0.15)',
      }}
      onMouseDown={(e) => { e.stopPropagation(); onFocus(); }}
      data-testid={`canvas-view-${view.id}`}
      data-permission={isPermission ? 'true' : undefined}
      data-tool-error={isToolError ? 'true' : undefined}
    >
      {/* Title bar — drag handle */}
      <div
        className="flex items-center gap-1.5 px-2.5 py-1.5 bg-ctp-mantle border-b border-surface-0 cursor-grab active:cursor-grabbing flex-shrink-0"
        onMouseDown={handleDragStart}
        data-testid="canvas-view-titlebar"
      >
        {/* Agent identity chip */}
        {agentInfo && <AgentAvatar agentId={agentInfo.id} size="sm" showStatusRing />}

        <span className="text-[10px] text-ctp-overlay0 font-mono uppercase tracking-wider">
          {view.type}
        </span>
        <span className="text-xs text-ctp-subtext0 truncate flex-1">{view.title}</span>

        {/* Quick action buttons */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            className="w-5 h-5 flex items-center justify-center rounded text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text transition-colors"
            onClick={(e) => { e.stopPropagation(); onCenterView(); }}
            title="Center on this view"
            data-testid="canvas-view-center"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="3" />
              <line x1="12" y1="2" x2="12" y2="6" />
              <line x1="12" y1="18" x2="12" y2="22" />
              <line x1="2" y1="12" x2="6" y2="12" />
              <line x1="18" y1="12" x2="22" y2="12" />
            </svg>
          </button>
          <button
            className={`w-5 h-5 flex items-center justify-center rounded transition-colors ${
              isZoomed
                ? 'text-ctp-blue bg-surface-1'
                : 'text-ctp-overlay0 hover:bg-surface-1 hover:text-ctp-text'
            }`}
            onClick={(e) => { e.stopPropagation(); onZoomView(); }}
            title={isZoomed ? 'Restore view' : 'Zoom view'}
            data-testid="canvas-view-zoom"
          >
            {isZoomed ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            )}
          </button>
          <button
            className="w-5 h-5 flex items-center justify-center rounded text-ctp-overlay0 hover:bg-red-500/20 hover:text-red-400 transition-colors"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            title="Close view"
            data-testid="canvas-view-close"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
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
