import { describe, it, expect, beforeEach, vi } from 'vitest';
import { usePluginStore } from './pluginStore';
import { registerPlugin, clearPlugins } from '../plugins/registry';

// Mock window.clubhouse.file
vi.stubGlobal('window', {
  clubhouse: {
    file: {
      read: vi.fn(),
      write: vi.fn(),
    },
  },
});

const mockRead = window.clubhouse.file.read as ReturnType<typeof vi.fn>;
const mockWrite = window.clubhouse.file.write as ReturnType<typeof vi.fn>;

function makePlugin(id: string) {
  return {
    id,
    label: id,
    icon: null as any,
    MainPanel: (() => null) as any,
  };
}

describe('pluginStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPlugins();
    registerPlugin(makePlugin('files'));
    registerPlugin(makePlugin('notes'));
    registerPlugin(makePlugin('git'));
    usePluginStore.setState({ enabledPlugins: {} });
  });

  describe('loadPluginConfig', () => {
    it('loads enabled list from plugins.json', async () => {
      mockRead.mockResolvedValue(JSON.stringify({ enabled: ['files', 'git'] }));
      await usePluginStore.getState().loadPluginConfig('proj1', '/path/to/project');
      expect(mockRead).toHaveBeenCalledWith('/path/to/project/.clubhouse/plugins.json');
      expect(usePluginStore.getState().enabledPlugins['proj1']).toEqual(['files', 'git']);
    });

    it('defaults all plugins to enabled when file does not exist', async () => {
      mockRead.mockRejectedValue(new Error('ENOENT'));
      await usePluginStore.getState().loadPluginConfig('proj1', '/path/to/project');
      expect(usePluginStore.getState().enabledPlugins['proj1']).toEqual(['files', 'notes', 'git']);
    });

    it('defaults all plugins to enabled when file has invalid JSON', async () => {
      mockRead.mockResolvedValue('not json');
      await usePluginStore.getState().loadPluginConfig('proj1', '/path/to/project');
      expect(usePluginStore.getState().enabledPlugins['proj1']).toEqual(['files', 'notes', 'git']);
    });
  });

  describe('setPluginEnabled', () => {
    it('disables a plugin and persists', async () => {
      mockWrite.mockResolvedValue(undefined);
      // Start with all enabled
      usePluginStore.setState({ enabledPlugins: { proj1: ['files', 'notes', 'git'] } });
      await usePluginStore.getState().setPluginEnabled('proj1', '/project', 'notes', false);
      expect(usePluginStore.getState().enabledPlugins['proj1']).toEqual(['files', 'git']);
      expect(mockWrite).toHaveBeenCalledWith(
        '/project/.clubhouse/plugins.json',
        JSON.stringify({ enabled: ['files', 'git'] }, null, 2),
      );
    });

    it('enables a plugin and persists', async () => {
      mockWrite.mockResolvedValue(undefined);
      usePluginStore.setState({ enabledPlugins: { proj1: ['files'] } });
      await usePluginStore.getState().setPluginEnabled('proj1', '/project', 'notes', true);
      expect(usePluginStore.getState().enabledPlugins['proj1']).toEqual(['files', 'notes']);
    });

    it('does not duplicate when enabling already-enabled plugin', async () => {
      mockWrite.mockResolvedValue(undefined);
      usePluginStore.setState({ enabledPlugins: { proj1: ['files', 'notes'] } });
      await usePluginStore.getState().setPluginEnabled('proj1', '/project', 'files', true);
      expect(usePluginStore.getState().enabledPlugins['proj1']).toEqual(['files', 'notes']);
    });
  });

  describe('isPluginEnabled', () => {
    it('returns true when plugin is in enabled list', () => {
      usePluginStore.setState({ enabledPlugins: { proj1: ['files', 'git'] } });
      expect(usePluginStore.getState().isPluginEnabled('proj1', 'files')).toBe(true);
    });

    it('returns false when plugin is not in enabled list', () => {
      usePluginStore.setState({ enabledPlugins: { proj1: ['files'] } });
      expect(usePluginStore.getState().isPluginEnabled('proj1', 'notes')).toBe(false);
    });

    it('returns true when no config loaded (default enabled)', () => {
      expect(usePluginStore.getState().isPluginEnabled('unknown', 'files')).toBe(true);
    });
  });

  describe('getEnabledPluginIds', () => {
    it('returns enabled list for known project', () => {
      usePluginStore.setState({ enabledPlugins: { proj1: ['git'] } });
      expect(usePluginStore.getState().getEnabledPluginIds('proj1')).toEqual(['git']);
    });

    it('returns all plugin ids when no config loaded', () => {
      expect(usePluginStore.getState().getEnabledPluginIds('unknown')).toEqual(['files', 'notes', 'git']);
    });
  });
});
