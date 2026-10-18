import { useCallback } from 'react';
import type { WheelEvent as ReactWheelEvent } from 'react';

export type WheelContainmentEvent = Pick<ReactWheelEvent, 'ctrlKey' | 'metaKey' | 'stopPropagation'>;

export function shouldContainWheelEvent(event: Pick<ReactWheelEvent, 'ctrlKey' | 'metaKey'>): boolean {
  return !event.ctrlKey && !event.metaKey;
}

export function stopPlainWheelPropagation(event: WheelContainmentEvent): void {
  if (!shouldContainWheelEvent(event)) return;
  event.stopPropagation();
}

export function useWheelContainment() {
  return useCallback((event: WheelContainmentEvent) => {
    if (!shouldContainWheelEvent(event)) return;
    event.stopPropagation();
  }, []);
}

const SCROLLING_OVERFLOW = /^(auto|scroll|overlay)$/;

/**
 * Regions that take the wheel themselves even where no ancestor scrolls: a
 * terminal (xterm's scroll viewport is a sibling of the text, not an
 * ancestor, and a TUI may use the wheel), or anything that opts in.
 */
const WHEEL_REGION_SELECTOR = '.xterm, [data-wheel-region]';

/** Which axes a wheel moves on; an axis with no delta can't be scrolled by it. */
export interface WheelAxes { x: boolean; y: boolean }

function scrollsOn(style: CSSStyleDeclaration, axis: 'x' | 'y'): boolean {
  return SCROLLING_OVERFLOW.test(axis === 'y' ? style.overflowY : style.overflowX);
}

/**
 * Whether `target` sits in a region, up to and including `boundary`, that
 * takes the wheel: an element that scrolls and has content to scroll on one
 * of `axes` (both by default), or a terminal / `data-wheel-region` element.
 * `overflow: hidden`, and regions that don't overflow on a moving axis, don't
 * count, so a vertical wheel over a sideways-scrolling code block still pans.
 */
export function isInScrollableRegion(target: EventTarget | null, boundary: Element, axes: WheelAxes = { x: true, y: true }): boolean {
  let el = target instanceof Element ? target : null;
  while (el) {
    if (el.matches(WHEEL_REGION_SELECTOR)) return true;
    const style = getComputedStyle(el);
    if ((axes.y && scrollsOn(style, 'y') && el.scrollHeight > el.clientHeight)
      || (axes.x && scrollsOn(style, 'x') && el.scrollWidth > el.clientWidth)) {
      return true;
    }
    if (el === boundary) return false;
    el = el.parentElement;
  }
  return false;
}

/**
 * Contain a plain wheel that lands in a scrollable region inside `boundary`
 * (see isInScrollableRegion), so it scrolls that region and nothing behind it
 * (e.g. the canvas doesn't pan). It stays contained at the region's scroll
 * end too: reaching the bottom of a transcript or of a terminal's scrollback
 * never turns into a surprise pan. Ctrl/Cmd+wheel (zoom) and wheels over
 * non-scrollable parts still bubble.
 */
export function containScrollableWheel(
  event: WheelContainmentEvent & Partial<Pick<ReactWheelEvent, 'deltaX' | 'deltaY'>> & Pick<ReactWheelEvent, 'target'>,
  boundary: Element,
): void {
  if (!shouldContainWheelEvent(event)) return;
  // No deltas given (a bare event): treat both axes as moving.
  const known = event.deltaX !== undefined || event.deltaY !== undefined;
  const axes = known ? { x: (event.deltaX ?? 0) !== 0, y: (event.deltaY ?? 0) !== 0 } : { x: true, y: true };
  if (isInScrollableRegion(event.target, boundary, axes)) event.stopPropagation();
}
