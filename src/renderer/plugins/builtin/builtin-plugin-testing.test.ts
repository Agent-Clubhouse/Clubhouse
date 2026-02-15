import { describe, it, expect } from 'vitest';
import type { PluginManifest, PluginModule } from '../../../shared/plugin-types';
import { validateBuiltinPlugin, validateAllBuiltinPlugins } from './builtin-plugin-testing';
import { getBuiltinPlugins, type BuiltinPlugin } from './index';

const validManifest: PluginManifest = {
  id: 'test-builtin',
  name: 'Test Built-in',
  version: '1.0.0',
  engine: { api: 0.4 },
  scope: 'app',
  contributes: { help: {} },
};

function makePlugin(
  manifestOverrides?: Partial<PluginManifest>,
  moduleOverrides?: Partial<PluginModule>,
): BuiltinPlugin {
  return {
    manifest: { ...validManifest, ...manifestOverrides },
    module: { activate: () => {}, deactivate: () => {}, ...moduleOverrides },
  };
}

describe('validateBuiltinPlugin', () => {
  it('valid plugin with activate passes', () => {
    const result = validateBuiltinPlugin(makePlugin());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('valid plugin with panel-only (no activate) passes', () => {
    const result = validateBuiltinPlugin(
      makePlugin({}, { activate: undefined, deactivate: undefined, MainPanel: (() => null) as unknown as PluginModule['MainPanel'] }),
    );
    expect(result.valid).toBe(true);
  });

  it('plugin with no activate and no panels fails', () => {
    const result = validateBuiltinPlugin(
      makePlugin({}, { activate: undefined, deactivate: undefined }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('activate');
  });

  it('invalid manifest (unsupported API version) fails', () => {
    const result = validateBuiltinPlugin(
      makePlugin({ engine: { api: 99 } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('not supported'))).toBe(true);
  });

  it('non-function deactivate fails', () => {
    const result = validateBuiltinPlugin(
      makePlugin({}, { deactivate: 'not-a-fn' as unknown as PluginModule['deactivate'] }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('deactivate must be a function'))).toBe(true);
  });
});

describe('validateAllBuiltinPlugins', () => {
  it('detects duplicate IDs', () => {
    const plugins = [makePlugin({ id: 'dupe' }), makePlugin({ id: 'dupe' })];
    const result = validateAllBuiltinPlugins(plugins);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Duplicate'))).toBe(true);
  });

  it('passes with unique valid plugins', () => {
    const plugins = [makePlugin({ id: 'a' }), makePlugin({ id: 'b' })];
    const result = validateAllBuiltinPlugins(plugins);
    expect(result.valid).toBe(true);
  });

  it('prefixes errors with plugin ID', () => {
    const plugins = [makePlugin({ id: 'bad', engine: { api: 99 } })];
    const result = validateAllBuiltinPlugins(plugins);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith('[bad]'))).toBe(true);
  });
});

describe('getBuiltinPlugins catch-all', () => {
  it('all registered built-in plugins pass validation', () => {
    const plugins = getBuiltinPlugins();
    const result = validateAllBuiltinPlugins(plugins);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
