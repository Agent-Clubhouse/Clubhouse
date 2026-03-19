/**
 * WireDragOverlay — SVG preview line during wire drag, with target highlighting.
 *
 * Rendered inside the canvas transform container at high z-index.
 */

import React from 'react';
import type { WireDragState } from './useWiring';
import type { CanvasView } from './canvas-types';
import { closestEdgeMidpoint, viewRect, bezierPath } from './wire-utils';

interface WireDragOverlayProps {
  wireDrag: WireDragState;
  views: CanvasView[];
}

export function WireDragOverlay({ wireDrag, views }: WireDragOverlayProps) {
  const { sourceView, canvasPos, hoveredViewId, hoveredValid } = wireDrag;

  // Compute source endpoint
  const srcRect = viewRect(sourceView.position, sourceView.size);
  const fakeTargetRect = { x: canvasPos.x - 1, y: canvasPos.y - 1, width: 2, height: 2 };
  const from = closestEdgeMidpoint(srcRect, fakeTargetRect);

  // If hovering a valid target, snap to that target's edge
  let toX = canvasPos.x;
  let toY = canvasPos.y;
  let pathStr: string;

  if (hoveredViewId && hoveredValid) {
    const target = views.find((v) => v.id === hoveredViewId);
    if (target) {
      const tgtRect = viewRect(target.position, target.size);
      const to = closestEdgeMidpoint(tgtRect, srcRect);
      pathStr = bezierPath(from, to);
      toX = to.x;
      toY = to.y;
    } else {
      pathStr = `M ${from.x} ${from.y} L ${canvasPos.x} ${canvasPos.y}`;
    }
  } else {
    // Free drag — straight dashed line to cursor
    pathStr = `M ${from.x} ${from.y} L ${canvasPos.x} ${canvasPos.y}`;
  }

  return (
    <svg
      className="absolute top-0 left-0 pointer-events-none overflow-visible"
      style={{ width: 1, height: 1, zIndex: 99998 }}
      data-testid="wire-drag-overlay"
    >
      {/* Drag line */}
      <path
        d={pathStr}
        fill="none"
        stroke={hoveredValid ? 'var(--ctp-green, #a6e3a1)' : 'var(--ctp-overlay1, #7f849c)'}
        strokeWidth={2}
        strokeDasharray={hoveredValid ? 'none' : '6 4'}
        strokeLinecap="round"
      />
      {/* Cursor endpoint circle */}
      <circle
        cx={toX}
        cy={toY}
        r={4}
        fill={hoveredValid ? 'var(--ctp-green, #a6e3a1)' : 'var(--ctp-overlay1, #7f849c)'}
      />

      {/* Target highlights */}
      {views.map((v) => {
        if (v.id === sourceView.id) return null;
        const isHovered = v.id === hoveredViewId;
        if (!isHovered) return null;
        return (
          <rect
            key={v.id}
            x={v.position.x - 2}
            y={v.position.y - 2}
            width={v.size.width + 4}
            height={v.size.height + 4}
            rx={10}
            fill="none"
            stroke={hoveredValid ? 'var(--ctp-green, #a6e3a1)' : 'var(--ctp-red, #f38ba8)'}
            strokeWidth={2}
            opacity={0.8}
          />
        );
      })}
    </svg>
  );
}
