/**
 * Renderer-wide error capture (spec §4.2): `error` and `unhandledrejection`
 * on window. These catch failures nothing else handles, such as fire-and-forget
 * promise rejections (canvas autosave, #1922). Only the error class and stack
 * are reported; main sanitizes the stack.
 */
import { tel } from './facade';

let installed = false;

export function installRendererErrorHandlers(target: Pick<Window, 'addEventListener'> = window): void {
  if (installed) return;
  installed = true;
  target.addEventListener('error', (event: ErrorEvent) => {
    // Resource load errors (img/script 404s) arrive without an `error` object.
    if (event.error === undefined || event.error === null) return;
    tel.exception(event.error, { handled: false });
  });
  target.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    tel.exception(event.reason, { handled: false });
  });
}

/** Test-only reset. */
export function _resetRendererErrorHandlersForTests(): void {
  installed = false;
}
