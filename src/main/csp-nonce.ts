import { randomBytes } from 'crypto';

let _nonce: string | null = null;

export function generateCspNonce(): string {
  _nonce = randomBytes(16).toString('base64url');
  return _nonce;
}

export function getCspNonce(): string {
  if (!_nonce) throw new Error('CSP nonce not initialized — call generateCspNonce() first');
  return _nonce;
}

/**
 * Build the production Content-Security-Policy header value.
 *
 * `script-src` must include `'self'` so the renderer (loaded from file://) can
 * import community plugin modules directly by their file:// URL — they are
 * same-origin and served by the main-process `protocol.handle('file', …)`
 * handler. Removing `'self'` here re-breaks multi-file plugin loading (the
 * #1499 regression class), so the value is locked by a unit test.
 *
 * `blob:` remains allowed for the dev-mode blob-import path and web workers.
 */
export function buildProductionCsp(nonce: string): string {
  return `default-src 'self' 'unsafe-inline' data:; script-src 'self' 'nonce-${nonce}' blob:; worker-src 'self' blob:`;
}
