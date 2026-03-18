import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * Renders children into a portal at document.body level.
 *
 * This is critical for context menus inside the canvas because:
 * - The canvas transform container uses CSS `transform: scale() translate()` which creates
 *   a new containing block for `position: fixed` descendants.
 * - The zoom overlay uses `backdrop-filter` which also creates a containing block.
 * - Rendering menus through a portal bypasses these containing blocks entirely,
 *   so `position: fixed` with `clientX/clientY` always positions relative to the viewport.
 */
export function MenuPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
