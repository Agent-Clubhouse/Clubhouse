// ── Canvas attention — compute which views need user attention ────────

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { CanvasView, CanvasViewAttention, Viewport, Size } from './canvas-types';
import type { PluginAPI, PluginAgentDetailedStatus } from '../../../../shared/plugin-types';

// ── Pure helpers (exported for tests) ────────────────────────────────

/** Derive attention from an agent's detailed status. */
export function agentAttention(
  viewId: string,
  status: PluginAgentDetailedStatus | null,
): CanvasViewAttention | null {
  if (!status) return null;
  if (status.state === 'needs_permission') {
    return { level: 'warning', message: status.message, viewId };
  }
  if (status.state === 'tool_error') {
    return { level: 'error', message: status.message, viewId };
  }
  return null;
}

/** Determine which edge of the viewport a view sits on (or null if visible). */
export type OffScreenDirection = 'top' | 'bottom' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface OffScreenIndicator {
  viewId: string;
  attention: CanvasViewAttention;
  direction: OffScreenDirection;
  /** Position in screen-space (px from viewport edge) for rendering the bubble. */
  screenX: number;
  screenY: number;
}

/**
 * Compute the screen-space bounding rect of a canvas view given the current viewport.
 */
export function viewToScreenRect(
  view: CanvasView,
  viewport: Viewport,
  _containerSize: Size,
): { left: number; top: number; right: number; bottom: number } {
  const left = (view.position.x + viewport.panX) * viewport.zoom;
  const top = (view.position.y + viewport.panY) * viewport.zoom;
  const right = left + view.size.width * viewport.zoom;
  const bottom = top + view.size.height * viewport.zoom;
  return { left, top, right, bottom };
}

/**
 * Check whether a view's screen rect is fully outside the visible container area.
 */
export function isViewOffScreen(
  screenRect: { left: number; top: number; right: number; bottom: number },
  containerSize: Size,
): boolean {
  return (
    screenRect.right < 0 ||
    screenRect.bottom < 0 ||
    screenRect.left > containerSize.width ||
    screenRect.top > containerSize.height
  );
}

/**
 * Get the primary direction an off-screen view is relative to the viewport.
 */
export function getOffScreenDirection(
  screenRect: { left: number; top: number; right: number; bottom: number },
  containerSize: Size,
): OffScreenDirection {
  const cx = (screenRect.left + screenRect.right) / 2;
  const cy = (screenRect.top + screenRect.bottom) / 2;

  const isAbove = cy < 0;
  const isBelow = cy > containerSize.height;
  const isLeft = cx < 0;
  const isRight = cx > containerSize.width;

  if (isAbove && isLeft) return 'top-left';
  if (isAbove && isRight) return 'top-right';
  if (isBelow && isLeft) return 'bottom-left';
  if (isBelow && isRight) return 'bottom-right';
  if (isAbove) return 'top';
  if (isBelow) return 'bottom';
  if (isLeft) return 'left';
  return 'right';
}

/** Clamp a value to the visible container area with padding. */
function clampToContainer(value: number, min: number, max: number, pad: number): number {
  return Math.max(min + pad, Math.min(max - pad, value));
}

/**
 * Compute screen position for an off-screen indicator bubble.
 * The bubble is placed on the edge of the viewport closest to the off-screen view.
 */
export function computeIndicatorPosition(
  screenRect: { left: number; top: number; right: number; bottom: number },
  containerSize: Size,
  direction: OffScreenDirection,
): { screenX: number; screenY: number } {
  const cx = (screenRect.left + screenRect.right) / 2;
  const cy = (screenRect.top + screenRect.bottom) / 2;
  const pad = 24; // Keep bubbles away from corners

  let screenX: number;
  let screenY: number;

  switch (direction) {
    case 'top':
      screenX = clampToContainer(cx, 0, containerSize.width, pad);
      screenY = 8;
      break;
    case 'bottom':
      screenX = clampToContainer(cx, 0, containerSize.width, pad);
      screenY = containerSize.height - 8;
      break;
    case 'left':
      screenX = 8;
      screenY = clampToContainer(cy, 0, containerSize.height, pad);
      break;
    case 'right':
      screenX = containerSize.width - 8;
      screenY = clampToContainer(cy, 0, containerSize.height, pad);
      break;
    case 'top-left':
      screenX = 8;
      screenY = 8;
      break;
    case 'top-right':
      screenX = containerSize.width - 8;
      screenY = 8;
      break;
    case 'bottom-left':
      screenX = 8;
      screenY = containerSize.height - 8;
      break;
    case 'bottom-right':
      screenX = containerSize.width - 8;
      screenY = containerSize.height - 8;
      break;
  }

  return { screenX, screenY };
}

/**
 * Compute off-screen indicators for all views that need attention.
 */
export function computeOffScreenIndicators(
  views: CanvasView[],
  attentionMap: Map<string, CanvasViewAttention>,
  viewport: Viewport,
  containerSize: Size,
): OffScreenIndicator[] {
  const indicators: OffScreenIndicator[] = [];

  for (const [viewId, attention] of attentionMap) {
    const view = views.find((v) => v.id === viewId);
    if (!view) continue;

    const screenRect = viewToScreenRect(view, viewport, containerSize);
    if (!isViewOffScreen(screenRect, containerSize)) continue;

    const direction = getOffScreenDirection(screenRect, containerSize);
    const { screenX, screenY } = computeIndicatorPosition(screenRect, containerSize, direction);

    indicators.push({ viewId, attention, direction, screenX, screenY });
  }

  return indicators;
}

// ── React hook ───────────────────────────────────────────────────────

/**
 * Hook that computes attention state for all views on the canvas.
 * Returns a Map from viewId → CanvasViewAttention for views that need attention.
 */
export function useCanvasAttention(
  views: CanvasView[],
  api: PluginAPI,
): Map<string, CanvasViewAttention> {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const sub = api.agents.onAnyChange(() => setTick((n) => n + 1));
    return () => sub.dispose();
  }, [api]);

  return useMemo(() => {
    const map = new Map<string, CanvasViewAttention>();

    for (const view of views) {
      if (view.type === 'agent' && view.agentId) {
        const status = api.agents.getDetailedStatus(view.agentId);
        const att = agentAttention(view.id, status);
        if (att) map.set(view.id, att);
      }
      // Other view types can add attention here in future
    }

    return map;
  }, [views, api, tick]);
}

/**
 * Hook for cycling through attention-needing views.
 * Returns the current index, total count, and navigation callbacks.
 */
export function useAttentionCycler(
  attentionMap: Map<string, CanvasViewAttention>,
  onNavigate: (viewId: string) => void,
): {
  count: number;
  currentIndex: number;
  goNext: () => void;
  goPrev: () => void;
} {
  const [currentIndex, setCurrentIndex] = useState(0);
  const attentionIds = useMemo(() => Array.from(attentionMap.keys()), [attentionMap]);
  const count = attentionIds.length;

  // Reset index if it's out of bounds
  useEffect(() => {
    if (currentIndex >= count && count > 0) {
      setCurrentIndex(0);
    }
  }, [count, currentIndex]);

  const goNext = useCallback(() => {
    if (count === 0) return;
    const next = (currentIndex + 1) % count;
    setCurrentIndex(next);
    onNavigate(attentionIds[next]);
  }, [count, currentIndex, attentionIds, onNavigate]);

  const goPrev = useCallback(() => {
    if (count === 0) return;
    const prev = (currentIndex - 1 + count) % count;
    setCurrentIndex(prev);
    onNavigate(attentionIds[prev]);
  }, [count, currentIndex, attentionIds, onNavigate]);

  return { count, currentIndex, goNext, goPrev };
}
