import { describe, it, expect } from 'vitest';
import { getBuiltinPlugins, getDefaultEnabledIds } from '../index';

describe('canvas feature gating', () => {
  it('canvas NOT included in getBuiltinPlugins() with no flags', () => {
    const plugins = getBuiltinPlugins({});
    const ids = plugins.map((p) => p.manifest.id);
    expect(ids).not.toContain('canvas');
  });

  it('canvas NOT included in getBuiltinPlugins() when canvas=false', () => {
    const plugins = getBuiltinPlugins({ canvas: false });
    const ids = plugins.map((p) => p.manifest.id);
    expect(ids).not.toContain('canvas');
  });

  it('canvas IS included in getBuiltinPlugins() when canvas=true', () => {
    const plugins = getBuiltinPlugins({ canvas: true });
    const ids = plugins.map((p) => p.manifest.id);
    expect(ids).toContain('canvas');
  });

  it('canvas NOT in default enabled IDs with no flags', () => {
    const defaults = getDefaultEnabledIds({});
    expect(defaults.has('canvas')).toBe(false);
  });

  it('canvas IS in default enabled IDs when canvas=true', () => {
    const defaults = getDefaultEnabledIds({ canvas: true });
    expect(defaults.has('canvas')).toBe(true);
  });

  it('base plugins always present regardless of canvas flag', () => {
    const withoutCanvas = getBuiltinPlugins({});
    const withCanvas = getBuiltinPlugins({ canvas: true });

    const baseIds = ['hub', 'terminal', 'files'];
    for (const id of baseIds) {
      expect(withoutCanvas.map((p) => p.manifest.id)).toContain(id);
      expect(withCanvas.map((p) => p.manifest.id)).toContain(id);
    }
  });

  it('base default enabled IDs always present', () => {
    const defaults = getDefaultEnabledIds({});
    expect(defaults.has('hub')).toBe(true);
    expect(defaults.has('terminal')).toBe(true);
    expect(defaults.has('files')).toBe(true);
  });
});
