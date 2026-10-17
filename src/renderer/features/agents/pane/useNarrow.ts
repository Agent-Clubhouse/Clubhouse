import { useLayoutEffect, useState, type RefObject } from 'react';

/** Below this width the pane toolbar, popout title bar and composer switch to icons (#2018). */
export const NARROW_PANE_PX = 640;

/** True while the element is narrower than `px`. Wide until measured, and where ResizeObserver is missing. */
export function useNarrow(ref: RefObject<HTMLElement | null>, px = NARROW_PANE_PX): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = (w: number) => setNarrow(w > 0 && w < px);
    measure(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => measure(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, px]);
  return narrow;
}

/** True while the window is shorter than `px`, for popouts near their 300px minimum height. */
export function useShortWindow(px = 400): boolean {
  const [short, setShort] = useState(() => typeof window !== 'undefined' && window.innerHeight > 0 && window.innerHeight < px);
  useLayoutEffect(() => {
    const onResize = () => setShort(window.innerHeight > 0 && window.innerHeight < px);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [px]);
  return short;
}
