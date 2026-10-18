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

function scrollsOn(style: CSSStyleDeclaration, axis: 'x' | 'y'): boolean {
  return SCROLLING_OVERFLOW.test(axis === 'y' ? style.overflowY : style.overflowX);
}

/**
 * Whether `target` sits in an element, up to and including `boundary`, that
 * scrolls and has content to scroll on either axis. Elements with
 * `overflow: hidden`, or that don't overflow, don't count.
 */
export function isInScrollableRegion(target: EventTarget | null, boundary: Element): boolean {
  let el = target instanceof Element ? target : null;
  while (el) {
    const style = getComputedStyle(el);
    if ((scrollsOn(style, 'y') && el.scrollHeight > el.clientHeight)
      || (scrollsOn(style, 'x') && el.scrollWidth > el.clientWidth)) {
      return true;
    }
    if (el === boundary) return false;
    el = el.parentElement;
  }
  return false;
}

/**
 * Contain a plain wheel that lands in a scrollable region inside `boundary`,
 * so it scrolls that region and nothing behind it (e.g. the canvas doesn't
 * pan). It stays contained at the region's scroll end too: reaching the
 * bottom of a transcript never turns into a surprise pan. Ctrl/Cmd+wheel
 * (zoom) and wheels over non-scrollable parts still bubble.
 */
export function containScrollableWheel(event: WheelContainmentEvent & Pick<ReactWheelEvent, 'target'>, boundary: Element): void {
  if (!shouldContainWheelEvent(event)) return;
  if (isInScrollableRegion(event.target, boundary)) event.stopPropagation();
}
