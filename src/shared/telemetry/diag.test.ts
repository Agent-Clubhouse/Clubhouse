import { describe, expect, it } from 'vitest';
import { DIAG_MAX_NS_CHARS, isDiagNamespace, pluginDiagNamespace } from './diag';

describe('pluginDiagNamespace (#2403)', () => {
  it('is plugin:<id> when that fits', () => {
    expect(pluginDiagNamespace('my-plugin')).toBe('plugin:my-plugin');
    const longest = 'x'.repeat(DIAG_MAX_NS_CHARS - 'plugin:'.length);
    expect(pluginDiagNamespace(longest)).toBe(`plugin:${longest}`);
  });

  it('cuts a 200-character id to a valid namespace with a hash of the whole id', () => {
    const ns = pluginDiagNamespace('a'.repeat(200));
    expect(ns.length).toBe(DIAG_MAX_NS_CHARS);
    expect(isDiagNamespace(ns)).toBe(true);
    expect(ns).toMatch(/^plugin:a+-[0-9a-f]{8}$/);
  });

  it('keeps two long ids with the same prefix apart, and is stable', () => {
    const base = 'p'.repeat(150);
    expect(pluginDiagNamespace(`${base}-one`)).not.toBe(pluginDiagNamespace(`${base}-two`));
    expect(pluginDiagNamespace(`${base}-one`)).toBe(pluginDiagNamespace(`${base}-one`));
  });

  it('makes an id with characters a namespace may not carry valid', () => {
    expect(isDiagNamespace(pluginDiagNamespace('bad id:with spaces'))).toBe(true);
  });
});
