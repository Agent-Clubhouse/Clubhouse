import {
  cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type ReactElement, type ReactNode, type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { useKeyboardShortcutsStore } from '../stores/keyboardShortcutsStore';
import { LAYER_PORTAL_ATTR } from './layers';

/**
 * The app's tooltip (#2013), styled like the chrome's agent hover card. It
 * replaces native `title=` tooltips: one delay, opens at once on keyboard
 * focus, closes on Esc, leaving, blur or a click, and can show the action's
 * shortcut with the platform's modifiers.
 *
 * The child must be a single element that passes DOM props and `ref` through
 * (a DOM element, or a component like `Button`). Icon-only triggers still need
 * their own `aria-label`; the tooltip only adds a description.
 */

/** Hover delay before a tooltip opens. */
export const TOOLTIP_DELAY_MS = 500;
/** Moving from one tooltip trigger to the next within this window opens the next at once. */
const TOOLTIP_SKIP_MS = 300;
const GAP = 6;
const MARGIN = 8;

let lastClosedAt = 0;

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

const MAC_MODS: [string, string][] = [['Control', '⌃'], ['Alt', '⌥'], ['Shift', '⇧'], ['Meta', '⌘']];
const MAC_KEYS: Record<string, string> = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Enter: '↩', Backspace: '⌫', Delete: '⌦', Escape: 'Esc', Tab: '⇥', ' ': 'Space',
};
const OTHER_KEYS: Record<string, string> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Esc', ' ': 'Space',
};

/**
 * Format a binding string ("Meta+Shift+P", the keyboard shortcuts store's
 * format) for display: "⇧⌘P" on macOS, "Ctrl+Shift+P" elsewhere.
 */
export function formatShortcut(binding: string, platform: string | undefined = window.clubhouse?.platform): string {
  const split = binding.endsWith('++') ? binding.length - 2 : binding.lastIndexOf('+');
  const mods = new Set(split > 0 ? binding.slice(0, split).split('+') : []);
  const rawKey = split > 0 ? binding.slice(split + 1) : binding;
  const key = rawKey.length === 1 ? rawKey.toUpperCase() : rawKey;
  if (platform === 'darwin') {
    return MAC_MODS.filter(([m]) => mods.has(m)).map(([, g]) => g).join('') + (MAC_KEYS[key] ?? key);
  }
  const parts: string[] = [];
  if (mods.has('Meta') || mods.has('Control')) parts.push('Ctrl');
  if (mods.has('Alt')) parts.push('Alt');
  if (mods.has('Shift')) parts.push('Shift');
  parts.push(OTHER_KEYS[key] ?? key);
  return parts.join('+');
}

// Focus that follows a keyboard event opens the tooltip; focus from a click or
// a programmatic focus() after one doesn't (the :focus-visible heuristic).
let keyboardModality = true;
let modalityTracked = false;
function trackModality() {
  if (modalityTracked) return;
  modalityTracked = true;
  document.addEventListener('keydown', () => { keyboardModality = true; }, true);
  document.addEventListener('pointerdown', () => { keyboardModality = false; }, true);
  document.addEventListener('mousedown', () => { keyboardModality = false; }, true);
}

function mergeRefs<T>(...refs: (Ref<T> | undefined)[]) {
  return (node: T | null) => {
    for (const r of refs) {
      if (typeof r === 'function') r(node);
      else if (r) (r as React.MutableRefObject<T | null>).current = node;
    }
  };
}

function place(anchor: DOMRect, tip: { width: number; height: number }, side: TooltipSide) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let s = side;
  if (s === 'bottom' && anchor.bottom + GAP + tip.height > vh - MARGIN) s = 'top';
  else if (s === 'top' && anchor.top - GAP - tip.height < MARGIN) s = 'bottom';
  else if (s === 'right' && anchor.right + GAP + tip.width > vw - MARGIN) s = 'left';
  else if (s === 'left' && anchor.left - GAP - tip.width < MARGIN) s = 'right';

  let left: number;
  let top: number;
  if (s === 'top' || s === 'bottom') {
    left = anchor.left + anchor.width / 2 - tip.width / 2;
    top = s === 'bottom' ? anchor.bottom + GAP : anchor.top - GAP - tip.height;
  } else {
    left = s === 'right' ? anchor.right + GAP : anchor.left - GAP - tip.width;
    top = anchor.top + anchor.height / 2 - tip.height / 2;
  }
  return {
    left: Math.max(MARGIN, Math.min(left, vw - tip.width - MARGIN)),
    top: Math.max(MARGIN, Math.min(top, vh - tip.height - MARGIN)),
  };
}

type TriggerProps = {
  ref?: Ref<HTMLElement>;
  'aria-label'?: string;
  'aria-describedby'?: string;
  onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void;
  onFocus?: (e: React.FocusEvent<HTMLElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLElement>) => void;
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
};

export function Tooltip({ content, shortcut, shortcutAction, side = 'bottom', disabled, children }: {
  content: ReactNode;
  /** A binding string like "Meta+Shift+P", shown formatted for the platform. */
  shortcut?: string;
  /** A keyboard shortcuts store action id; shows its current binding. Wins over `shortcut`. */
  shortcutAction?: string;
  side?: TooltipSide;
  /** Render the child alone, with no tooltip. */
  disabled?: boolean;
  children: ReactElement;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // After a click, stay closed until the pointer leaves.
  const suppressed = useRef(false);

  const actionBinding = useKeyboardShortcutsStore((s) => (shortcutAction ? s.shortcuts[shortcutAction]?.currentBinding : undefined));
  const binding = shortcutAction ? actionBinding : shortcut;
  const keys = binding ? formatShortcut(binding) : '';

  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

  const hide = useCallback(() => {
    clearTimer();
    setOpen((was) => { if (was) lastClosedAt = Date.now(); return false; });
  }, []);

  const show = useCallback((immediate: boolean) => {
    if (suppressed.current) return;
    clearTimer();
    if (immediate || Date.now() - lastClosedAt < TOOLTIP_SKIP_MS) { setOpen(true); return; }
    timer.current = setTimeout(() => { timer.current = null; setOpen(true); }, TOOLTIP_DELAY_MS);
  }, []);

  useEffect(() => { trackModality(); return clearTimer; }, []);

  useEffect(() => {
    if (!open) { setPos(null); return; }
    // Capture phase + preventDefault: Esc dismisses only the tooltip, not a Modal under it (layers.ts).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      hide();
    };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [open, hide]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !tipRef.current) return;
    const tip = tipRef.current.getBoundingClientRect();
    setPos(place(triggerRef.current.getBoundingClientRect(), { width: tip.width, height: tip.height }, side));
  }, [open, side, content, keys]);

  if (disabled || !isValidElement<TriggerProps>(children)) return children;

  const props = children.props;
  // Don't repeat the accessible name as the description; keep the shortcut.
  const describes = !(typeof content === 'string' && content === props['aria-label']) || !!keys;

  const trigger = cloneElement(children, {
    ref: mergeRefs(triggerRef, props.ref),
    'aria-describedby': open && describes ? [props['aria-describedby'], id].filter(Boolean).join(' ') : props['aria-describedby'],
    onMouseEnter: (e) => { props.onMouseEnter?.(e); show(false); },
    onMouseLeave: (e) => { props.onMouseLeave?.(e); suppressed.current = false; hide(); },
    onFocus: (e) => { props.onFocus?.(e); if (keyboardModality) show(true); },
    onBlur: (e) => { props.onBlur?.(e); hide(); },
    onPointerDown: (e) => { props.onPointerDown?.(e); suppressed.current = true; hide(); },
  });

  return (
    <>
      {trigger}
      {open && createPortal(
        <div
          ref={tipRef}
          id={id}
          role="tooltip"
          data-testid="tooltip"
          {...{ [LAYER_PORTAL_ATTR]: '' }}
          style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          className="fixed z-tooltip pointer-events-none flex items-center gap-2 min-h-[26px] max-w-xs px-[9px] py-1 rounded-md border border-surface-1 bg-ctp-mantle shadow-lg text-xs text-ctp-subtext1"
        >
          <span className="min-w-0">{content}</span>
          {keys && (
            <kbd className="flex-shrink-0 px-[5px] py-px rounded border border-surface-1 font-sans text-xs leading-4 text-ctp-overlay1">{keys}</kbd>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
