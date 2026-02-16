import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerPlugin, getPlugin, getAllPlugins, getPluginIds, clearPlugins } from './registry';
import { PluginDefinition } from './types';

// Mock window.clubhouse.file for pluginStore
vi.stubGlobal('window', {
  clubhouse: {
    file: {
      read: vi.fn().mockRejectedValue(new Error('ENOENT')),
      write: vi.fn().mockResolvedValue(undefined),
    },
  },
});

import { usePluginStore } from '../stores/pluginStore';

function makePlugin(id: string, opts?: Partial<PluginDefinition>): PluginDefinition {
  return {
    id,
    label: id.charAt(0).toUpperCase() + id.slice(1),
    icon: null as any,
    MainPanel: (() => null) as any,
    ...opts,
  };
}

describe('plugin system integration', () => {
  beforeEach(() => {
    clearPlugins();
    usePluginStore.setState({ enabledPlugins: {} });
  });

  it('registered plugins appear in tab list via getAllPlugins', () => {
    registerPlugin(makePlugin('custom', { fullWidth: true }));

    const plugins = getAllPlugins();
    expect(plugins.map((p) => p.id)).toEqual(['custom']);
  });

  it('getPlugin returns the correct plugin for AccessoryPanel/MainContentView lookup', () => {
    const customPlugin = makePlugin('custom', { fullWidth: true });
    registerPlugin(customPlugin);

    const found = getPlugin('custom');
    expect(found).toBe(customPlugin);
    expect(found!.fullWidth).toBe(true);
    expect(found!.MainPanel).toBeDefined();
  });

  it('fullWidth flag drives layout correctly', () => {
    registerPlugin(makePlugin('wide', { fullWidth: true }));
    registerPlugin(makePlugin('narrow'));

    expect(getPlugin('wide')?.fullWidth).toBe(true);
    expect(getPlugin('narrow')?.fullWidth).toBeFalsy();
  });

  it('pluginStore defaults to empty when no config exists', async () => {
    registerPlugin(makePlugin('custom'));

    await usePluginStore.getState().loadPluginConfig('proj1', '/path');
    const enabled = usePluginStore.getState().getEnabledPluginIds('proj1');
    expect(enabled).toEqual([]);
  });

  it('disabling a plugin removes it from enabled list', async () => {
    registerPlugin(makePlugin('alpha'));
    registerPlugin(makePlugin('beta'));

    await usePluginStore.getState().loadPluginConfig('proj1', '/path');
    await usePluginStore.getState().setPluginEnabled('proj1', '/path', 'alpha', true);
    await usePluginStore.getState().setPluginEnabled('proj1', '/path', 'beta', true);
    await usePluginStore.getState().setPluginEnabled('proj1', '/path', 'beta', false);

    expect(usePluginStore.getState().isPluginEnabled('proj1', 'alpha')).toBe(true);
    expect(usePluginStore.getState().isPluginEnabled('proj1', 'beta')).toBe(false);
  });

  it('disabled plugin does not appear when filtering by isPluginEnabled', async () => {
    registerPlugin(makePlugin('alpha'));
    registerPlugin(makePlugin('beta'));

    await usePluginStore.getState().loadPluginConfig('proj1', '/path');
    await usePluginStore.getState().setPluginEnabled('proj1', '/path', 'alpha', true);
    await usePluginStore.getState().setPluginEnabled('proj1', '/path', 'beta', true);
    await usePluginStore.getState().setPluginEnabled('proj1', '/path', 'beta', false);

    const { isPluginEnabled } = usePluginStore.getState();
    const visiblePlugins = getAllPlugins().filter((p) => isPluginEnabled('proj1', p.id));
    expect(visiblePlugins.map((p) => p.id)).toEqual(['alpha']);
  });

  it('plugin lifecycle hooks are callable', async () => {
    const onLoad = vi.fn();
    const onUnload = vi.fn();
    registerPlugin(makePlugin('custom', {
      onProjectLoad: onLoad,
      onProjectUnload: onUnload,
    }));

    const plugin = getPlugin('custom')!;
    const ctx = { projectId: 'p1', projectPath: '/proj' };

    await plugin.onProjectLoad!(ctx);
    plugin.onProjectUnload!(ctx);

    expect(onLoad).toHaveBeenCalledWith(ctx);
    expect(onUnload).toHaveBeenCalledWith(ctx);
  });

  it('getPluginIds matches getAllPlugins order', () => {
    registerPlugin(makePlugin('alpha'));
    registerPlugin(makePlugin('beta'));

    expect(getPluginIds()).toEqual(getAllPlugins().map((p) => p.id));
  });
});
