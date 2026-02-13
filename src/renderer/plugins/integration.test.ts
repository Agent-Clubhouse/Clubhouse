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

  it('registered plugins appear in ExplorerRail tab list via getAllPlugins', () => {
    registerPlugin(makePlugin('files'));
    registerPlugin(makePlugin('git'));
    registerPlugin(makePlugin('terminal', { fullWidth: true }));

    const plugins = getAllPlugins();
    expect(plugins.map((p) => p.id)).toEqual(['files', 'git', 'terminal']);
  });

  it('getPlugin returns the correct plugin for AccessoryPanel/MainContentView lookup', () => {
    const filesPlugin = makePlugin('files', {
      SidebarPanel: (() => null) as any,
    });
    registerPlugin(filesPlugin);

    const found = getPlugin('files');
    expect(found).toBe(filesPlugin);
    expect(found!.SidebarPanel).toBeDefined();
    expect(found!.MainPanel).toBeDefined();
  });

  it('fullWidth flag drives layout correctly', () => {
    registerPlugin(makePlugin('terminal', { fullWidth: true }));
    registerPlugin(makePlugin('files'));

    expect(getPlugin('terminal')?.fullWidth).toBe(true);
    expect(getPlugin('files')?.fullWidth).toBeFalsy();
  });

  it('pluginStore defaults all registered plugins to enabled', async () => {
    registerPlugin(makePlugin('files'));
    registerPlugin(makePlugin('git'));
    registerPlugin(makePlugin('notes'));

    await usePluginStore.getState().loadPluginConfig('proj1', '/path');
    const enabled = usePluginStore.getState().getEnabledPluginIds('proj1');
    expect(enabled).toEqual(['files', 'git', 'notes']);
  });

  it('disabling a plugin removes it from enabled list', async () => {
    registerPlugin(makePlugin('files'));
    registerPlugin(makePlugin('git'));

    await usePluginStore.getState().loadPluginConfig('proj1', '/path');
    await usePluginStore.getState().setPluginEnabled('proj1', '/path', 'git', false);

    expect(usePluginStore.getState().isPluginEnabled('proj1', 'files')).toBe(true);
    expect(usePluginStore.getState().isPluginEnabled('proj1', 'git')).toBe(false);
  });

  it('disabled plugin does not appear when filtering by isPluginEnabled', async () => {
    registerPlugin(makePlugin('files'));
    registerPlugin(makePlugin('git'));
    registerPlugin(makePlugin('terminal'));

    await usePluginStore.getState().loadPluginConfig('proj1', '/path');
    await usePluginStore.getState().setPluginEnabled('proj1', '/path', 'git', false);

    const { isPluginEnabled } = usePluginStore.getState();
    const visiblePlugins = getAllPlugins().filter((p) => isPluginEnabled('proj1', p.id));
    expect(visiblePlugins.map((p) => p.id)).toEqual(['files', 'terminal']);
  });

  it('plugin lifecycle hooks are callable', async () => {
    const onLoad = vi.fn();
    const onUnload = vi.fn();
    registerPlugin(makePlugin('scheduler', {
      onProjectLoad: onLoad,
      onProjectUnload: onUnload,
    }));

    const plugin = getPlugin('scheduler')!;
    const ctx = { projectId: 'p1', projectPath: '/proj' };

    await plugin.onProjectLoad!(ctx);
    plugin.onProjectUnload!(ctx);

    expect(onLoad).toHaveBeenCalledWith(ctx);
    expect(onUnload).toHaveBeenCalledWith(ctx);
  });

  it('getPluginIds matches getAllPlugins order', () => {
    registerPlugin(makePlugin('files'));
    registerPlugin(makePlugin('notes'));
    registerPlugin(makePlugin('git'));

    expect(getPluginIds()).toEqual(getAllPlugins().map((p) => p.id));
  });
});
