import { describe, it, expect } from 'vitest';
import { getBuiltinPlugins, getDefaultEnabledIds, CANVAS_SUB_PLUGIN_IDS } from '../index';

describe('canvas feature gating', () => {
  it('canvas IS always included in getBuiltinPlugins() (no experimental flag needed)', () => {
    const plugins = getBuiltinPlugins({});
    const ids = plugins.map((p) => p.manifest.id);
    expect(ids).toContain('canvas');
  });

  it('canvas sub-plugins (group-project, agent-queue) are always loaded alongside canvas', () => {
    const plugins = getBuiltinPlugins({});
    const ids = plugins.map((p) => p.manifest.id);
    expect(ids).toContain('group-project');
    expect(ids).toContain('agent-queue');
  });

  it('canvas NOT in default enabled IDs (disabled by default)', () => {
    const defaults = getDefaultEnabledIds({});
    expect(defaults.has('canvas')).toBe(false);
  });

  it('canvas sub-plugins NOT in default enabled IDs', () => {
    const defaults = getDefaultEnabledIds({});
    for (const id of CANVAS_SUB_PLUGIN_IDS) {
      expect(defaults.has(id)).toBe(false);
    }
  });

  it('CANVAS_SUB_PLUGIN_IDS contains group-project and agent-queue', () => {
    expect(CANVAS_SUB_PLUGIN_IDS.has('group-project')).toBe(true);
    expect(CANVAS_SUB_PLUGIN_IDS.has('agent-queue')).toBe(true);
  });

  it('base plugins always present regardless of flags', () => {
    const plugins = getBuiltinPlugins({});
    const ids = plugins.map((p) => p.manifest.id);
    for (const id of ['hub', 'terminal', 'files']) {
      expect(ids).toContain(id);
    }
  });

  it('base default enabled IDs always present', () => {
    const defaults = getDefaultEnabledIds({});
    expect(defaults.has('hub')).toBe(true);
    expect(defaults.has('terminal')).toBe(true);
    expect(defaults.has('files')).toBe(true);
  });

  it('browser and git are loaded but NOT in default enabled IDs', () => {
    const plugins = getBuiltinPlugins({});
    const ids = plugins.map((p) => p.manifest.id);
    expect(ids).toContain('browser');
    expect(ids).toContain('git');

    const defaults = getDefaultEnabledIds({});
    expect(defaults.has('browser')).toBe(false);
    expect(defaults.has('git')).toBe(true);
  });
});
