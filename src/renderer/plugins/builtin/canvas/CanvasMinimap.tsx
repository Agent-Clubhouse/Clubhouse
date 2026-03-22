import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CanvasView, CanvasViewAttention, Viewport, Size } from './canvas-types';
import {
  computeMinimapBounds,
  canvasToMinimap,
  viewportToCanvasRect,
  minimapToCanvas,
  centerViewportOn,
  MINIMAP_WIDTH,
  MINIMAP_HEIGHT,
  MINIMAP_AUTO_HIDE_DELAY,
} from './canvas-minimap';
import type { PluginCanvasView } from './canvas-types';

// ── Types ────────────────────────────────────────────────────────────

interface CanvasMinimapProps {
  views: CanvasView[];
  viewport: Viewport;
  containerSize: Size;
  selectedViewId: string | null;
  selectedViewIds: string[];
  attentionMap: Map<string, CanvasViewAttention>;
  onViewportChange: (viewport: Viewport) => void;
}

// ── Tiny SVG icons for minimap view type badges ─────────────────────

function AgentIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="4" />
    </svg>
  );
}

function AnchorIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="5" r="3" />
      <line x1="12" y1="8" x2="12" y2="22" />
      <path d="M5 12H2a10 10 0 0 0 20 0h-3" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function BrowserIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
    </svg>
  );
}

function GitIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9a9 9 0 01-9 9" />
      <path d="M6 9v3a3 3 0 003 3h6" />
    </svg>
  );
}

function PluginIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

function viewIcon(view: CanvasView): React.ReactNode {
  if (view.type === 'anchor') return <AnchorIcon />;
  if (view.type === 'agent') return <AgentIcon />;
  if (view.type === 'plugin') {
    const pv = view as PluginCanvasView;
    const wt = pv.pluginWidgetType;
    if (wt.includes('file')) return <FileIcon />;
    if (wt.includes('terminal') || wt.includes('shell')) return <TerminalIcon />;
    if (wt.includes('browser') || wt.includes('webview')) return <BrowserIcon />;
    if (wt.includes('git')) return <GitIcon />;
    return <PluginIcon />;
  }
  return null;
}

// ── Component ────────────────────────────────────────────────────────

export function CanvasMinimap({
  views,
  viewport,
  containerSize,
  selectedViewId,
  selectedViewIds,
  attentionMap,
  onViewportChange,
}: CanvasMinimapProps) {
  const [pinned, setPinned] = useState(false);
  const [visible, setVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minimapRef = useRef<HTMLDivElement>(null);

  // Reset auto-hide timer on viewport or view changes
  const changeFingerprint = `${viewport.panX},${viewport.panY},${viewport.zoom},${views.length}`;
  useEffect(() => {
    setVisible(true);
    if (pinned) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setVisible(false), MINIMAP_AUTO_HIDE_DELAY);
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [changeFingerprint, pinned]);

  // Show on hover even if auto-hidden
  const handleMouseEnter = useCallback(() => setVisible(true), []);
  const handleMouseLeave = useCallback(() => {
    if (pinned) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setVisible(false), MINIMAP_AUTO_HIDE_DELAY);
  }, [pinned]);

  const minimapSize: Size = { width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT };
  const worldBounds = useMemo(
    () => computeMinimapBounds(views, viewport, containerSize),
    [views, viewport, containerSize],
  );

  // Viewport rect on the minimap
  const vpCanvasRect = viewportToCanvasRect(viewport, containerSize);
  const vpMiniRect = canvasToMinimap(vpCanvasRect, worldBounds, minimapSize);

  // Click-to-navigate: recenter viewport where the user clicks
  const handleMinimapClick = useCallback((e: React.MouseEvent) => {
    const el = minimapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const canvasPos = minimapToCanvas(mx, my, worldBounds, minimapSize);
    const newPan = centerViewportOn(canvasPos, containerSize, viewport.zoom);
    onViewportChange({ ...viewport, ...newPan });
  }, [worldBounds, minimapSize, containerSize, viewport, onViewportChange]);

  // Drag to pan viewport indicator
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ mx: number; my: number; panX: number; panY: number } | null>(null);

  const handleVpMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setDragging(true);
    dragStartRef.current = {
      mx: e.clientX,
      my: e.clientY,
      panX: viewport.panX,
      panY: viewport.panY,
    };
  }, [viewport.panX, viewport.panY]);

  useEffect(() => {
    if (!dragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const el = minimapRef.current;
      if (!el) return;

      // Convert pixel delta on minimap to canvas-space delta
      const scaleX = minimapSize.width / worldBounds.width;
      const scaleY = minimapSize.height / worldBounds.height;
      const scale = Math.min(scaleX, scaleY);

      const dxMinimap = e.clientX - start.mx;
      const dyMinimap = e.clientY - start.my;
      const dxCanvas = dxMinimap / scale;
      const dyCanvas = dyMinimap / scale;

      // Dragging the viewport box right means the viewport moves right in
      // canvas-space, which means panX decreases.
      onViewportChange({
        panX: start.panX - dxCanvas,
        panY: start.panY - dyCanvas,
        zoom: viewport.zoom,
      });
    };
    const handleMouseUp = () => setDragging(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, worldBounds, minimapSize, viewport.zoom, onViewportChange]);

  // Don't show minimap if no views and container is empty
  if (views.length === 0 && containerSize.width === 0) return null;

  return (
    <div
      ref={minimapRef}
      className="absolute right-3 bottom-3 rounded-lg border border-surface-0 bg-ctp-mantle/90 backdrop-blur-sm shadow-lg overflow-hidden select-none"
      style={{
        width: MINIMAP_WIDTH,
        height: MINIMAP_HEIGHT,
        zIndex: 9990,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        transition: 'opacity 200ms ease',
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleMinimapClick}
      data-testid="canvas-minimap"
    >
      {/* View boxes */}
      {views.map((view) => {
        const rect = canvasToMinimap(
          { x: view.position.x, y: view.position.y, width: view.size.width, height: view.size.height },
          worldBounds,
          minimapSize,
        );

        // Determine highlight color
        const isSelected = view.id === selectedViewId || selectedViewIds.includes(view.id);
        const attention = attentionMap.get(view.id);
        let borderColor = 'rgba(88, 91, 112, 0.3)';
        let bgColor = 'rgba(30, 30, 46, 0.6)';
        if (attention?.level === 'warning') {
          borderColor = 'rgba(250, 204, 21, 0.9)';
          bgColor = 'rgba(250, 204, 21, 0.15)';
        } else if (attention?.level === 'error') {
          borderColor = 'rgba(248, 113, 113, 0.9)';
          bgColor = 'rgba(248, 113, 113, 0.15)';
        } else if (isSelected) {
          borderColor = 'rgba(137, 180, 250, 0.9)';
          bgColor = 'rgba(137, 180, 250, 0.15)';
        }

        // Anchors render as small icons instead of boxes
        if (view.type === 'anchor') {
          return (
            <div
              key={view.id}
              className="absolute flex items-center justify-center text-ctp-blue pointer-events-none"
              style={{
                left: rect.x,
                top: rect.y,
                width: Math.max(rect.width, 10),
                height: Math.max(rect.height, 10),
              }}
              data-testid={`minimap-view-${view.id}`}
            >
              <AnchorIcon />
            </div>
          );
        }

        // Minimum visible size for tiny views
        const minW = 6;
        const minH = 4;

        return (
          <div
            key={view.id}
            className="absolute flex items-center justify-center pointer-events-none"
            style={{
              left: rect.x,
              top: rect.y,
              width: Math.max(rect.width, minW),
              height: Math.max(rect.height, minH),
              border: `1px solid ${borderColor}`,
              backgroundColor: bgColor,
              borderRadius: 2,
            }}
            data-testid={`minimap-view-${view.id}`}
          >
            {/* Show icon only if the box is large enough */}
            {rect.width >= 12 && rect.height >= 12 && (
              <span className="text-ctp-overlay1 opacity-70">
                {viewIcon(view)}
              </span>
            )}
          </div>
        );
      })}

      {/* Viewport indicator */}
      <div
        className="absolute border border-ctp-text/40 bg-ctp-text/5 cursor-grab active:cursor-grabbing"
        style={{
          left: vpMiniRect.x,
          top: vpMiniRect.y,
          width: Math.max(vpMiniRect.width, 4),
          height: Math.max(vpMiniRect.height, 4),
          borderRadius: 2,
          pointerEvents: 'auto',
        }}
        onMouseDown={handleVpMouseDown}
        data-testid="minimap-viewport"
      />

      {/* Pin checkbox */}
      <label
        className="absolute bottom-1 left-1.5 flex items-center gap-1 cursor-pointer"
        style={{ pointerEvents: 'auto' }}
        onClick={(e) => e.stopPropagation()}
        data-testid="minimap-pin-label"
      >
        <input
          type="checkbox"
          checked={pinned}
          onChange={(e) => {
            setPinned(e.target.checked);
            if (e.target.checked) setVisible(true);
          }}
          className="w-2.5 h-2.5 accent-ctp-blue cursor-pointer"
          data-testid="minimap-pin-checkbox"
        />
        <span className="text-[8px] text-ctp-overlay0 leading-none select-none">Pin</span>
      </label>
    </div>
  );
}
