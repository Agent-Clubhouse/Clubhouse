import { describe, it, expect, beforeEach, vi } from 'vitest';

// Reset module state between tests
beforeEach(() => {
  vi.resetModules();
});

describe('csp-nonce', () => {
  it('generates a base64url nonce', async () => {
    const { generateCspNonce } = await import('./csp-nonce');
    const nonce = generateCspNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(nonce.length).toBeGreaterThanOrEqual(16);
  });

  it('getCspNonce returns the generated nonce', async () => {
    const { generateCspNonce, getCspNonce } = await import('./csp-nonce');
    const nonce = generateCspNonce();
    expect(getCspNonce()).toBe(nonce);
  });

  it('getCspNonce throws if called before generateCspNonce', async () => {
    const { getCspNonce } = await import('./csp-nonce');
    expect(() => getCspNonce()).toThrow('CSP nonce not initialized');
  });

  it('generateCspNonce produces a different value each call', async () => {
    const { generateCspNonce } = await import('./csp-nonce');
    const a = generateCspNonce();
    const b = generateCspNonce();
    expect(a).not.toBe(b);
  });
});
