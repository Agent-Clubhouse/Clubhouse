import { randomBytes } from 'crypto';
import { PLUGIN_PROTOCOL_SCHEME } from '../shared/plugin-protocol-url';

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
 * `script-src` must include `'self'` (renderer is loaded from file://) and the
 * custom `clubhouse-plugin:` scheme so the renderer can import community plugin
 * modules served by the main-process protocol handler (Part B). Removing either
 * re-breaks plugin loading, so the value is locked by a unit test.
 *
 * `blob:` remains for web workers (and the dev blob-import fallback). NO
 * `unsafe-eval`, NO `data:` in script-src — Part B must not regress security.
 */
export function buildProductionCsp(nonce: string): string {
  return `default-src 'self' 'unsafe-inline' data:; script-src 'self' 'nonce-${nonce}' blob: ${PLUGIN_PROTOCOL_SCHEME}:; worker-src 'self' blob:`;
}

/**
 * Build the development Content-Security-Policy (used by the webpack dev server
 * via forge.config.ts). Dev runs the renderer from http://localhost, so it
 * needs the webpack-HMR relaxations (`unsafe-eval`, `unsafe-inline`) that
 * production deliberately omits. We add `clubhouse-plugin:` so the dev renderer
 * can also import plugin modules over the custom scheme (cross-origin, allowed
 * by the handler's CORS header). Locked by a unit test alongside the prod CSP.
 */
export function buildDevCsp(): string {
  return `default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-eval' 'unsafe-inline' data: blob: ${PLUGIN_PROTOCOL_SCHEME}:; worker-src 'self' blob: ${PLUGIN_PROTOCOL_SCHEME}:`;
}
