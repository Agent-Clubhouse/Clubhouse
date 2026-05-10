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
