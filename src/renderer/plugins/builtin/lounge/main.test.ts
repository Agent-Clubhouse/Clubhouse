import { describe, it, expect, vi } from 'vitest';
import { validateBuiltinPlugin } from '../builtin-plugin-testing';
import { manifest } from './manifest';
import * as loungeModule from './main';
import { createMockContext, createMockAPI } from '../../testing';

describe('lounge main', () => {
  it('passes validateBuiltinPlugin', () => {
    const result = validateBuiltinPlugin({ manifest, module: loungeModule });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('activate does not throw', () => {
    const ctx = createMockContext({ pluginId: 'lounge', scope: 'app' });
    const api = createMockAPI({
      context: { mode: 'app' },
    });

    expect(() => loungeModule.activate(ctx, api)).not.toThrow();
  });

  it('deactivate does not throw', () => {
    expect(() => loungeModule.deactivate()).not.toThrow();
  });

  it('exports MainPanel component', () => {
    expect(loungeModule.MainPanel).toBeDefined();
    expect(typeof loungeModule.MainPanel).toBe('function');
  });
});
