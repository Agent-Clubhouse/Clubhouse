import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerPlugin, getPlugin, getAllPlugins, getPluginIds, clearPlugins } from './registry';
import { PluginDefinition } from './types';

function makePlugin(id: string): PluginDefinition {
  return {
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
    icon: null as any,
    MainPanel: (() => null) as any,
  };
}

describe('plugin registry', () => {
  beforeEach(() => {
    clearPlugins();
  });

  it('registers and retrieves a plugin by id', () => {
    const plugin = makePlugin('files');
    registerPlugin(plugin);
    expect(getPlugin('files')).toBe(plugin);
  });

  it('returns undefined for unregistered id', () => {
    expect(getPlugin('nonexistent')).toBeUndefined();
  });

  it('returns all registered plugins', () => {
    registerPlugin(makePlugin('files'));
    registerPlugin(makePlugin('notes'));
    const all = getAllPlugins();
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.id)).toEqual(['files', 'notes']);
  });

  it('returns all registered plugin ids', () => {
    registerPlugin(makePlugin('git'));
    registerPlugin(makePlugin('terminal'));
    expect(getPluginIds()).toEqual(['git', 'terminal']);
  });

  it('warns on duplicate registration and skips it', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = makePlugin('files');
    const second = makePlugin('files');
    registerPlugin(first);
    registerPlugin(second);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('files'));
    expect(getPlugin('files')).toBe(first);
    expect(getAllPlugins()).toHaveLength(1);
    spy.mockRestore();
  });
});
