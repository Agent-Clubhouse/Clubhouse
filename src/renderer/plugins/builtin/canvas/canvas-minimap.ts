// ── Pure minimap calculations — no side effects, fully testable ──────

import type { CanvasView, Viewport, Size, Position } from './canvas-types';
import { computeBoundingBox } from './canvas-operations';

// ── Types ────────────────────────────────────────────────────────────

export interface MinimapBounds {
  /** Top-left corner in canvas-space. */
  x: number;
  y: number;
  /** Extent in canvas-space. */
  width: number;
  height: number;
}

export interface MinimapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Constants ────────────────────────────────────────────────────────

/** How much larger the minimap world is compared to the content bounding box. */
export const MINIMAP_WORLD_PADDING_FACTOR = 1.5;

/** On-screen size of the minimap widget. */
export const MINIMAP_WIDTH = 200;
export const MINIMAP_HEIGHT = 140;

/** Milliseconds of viewport inactivity before the minimap auto-hides. */
export const MINIMAP_AUTO_HIDE_DELAY = 3000;

// ── Viewport in canvas-space ─────────────────────────────────────────

/**
 * Compute the rectangle the user is currently looking at in canvas-space.
 * The canvas transform is: scale(zoom) translate(panX, panY) with origin 0,0.
 * So the visible canvas rect is:
 *   left   = -panX
 *   top    = -panY
 *   width  = containerWidth / zoom
 *   height = containerHeight / zoom
 */
export function viewportToCanvasRect(
  viewport: Viewport,
  containerSize: Size,
): MinimapRect {
  return {
    x: -viewport.panX,
    y: -viewport.panY,
    width: containerSize.width / viewport.zoom,
    height: containerSize.height / viewport.zoom,
  };
}

// ── Minimap world bounds ─────────────────────────────────────────────

/**
 * Compute the canvas-space region the minimap should represent.
 * This is the union of:
 *   1) 1.5× the bounding box of all views (padded equally on each side)
 *   2) The current viewport rect
 * whichever produces the larger extent on each axis, then unified.
 */
export function computeMinimapBounds(
  views: CanvasView[],
  viewport: Viewport,
  containerSize: Size,
): MinimapBounds {
  const vpRect = viewportToCanvasRect(viewport, containerSize);

  const bbox = computeBoundingBox(views);

  if (!bbox) {
    // No views — just show the viewport area with some padding
    const pad = Math.max(vpRect.width, vpRect.height) * 0.25;
    return {
      x: vpRect.x - pad,
      y: vpRect.y - pad,
      width: vpRect.width + pad * 2,
      height: vpRect.height + pad * 2,
    };
  }

  // 1.5× padded content bounding box
  const extraW = bbox.width * (MINIMAP_WORLD_PADDING_FACTOR - 1) / 2;
  const extraH = bbox.height * (MINIMAP_WORLD_PADDING_FACTOR - 1) / 2;
  const paddedBbox = {
    x: bbox.x - extraW,
    y: bbox.y - extraH,
    width: bbox.width + extraW * 2,
    height: bbox.height + extraH * 2,
  };

  // Union of padded bbox and viewport rect
  const minX = Math.min(paddedBbox.x, vpRect.x);
  const minY = Math.min(paddedBbox.y, vpRect.y);
  const maxX = Math.max(paddedBbox.x + paddedBbox.width, vpRect.x + vpRect.width);
  const maxY = Math.max(paddedBbox.y + paddedBbox.height, vpRect.y + vpRect.height);

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ── Coordinate mapping ───────────────────────────────────────────────

/**
 * Map a canvas-space rectangle into minimap pixel coordinates.
 * The minimap preserves aspect ratio and centers the content.
 */
export function canvasToMinimap(
  canvasRect: MinimapRect,
  worldBounds: MinimapBounds,
  minimapSize: Size,
): MinimapRect {
  // Determine scale that fits worldBounds into minimapSize, preserving aspect ratio
  const scaleX = minimapSize.width / worldBounds.width;
  const scaleY = minimapSize.height / worldBounds.height;
  const scale = Math.min(scaleX, scaleY);

  // Centered offset
  const renderedW = worldBounds.width * scale;
  const renderedH = worldBounds.height * scale;
  const offsetX = (minimapSize.width - renderedW) / 2;
  const offsetY = (minimapSize.height - renderedH) / 2;

  return {
    x: offsetX + (canvasRect.x - worldBounds.x) * scale,
    y: offsetY + (canvasRect.y - worldBounds.y) * scale,
    width: canvasRect.width * scale,
    height: canvasRect.height * scale,
  };
}

/**
 * Map minimap pixel coordinates back to canvas-space position.
 * Used for click-to-navigate: user clicks on minimap → pan viewport there.
 */
export function minimapToCanvas(
  minimapX: number,
  minimapY: number,
  worldBounds: MinimapBounds,
  minimapSize: Size,
): Position {
  const scaleX = minimapSize.width / worldBounds.width;
  const scaleY = minimapSize.height / worldBounds.height;
  const scale = Math.min(scaleX, scaleY);

  const renderedW = worldBounds.width * scale;
  const renderedH = worldBounds.height * scale;
  const offsetX = (minimapSize.width - renderedW) / 2;
  const offsetY = (minimapSize.height - renderedH) / 2;

  return {
    x: worldBounds.x + (minimapX - offsetX) / scale,
    y: worldBounds.y + (minimapY - offsetY) / scale,
  };
}

/**
 * Given a desired canvas-space center, compute the viewport panX/panY.
 */
export function centerViewportOn(
  canvasCenter: Position,
  containerSize: Size,
  zoom: number,
): { panX: number; panY: number } {
  return {
    panX: (containerSize.width / 2) / zoom - canvasCenter.x,
    panY: (containerSize.height / 2) / zoom - canvasCenter.y,
  };
}
