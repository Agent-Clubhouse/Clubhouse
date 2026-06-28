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

function scriptSrcOf(csp: string): string {
  const dir = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('script-src'));
  if (!dir) throw new Error('no script-src directive');
  return dir;
}

describe('buildProductionCsp', () => {
  // Regression guard: production plugin loading imports community plugin
  // modules over the custom clubhouse-plugin: scheme. That requires both
  // `script-src 'self'` and `clubhouse-plugin:`. Removing either re-breaks
  // plugin loading.
  it("allows same-origin script via script-src 'self'", async () => {
    const { buildProductionCsp } = await import('./csp-nonce');
    expect(scriptSrcOf(buildProductionCsp('test-nonce'))).toContain("'self'");
  });

  it('allows the clubhouse-plugin: scheme in script-src', async () => {
    const { buildProductionCsp } = await import('./csp-nonce');
    expect(scriptSrcOf(buildProductionCsp('test-nonce'))).toContain('clubhouse-plugin:');
  });

  it('keeps blob: in script-src (workers / dev fallback)', async () => {
    const { buildProductionCsp } = await import('./csp-nonce');
    expect(scriptSrcOf(buildProductionCsp('test-nonce'))).toContain('blob:');
  });

  it('does NOT reintroduce unsafe-eval or data: in production script-src', async () => {
    const { buildProductionCsp } = await import('./csp-nonce');
    const scriptSrc = scriptSrcOf(buildProductionCsp('test-nonce'));
    expect(scriptSrc).not.toContain('unsafe-eval');
    expect(scriptSrc).not.toContain('data:');
  });

  it('embeds the provided nonce in script-src', async () => {
    const { buildProductionCsp } = await import('./csp-nonce');
    expect(buildProductionCsp('abc123')).toContain("'nonce-abc123'");
  });
});

describe('buildDevCsp', () => {
  it('allows the clubhouse-plugin: scheme in script-src (dev import path)', async () => {
    const { buildDevCsp } = await import('./csp-nonce');
    expect(scriptSrcOf(buildDevCsp())).toContain('clubhouse-plugin:');
  });

  it('keeps the webpack-HMR relaxations and blob: in dev', async () => {
    const { buildDevCsp } = await import('./csp-nonce');
    const scriptSrc = scriptSrcOf(buildDevCsp());
    expect(scriptSrc).toContain("'unsafe-eval'");
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).toContain('blob:');
  });
});
