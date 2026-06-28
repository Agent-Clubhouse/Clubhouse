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

describe('buildProductionCsp', () => {
  // Regression guard: production plugin loading imports community plugin
  // modules directly by their same-origin file:// URL. That requires
  // `script-src 'self'`. If this is ever removed, multi-file plugin loading
  // breaks again (the #1499 regression class).
  it("allows same-origin script via script-src 'self' so plugin import is not blocked", async () => {
    const { buildProductionCsp } = await import('./csp-nonce');
    const csp = buildProductionCsp('test-nonce');
    const scriptSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('script-src'));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toContain("'self'");
  });

  it('keeps blob: in script-src for the dev blob-import path', async () => {
    const { buildProductionCsp } = await import('./csp-nonce');
    const csp = buildProductionCsp('test-nonce');
    const scriptSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('script-src'))!;
    expect(scriptSrc).toContain('blob:');
  });

  it('embeds the provided nonce in script-src', async () => {
    const { buildProductionCsp } = await import('./csp-nonce');
    const csp = buildProductionCsp('abc123');
    expect(csp).toContain("'nonce-abc123'");
  });
});
