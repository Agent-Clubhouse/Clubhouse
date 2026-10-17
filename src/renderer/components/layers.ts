/**
 * Shared bookkeeping for the overlay components (Modal, PopupMenu, Tooltip).
 *
 * Esc: popups (menus, tooltips) listen in the capture phase and call
 * `preventDefault()` when they handle Esc; a Modal ignores Esc events that are
 * already `defaultPrevented`, so one press dismisses one layer.
 *
 * Focus: popups portal to <body> outside a Modal's panel, so they carry
 * LAYER_PORTAL_ATTR and an open Modal treats focus inside them as its own.
 */

export const LAYER_PORTAL_ATTR = 'data-layer-portal';

/** Open modals, innermost last. */
const modalStack: symbol[] = [];

export function pushModal(token: symbol): void { modalStack.push(token); }

export function removeModal(token: symbol): void {
  const i = modalStack.indexOf(token);
  if (i >= 0) modalStack.splice(i, 1);
}

export function isTopModal(token: symbol): boolean { return modalStack[modalStack.length - 1] === token; }

export function hasOpenModal(): boolean { return modalStack.length > 0; }

export function isInLayerPortal(el: Element | null): boolean {
  return !!el?.closest(`[${LAYER_PORTAL_ATTR}]`);
}
