import React, { useEffect, useRef, useState } from 'react';
import { isKeyboardModality } from '../../components/Tooltip';

/** How long an open fold waits after the pointer and focus have left it. */
export const FOLD_CLOSE_DELAY_MS = 5000;

/** The child of body a node is under: the app's root, or a portal's own element. */
const topLevel = (node: Element): Element => {
  let at = node;
  while (at.parentElement && at.parentElement !== document.body) at = at.parentElement;
  return at;
};

/**
 * Whether a node really is outside the fold. A menu or hover card opened from a
 * row is in a portal, outside the fold's DOM but still part of it.
 */
const isOutside = (fold: Element, node: Element | null): boolean =>
  !node || node === document.body || (!fold.contains(node) && topLevel(node) === topLevel(fold));

/**
 * Wraps a fold's row and contents, and closes the fold (#2580) once the pointer
 * and focus have both been gone for FOLD_CLOSE_DELAY_MS. Coming back cancels it,
 * and so does `hold`.
 *
 * Only keyboard focus counts. A click leaves focus on what was clicked, so
 * counting that would keep the fold open after every click until the next one
 * somewhere else.
 *
 * Mounted only while the fold's row is showing, so this state goes with it.
 */
export function AutoClosingFold({ open, hold, onClose, children }: {
  open: boolean;
  /** Stay open regardless of the pointer and focus: pinned, or holding the selection. */
  hold: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);

  const armed = open && !hold && !pointerInside && !focusInside;
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(onClose, FOLD_CLOSE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [armed, onClose]);

  // A focused row can be removed while focused (waking moves it out of the
  // fold), and React sends no blur for that.
  useEffect(() => {
    if (focusInside && ref.current && isOutside(ref.current, document.activeElement)) setFocusInside(false);
  });

  // Likewise a hover card or menu closing under the pointer sends no leave, so
  // while the pointer counts as inside, the next element it reaches can correct that.
  useEffect(() => {
    if (!pointerInside) return;
    const onOver = (e: PointerEvent) => {
      if (ref.current && isOutside(ref.current, e.target as Element)) setPointerInside(false);
    };
    document.addEventListener('pointerover', onOver, true);
    return () => document.removeEventListener('pointerover', onOver, true);
  }, [pointerInside]);

  return (
    <div
      ref={ref}
      className="flex flex-col gap-px"
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
      onFocus={() => { if (isKeyboardModality()) setFocusInside(true); }}
      onBlur={(e) => {
        // The window losing focus leaves the element focused, for when it returns.
        if (document.activeElement === e.target) return;
        if (isOutside(e.currentTarget, e.relatedTarget as Element | null)) setFocusInside(false);
      }}
      // A key pressed on something clicked earlier makes that keyboard focus too.
      onKeyDown={() => setFocusInside(true)}
    >
      {children}
    </div>
  );
}
