/** Room left above a target scrolled to the top, so its first line isn't flush with the edge. */
const START_MARGIN = 8;

/**
 * Scrolls `container` so `target` is visible, without touching any other
 * ancestor. `Element.scrollIntoView` scrolls every scrollable ancestor,
 * including `overflow: hidden` app-shell wrappers, which shifts the whole
 * window up and leaves blank space below it.
 */
export function scrollWithin(
  container: HTMLElement,
  target: HTMLElement,
  block: 'center' | 'nearest' | 'start',
  behavior: ScrollBehavior = 'auto',
): void {
  const c = container.getBoundingClientRect();
  const t = target.getBoundingClientRect();
  const offset = t.top - c.top + container.scrollTop;
  let top: number;
  if (block === 'center') {
    top = offset - (container.clientHeight - t.height) / 2;
  } else if (block === 'start') {
    top = offset - START_MARGIN;
  } else if (t.top < c.top) {
    top = offset;
  } else if (t.bottom > c.bottom) {
    top = offset + t.height - container.clientHeight;
  } else {
    return;
  }
  const max = container.scrollHeight - container.clientHeight;
  top = Math.max(0, Math.min(top, max));
  if (typeof container.scrollTo === 'function') container.scrollTo({ top, behavior });
  else container.scrollTop = top;
}

/**
 * The first element of `elements`, in document order, that reaches into the
 * container: the row the reader's place is measured from. Elements are in
 * order, so this binary-searches instead of measuring every row on each scroll.
 */
export function firstVisibleIndex(container: HTMLElement, elements: ArrayLike<HTMLElement>): number {
  const top = container.getBoundingClientRect().top;
  let low = 0;
  let high = elements.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (elements[mid].getBoundingClientRect().bottom > top) high = mid;
    else low = mid + 1;
  }
  return low < elements.length ? low : -1;
}

/** A scroller's position and size, and the first block its window had mounted. */
export interface ScrollMeasure {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  start: number;
}

export function measureScroll(el: HTMLElement, start: number): ScrollMeasure {
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, start };
}

/** Whether a view moved at least a screen. A hidden view has no screen, and doesn't move. */
export function movedAScreen(before: ScrollMeasure, after: ScrollMeasure): boolean {
  return after.clientHeight > 0 && Math.abs(after.scrollTop - before.scrollTop) >= after.clientHeight;
}

/** What moved a view that no user scrolled. */
export type ScrollMoveCause = 'anchor-restore' | 'window-move' | 'pending-scroll' | 'clamp' | 'unknown';

/** For a move with no known author: the window changed under it, or the browser clamped it to a smaller range. */
export function unexplainedMoveCause(before: ScrollMeasure, after: ScrollMeasure): ScrollMoveCause {
  if (after.start !== before.start) return 'window-move';
  const rangeShrank = after.scrollHeight - after.clientHeight < before.scrollHeight - before.clientHeight;
  const atEnd = after.scrollHeight - after.clientHeight - after.scrollTop <= 1;
  return rangeShrank && atEnd ? 'clamp' : 'unknown';
}

/**
 * Up to `limit` lines a minute. Asks with the time; answers null past the limit,
 * otherwise how many lines went unwritten since the last one.
 */
export function scrollLogLimiter(limit: number): (now: number) => number | null {
  let windowStart = 0;
  let written = 0;
  let suppressed = 0;
  return (now) => {
    if (now - windowStart >= 60_000) {
      windowStart = now;
      written = 0;
    }
    if (written >= limit) {
      suppressed++;
      return null;
    }
    written++;
    const reported = suppressed;
    suppressed = 0;
    return reported;
  };
}
