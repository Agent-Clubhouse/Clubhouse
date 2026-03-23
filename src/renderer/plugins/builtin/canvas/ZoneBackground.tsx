/**
 * ZoneBackground — the translucent themed background area for a zone.
 * Renders at the zone's position/size with the zone's theme background color
 * and a grid dot pattern matching the canvas background in absolute position.
 */

import React from 'react';
import type { ZoneCanvasView } from './canvas-types';
import { GRID_SIZE } from './canvas-types';
import { getTheme } from '../../../themes';

interface ZoneBackgroundProps {
  zone: ZoneCanvasView;
  /** Offset to apply during drag. */
  dragOffset?: { dx: number; dy: number };
}

export function ZoneBackground({ zone, dragOffset }: ZoneBackgroundProps) {
  const theme = getTheme(zone.themeId);
  if (!theme) return null;

  const bgColor = theme.colors.crust;
  const dotColor = theme.colors.surface2;
  const borderColor = theme.colors.accent;

  return (
    <div
      className="absolute rounded-lg border-2 border-dashed pointer-events-none"
      style={{
        left: zone.position.x,
        top: zone.position.y,
        width: zone.size.width,
        height: zone.size.height,
        zIndex: zone.zIndex,
        backgroundColor: bgColor,
        borderColor: `${borderColor}60`,
        backgroundImage: `radial-gradient(circle, ${dotColor}73 0.75px, transparent 0.75px)`,
        backgroundSize: `${GRID_SIZE}px ${GRID_SIZE}px`,
        // Offset so dots align with the global canvas grid
        backgroundPosition: `${-zone.position.x % GRID_SIZE}px ${-zone.position.y % GRID_SIZE}px`,
        ...(dragOffset && {
          transform: `translate(${dragOffset.dx}px, ${dragOffset.dy}px)`,
          willChange: 'transform',
        }),
      }}
      data-testid={`zone-background-${zone.id}`}
    />
  );
}
