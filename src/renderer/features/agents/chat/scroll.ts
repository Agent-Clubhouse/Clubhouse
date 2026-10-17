/**
 * Scrolls `container` so `target` is visible, without touching any other
 * ancestor. `Element.scrollIntoView` scrolls every scrollable ancestor,
 * including `overflow: hidden` app-shell wrappers, which shifts the whole
 * window up and leaves blank space below it.
 */
export function scrollWithin(
  container: HTMLElement,
  target: HTMLElement,
  block: 'center' | 'nearest',
  behavior: ScrollBehavior = 'auto',
): void {
  const c = container.getBoundingClientRect();
  const t = target.getBoundingClientRect();
  const offset = t.top - c.top + container.scrollTop;
  let top: number;
  if (block === 'center') {
    top = offset - (container.clientHeight - t.height) / 2;
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
