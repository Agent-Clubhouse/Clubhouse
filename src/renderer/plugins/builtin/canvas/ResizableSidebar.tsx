import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ResizeDivider } from '../../../../renderer/components/ResizeDivider';

/** Width of the collapsed rail in pixels. */
export const RAIL_WIDTH = 28;

/** Default minimum sidebar width in pixels. */
export const DEFAULT_MIN_WIDTH = 120;

/** Default maximum sidebar width in pixels. */
export const DEFAULT_MAX_WIDTH = 400;

interface ResizableSidebarProps {
  /** Default width when first rendered. */
  defaultWidth: number;
  /** Minimum sidebar width (clamped during resize). */
  minWidth?: number;
  /** Maximum sidebar width (clamped during resize). */
  maxWidth?: number;
  /** Extra class names for the sidebar container. */
  className?: string;
  /** Sidebar content. */
  children: React.ReactNode;
}

export function ResizableSidebar({
  defaultWidth,
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth = DEFAULT_MAX_WIDTH,
  className = '',
  children,
}: ResizableSidebarProps) {
  const [width, setWidth] = useState(defaultWidth);
  const [collapsed, setCollapsed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleResize = useCallback(
    (delta: number) => {
      setWidth((w) => Math.min(maxWidth, Math.max(minWidth, w + delta)));
    },
    [minWidth, maxWidth],
  );

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => !prev);
    setHovered(false);
  }, []);

  const handleRailEnter = useCallback(() => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setHovered(true);
  }, []);

  const handleRailLeave = useCallback(() => {
    // Small delay so the user can move from rail into the overlay
    hoverTimeoutRef.current = setTimeout(() => setHovered(false), 150);
  }, []);

  const handleOverlayEnter = useCallback(() => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setHovered(true);
  }, []);

  const handleOverlayLeave = useCallback(() => {
    hoverTimeoutRef.current = setTimeout(() => setHovered(false), 150);
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  if (collapsed) {
    return (
      <div
        className="relative flex-shrink-0"
        style={{ width: RAIL_WIDTH }}
        ref={containerRef}
        data-testid="resizable-sidebar-rail"
      >
        {/* Collapsed rail */}
        <div
          className="h-full border-r border-surface-0 bg-ctp-mantle/30 flex items-center justify-center cursor-pointer"
          onMouseEnter={handleRailEnter}
          onMouseLeave={handleRailLeave}
          onClick={toggleCollapse}
          title="Expand sidebar"
        >
          <span
            className="text-[8px] text-ctp-subtext0 select-none"
            data-testid="rail-expand-icon"
          >
            &#x25B6;
          </span>
        </div>

        {/* Hover overlay — floats over the content area */}
        {hovered && (
          <div
            className={`absolute top-0 left-0 z-10 h-full shadow-xl border-r border-surface-0 ${className}`}
            style={{ width }}
            onMouseEnter={handleOverlayEnter}
            onMouseLeave={handleOverlayLeave}
            data-testid="resizable-sidebar-overlay"
          >
            {children}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div
        className={`flex-shrink-0 ${className}`}
        style={{ width }}
        data-testid="resizable-sidebar"
      >
        {children}
      </div>
      <ResizeDivider
        onResize={handleResize}
        onToggleCollapse={toggleCollapse}
        collapsed={collapsed}
        collapseDirection="left"
      />
    </>
  );
}
