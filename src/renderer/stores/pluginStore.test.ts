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
    registerPlugin(makePlugin('custom'));
    usePluginStore.setState({ enabledPlugins: {}, hiddenCoreTabs: {} });
  });

  describe('loadPluginConfig', () => {
    it('loads enabled list from plugins.json', async () => {
      mockRead.mockResolvedValue(JSON.stringify({ enabled: ['custom'] }));
      await usePluginStore.getState().loadPluginConfig('proj1', '/path/to/project');
      expect(mockRead).toHaveBeenCalledWith('/path/to/project/.clubhouse/plugins.json');
      expect(usePluginStore.getState().enabledPlugins['proj1']).toEqual(['custom']);
    });

    it('defaults to empty when file does not exist', async () => {
      mockRead.mockRejectedValue(new Error('ENOENT'));
      await usePluginStore.getState().loadPluginConfig('proj1', '/path/to/project');
      expect(usePluginStore.getState().enabledPlugins['proj1']).toEqual([]);
    });

    it('defaults to empty when file has invalid JSON', async () => {
      mockRead.mockResolvedValue('not json');
      await usePluginStore.getState().loadPluginConfig('proj1', '/path/to/project');
      expect(usePluginStore.getState().enabledPlugins['proj1']).toEqual([]);
    });
  });

  describe('setPluginEnabled', () => {
    it('disables a plugin and persists', async () => {
      mockWrite.mockResolvedValue(undefined);
      registerPlugin(makePlugin('another'));
      usePluginStore.setState({ enabledPlugins: { proj1: ['custom', 'another'] } });
      await usePluginStore.getState().setPluginEnabled('proj1', '/project', 'another', false);
      expect(usePluginStore.getState().enabledPlugins['proj1']).toEqual(['custom']);
      expect(mockWrite).toHaveBeenCalledWith(
        '/project/.clubhouse/plugins.json',
        JSON.stringify({ enabled: ['custom'] }, null, 2),
      );
    });

    it('enables a plugin and persists', async () => {
      mockWrite.mockResolvedValue(undefined);
      usePluginStore.setState({ enabledPlugins: { proj1: [] } });
      await usePluginStore.getState().setPluginEnabled('proj1', '/project', 'custom', true);
      expect(usePluginStore.getState().enabledPlugins['proj1']).toEqual(['custom']);
    });

    it('does not duplicate when enabling already-enabled plugin', async () => {
      mockWrite.mockResolvedValue(undefined);
      usePluginStore.setState({ enabledPlugins: { proj1: ['custom'] } });
      await usePluginStore.getState().setPluginEnabled('proj1', '/project', 'custom', true);
      expect(usePluginStore.getState().enabledPlugins['proj1']).toEqual(['custom']);
    });
  });

  describe('isPluginEnabled', () => {
    it('returns true when plugin is in enabled list', () => {
      usePluginStore.setState({ enabledPlugins: { proj1: ['custom'] } });
      expect(usePluginStore.getState().isPluginEnabled('proj1', 'custom')).toBe(true);
    });

    it('returns false when plugin is not in enabled list', () => {
      usePluginStore.setState({ enabledPlugins: { proj1: ['custom'] } });
      expect(usePluginStore.getState().isPluginEnabled('proj1', 'other')).toBe(false);
    });

    it('returns false when no config loaded (default empty)', () => {
      expect(usePluginStore.getState().isPluginEnabled('unknown', 'custom')).toBe(false);
    });
  });

  describe('getEnabledPluginIds', () => {
    it('returns enabled list for known project', () => {
      usePluginStore.setState({ enabledPlugins: { proj1: ['custom'] } });
      expect(usePluginStore.getState().getEnabledPluginIds('proj1')).toEqual(['custom']);
    });

    it('returns empty array when no config loaded', () => {
      expect(usePluginStore.getState().getEnabledPluginIds('unknown')).toEqual([]);
    });
  });

  describe('isCoreTabHidden', () => {
    it('returns false when no hidden tabs configured', () => {
      expect(usePluginStore.getState().isCoreTabHidden('proj1', 'agents')).toBe(false);
    });

    it('returns true when tab is in hidden list', () => {
      usePluginStore.setState({ hiddenCoreTabs: { proj1: ['hub'] } });
      expect(usePluginStore.getState().isCoreTabHidden('proj1', 'hub')).toBe(true);
    });

    it('returns false when tab is not in hidden list', () => {
      usePluginStore.setState({ hiddenCoreTabs: { proj1: ['hub'] } });
      expect(usePluginStore.getState().isCoreTabHidden('proj1', 'agents')).toBe(false);
    });
  });

  describe('setCoreTabHidden', () => {
    it('hides a core tab and persists', async () => {
      mockWrite.mockResolvedValue(undefined);
      usePluginStore.setState({ enabledPlugins: { proj1: ['custom'] }, hiddenCoreTabs: { proj1: [] } });
      await usePluginStore.getState().setCoreTabHidden('proj1', '/project', 'hub', true);
      expect(usePluginStore.getState().hiddenCoreTabs['proj1']).toEqual(['hub']);
      expect(mockWrite).toHaveBeenCalledWith(
        '/project/.clubhouse/plugins.json',
        JSON.stringify({ enabled: ['custom'], hiddenCoreTabs: ['hub'] }, null, 2),
      );
    });

    it('unhides a core tab and persists without hiddenCoreTabs key', async () => {
      mockWrite.mockResolvedValue(undefined);
      usePluginStore.setState({ enabledPlugins: { proj1: ['custom'] }, hiddenCoreTabs: { proj1: ['hub'] } });
      await usePluginStore.getState().setCoreTabHidden('proj1', '/project', 'hub', false);
      expect(usePluginStore.getState().hiddenCoreTabs['proj1']).toEqual([]);
      expect(mockWrite).toHaveBeenCalledWith(
        '/project/.clubhouse/plugins.json',
        JSON.stringify({ enabled: ['custom'] }, null, 2),
      );
    });

    it('does not duplicate when hiding already-hidden tab', async () => {
      mockWrite.mockResolvedValue(undefined);
      usePluginStore.setState({ hiddenCoreTabs: { proj1: ['hub'] } });
      await usePluginStore.getState().setCoreTabHidden('proj1', '/project', 'hub', true);
      expect(usePluginStore.getState().hiddenCoreTabs['proj1']).toEqual(['hub']);
    });
  });

  describe('loadPluginConfig with hiddenCoreTabs', () => {
    it('loads hiddenCoreTabs from plugins.json', async () => {
      mockRead.mockResolvedValue(JSON.stringify({ enabled: ['custom'], hiddenCoreTabs: ['hub'] }));
      await usePluginStore.getState().loadPluginConfig('proj1', '/path/to/project');
      expect(usePluginStore.getState().hiddenCoreTabs['proj1']).toEqual(['hub']);
    });

    it('defaults hiddenCoreTabs to empty array when not present', async () => {
      mockRead.mockResolvedValue(JSON.stringify({ enabled: ['custom'] }));
      await usePluginStore.getState().loadPluginConfig('proj1', '/path/to/project');
      expect(usePluginStore.getState().hiddenCoreTabs['proj1']).toEqual([]);
    });
  });
});
