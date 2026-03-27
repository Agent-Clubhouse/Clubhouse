/**
 * ZoneBackground — the translucent themed background area for a zone.
 * Renders at the zone's position/size with the zone's theme background color
 * and a grid dot pattern matching the canvas background in absolute position.
 * Includes resize handles on all edges and corners.
 */

import React from 'react';
import type { ZoneCanvasView, Size, Position } from './canvas-types';
import { GRID_SIZE } from './canvas-types';
import { getTheme } from '../../../themes';
import type { ResizeDirection } from './CanvasView';

/** Size of edge resize zones in pixels */
const EDGE_SIZE = 6;
/** Size of corner resize zones in pixels */
const CORNER_SIZE = 14;

const CURSOR_MAP: Record<ResizeDirection, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

interface ZoneBackgroundProps {
  zone: ZoneCanvasView;
  /** Offset to apply during drag. */
  dragOffset?: { dx: number; dy: number };
  /** Override size/position during a resize operation. */
  resizeOverride?: { size: Size; position: Position };
  /** Called when the user starts resizing by dragging an edge or corner. */
  onResizeStart?: (direction: ResizeDirection, e: React.MouseEvent) => void;
}

export function ZoneBackground({ zone, dragOffset, resizeOverride, onResizeStart }: ZoneBackgroundProps) {
  const theme = getTheme(zone.themeId);
  if (!theme) return null;

  const bgColor = theme.colors.crust;
  const dotColor = theme.colors.surface2;
  const borderColor = theme.colors.accent;

  const width = resizeOverride?.size.width ?? zone.size.width;
  const height = resizeOverride?.size.height ?? zone.size.height;
  const left = resizeOverride?.position.x ?? zone.position.x;
  const top = resizeOverride?.position.y ?? zone.position.y;

  return (
    <div
      className="absolute rounded-lg border-2 border-dashed"
      style={{
        left,
        top,
        width,
        height,
        zIndex: zone.zIndex,
        backgroundColor: bgColor,
        borderColor: `${borderColor}60`,
        backgroundImage: `radial-gradient(circle, ${dotColor}73 0.75px, transparent 0.75px)`,
        backgroundSize: `${GRID_SIZE}px ${GRID_SIZE}px`,
        backgroundPosition: `${-left % GRID_SIZE}px ${-top % GRID_SIZE}px`,
        pointerEvents: 'none',
        ...(dragOffset && {
          transform: `translate(${dragOffset.dx}px, ${dragOffset.dy}px)`,
          willChange: 'transform',
        }),
      }}
      data-testid={`zone-background-${zone.id}`}
    >
      {/* ── Resize handles ─────────────────────────────────── */}
      {onResizeStart && (
        <>
          {/* Edge handles */}
          <div
            className="absolute top-0 left-[14px] right-[14px] pointer-events-auto"
            style={{ height: EDGE_SIZE, cursor: CURSOR_MAP.n }}
            onMouseDown={(e) => onResizeStart('n', e)}
            data-testid={`zone-resize-n-${zone.id}`}
          />
          <div
            className="absolute bottom-0 left-[14px] right-[14px] pointer-events-auto"
            style={{ height: EDGE_SIZE, cursor: CURSOR_MAP.s }}
            onMouseDown={(e) => onResizeStart('s', e)}
            data-testid={`zone-resize-s-${zone.id}`}
          />
          <div
            className="absolute left-0 top-[14px] bottom-[14px] pointer-events-auto"
            style={{ width: EDGE_SIZE, cursor: CURSOR_MAP.w }}
            onMouseDown={(e) => onResizeStart('w', e)}
            data-testid={`zone-resize-w-${zone.id}`}
          />
          <div
            className="absolute right-0 top-[14px] bottom-[14px] pointer-events-auto"
            style={{ width: EDGE_SIZE, cursor: CURSOR_MAP.e }}
            onMouseDown={(e) => onResizeStart('e', e)}
            data-testid={`zone-resize-e-${zone.id}`}
          />

          {/* Corner handles */}
          <div
            className="absolute top-0 left-0 pointer-events-auto"
            style={{ width: CORNER_SIZE, height: CORNER_SIZE, cursor: CURSOR_MAP.nw }}
            onMouseDown={(e) => onResizeStart('nw', e)}
            data-testid={`zone-resize-nw-${zone.id}`}
          />
          <div
            className="absolute top-0 right-0 pointer-events-auto"
            style={{ width: CORNER_SIZE, height: CORNER_SIZE, cursor: CURSOR_MAP.ne }}
            onMouseDown={(e) => onResizeStart('ne', e)}
            data-testid={`zone-resize-ne-${zone.id}`}
          />
          <div
            className="absolute bottom-0 left-0 pointer-events-auto"
            style={{ width: CORNER_SIZE, height: CORNER_SIZE, cursor: CURSOR_MAP.sw }}
            onMouseDown={(e) => onResizeStart('sw', e)}
            data-testid={`zone-resize-sw-${zone.id}`}
          />
          <div
            className="absolute bottom-0 right-0 pointer-events-auto"
            style={{ width: CORNER_SIZE, height: CORNER_SIZE, cursor: CURSOR_MAP.se }}
            onMouseDown={(e) => onResizeStart('se', e)}
            data-testid={`zone-resize-se-${zone.id}`}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" className="absolute bottom-0.5 right-0.5" style={{ color: `${borderColor}80` }}>
              <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1" />
              <line x1="10" y1="6" x2="6" y2="10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </div>
        </>
      )}
    </div>
  );
}
