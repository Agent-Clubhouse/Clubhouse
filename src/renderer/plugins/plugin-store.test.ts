import { describe, it, expect, beforeEach } from 'vitest';
import { usePluginStore } from './plugin-store';
import type { PluginManifest } from '../../shared/plugin-types';

function getState() {
  return usePluginStore.getState();
}

const testManifest: PluginManifest = {
  id: 'test-plugin',
  name: 'Test Plugin',
  version: '1.0.0',
  engine: { api: 0.1 },
  scope: 'project',
};

const appManifest: PluginManifest = {
  id: 'app-plugin',
  name: 'App Plugin',
  version: '1.0.0',
  engine: { api: 0.1 },
  scope: 'app',
};

describe('pluginStore', () => {
  beforeEach(() => {
    usePluginStore.setState({
      plugins: {},
      projectEnabled: {},
      appEnabled: [],
      modules: {},
      safeModeActive: false,
      pluginSettings: {},
      permissionViolations: [],
    });
  });

  describe('registerPlugin', () => {
    it('adds a plugin to the registry', () => {
      getState().registerPlugin(testManifest, 'community', '/path/to/plugin');
      expect(getState().plugins['test-plugin']).toBeDefined();
      expect(getState().plugins['test-plugin'].manifest.name).toBe('Test Plugin');
      expect(getState().plugins['test-plugin'].source).toBe('community');
      expect(getState().plugins['test-plugin'].status).toBe('registered');
    });

    it('registers with a custom status', () => {
      getState().registerPlugin(testManifest, 'community', '/path', 'incompatible', 'Bad API');
      expect(getState().plugins['test-plugin'].status).toBe('incompatible');
      expect(getState().plugins['test-plugin'].error).toBe('Bad API');
    });

    it('overwrites existing entry with same id', () => {
      getState().registerPlugin(testManifest, 'community', '/path/v1');
      getState().registerPlugin({ ...testManifest, version: '2.0.0' }, 'community', '/path/v2');
      expect(getState().plugins['test-plugin'].manifest.version).toBe('2.0.0');
    });
  });

  describe('setPluginStatus', () => {
    it('updates status of an existing plugin', () => {
      getState().registerPlugin(testManifest, 'community', '/path');
      getState().setPluginStatus('test-plugin', 'activated');
      expect(getState().plugins['test-plugin'].status).toBe('activated');
    });

    it('does nothing for unknown plugin', () => {
      const before = { ...getState().plugins };
      getState().setPluginStatus('nonexistent', 'activated');
      expect(getState().plugins).toEqual(before);
    });

    it('can set error message', () => {
      getState().registerPlugin(testManifest, 'community', '/path');
      getState().setPluginStatus('test-plugin', 'errored', 'Something broke');
      expect(getState().plugins['test-plugin'].error).toBe('Something broke');
    });
  });

  describe('setPluginModule / removePluginModule', () => {
    it('stores and retrieves a module', () => {
      const mockModule = { activate: () => {} };
      getState().setPluginModule('test-plugin', mockModule);
      expect(getState().modules['test-plugin']).toBe(mockModule);
    });

    it('removes a module', () => {
      getState().setPluginModule('test-plugin', { activate: () => {} });
      getState().removePluginModule('test-plugin');
      expect(getState().modules['test-plugin']).toBeUndefined();
    });
  });

  describe('project plugin enable/disable', () => {
    it('enables a plugin for a project', () => {
      getState().enableForProject('proj-1', 'test-plugin');
      expect(getState().projectEnabled['proj-1']).toContain('test-plugin');
    });

    it('does not duplicate when enabling twice', () => {
      getState().enableForProject('proj-1', 'test-plugin');
      getState().enableForProject('proj-1', 'test-plugin');
      expect(getState().projectEnabled['proj-1'].filter((id) => id === 'test-plugin')).toHaveLength(1);
    });

    it('disables a plugin for a project', () => {
      getState().enableForProject('proj-1', 'test-plugin');
      getState().enableForProject('proj-1', 'other-plugin');
      getState().disableForProject('proj-1', 'test-plugin');
      expect(getState().projectEnabled['proj-1']).not.toContain('test-plugin');
      expect(getState().projectEnabled['proj-1']).toContain('other-plugin');
    });

    it('loadProjectPluginConfig replaces entire list', () => {
      getState().enableForProject('proj-1', 'old-plugin');
      getState().loadProjectPluginConfig('proj-1', ['new-a', 'new-b']);
      expect(getState().projectEnabled['proj-1']).toEqual(['new-a', 'new-b']);
    });

    it('projects are isolated', () => {
      getState().enableForProject('proj-1', 'plugin-a');
      getState().enableForProject('proj-2', 'plugin-b');
      expect(getState().projectEnabled['proj-1']).toEqual(['plugin-a']);
      expect(getState().projectEnabled['proj-2']).toEqual(['plugin-b']);
    });
  });

  describe('app plugin enable/disable', () => {
    it('enables an app plugin', () => {
      getState().enableApp('app-plugin');
      expect(getState().appEnabled).toContain('app-plugin');
    });

    it('does not duplicate when enabling twice', () => {
      getState().enableApp('app-plugin');
      getState().enableApp('app-plugin');
      expect(getState().appEnabled.filter((id) => id === 'app-plugin')).toHaveLength(1);
    });

    it('disables an app plugin', () => {
      getState().enableApp('app-plugin');
      getState().disableApp('app-plugin');
      expect(getState().appEnabled).not.toContain('app-plugin');
    });

    it('loadAppPluginConfig replaces entire list', () => {
      getState().enableApp('old');
      getState().loadAppPluginConfig(['new-a', 'new-b']);
      expect(getState().appEnabled).toEqual(['new-a', 'new-b']);
    });
  });

  describe('plugin settings', () => {
    it('sets a single setting', () => {
      getState().setPluginSetting('proj-1', 'test-plugin', 'theme', 'dark');
      expect(getState().pluginSettings['proj-1:test-plugin']).toEqual({ theme: 'dark' });
    });

    it('preserves other settings when updating one', () => {
      getState().setPluginSetting('app', 'test-plugin', 'a', 1);
      getState().setPluginSetting('app', 'test-plugin', 'b', 2);
      expect(getState().pluginSettings['app:test-plugin']).toEqual({ a: 1, b: 2 });
    });

    it('loadPluginSettings replaces settings for a key', () => {
      getState().setPluginSetting('app', 'test-plugin', 'old', true);
      getState().loadPluginSettings('app:test-plugin', { fresh: 'data' });
      expect(getState().pluginSettings['app:test-plugin']).toEqual({ fresh: 'data' });
    });
  });

  describe('permission violations', () => {
    const violation = {
      pluginId: 'bad-plugin',
      pluginName: 'Bad Plugin',
      permission: 'git' as const,
      apiName: 'git',
      timestamp: 1000,
    };

    it('permissionViolations starts empty', () => {
      expect(getState().permissionViolations).toEqual([]);
    });

    it('recordPermissionViolation adds entries', () => {
      getState().recordPermissionViolation(violation);
      expect(getState().permissionViolations).toHaveLength(1);
      expect(getState().permissionViolations[0]).toEqual(violation);
    });

    it('multiple violations accumulate', () => {
      getState().recordPermissionViolation(violation);
      getState().recordPermissionViolation({
        ...violation,
        pluginId: 'other-plugin',
        pluginName: 'Other Plugin',
        permission: 'files',
        apiName: 'files',
      });
      expect(getState().permissionViolations).toHaveLength(2);
    });

    it('clearPermissionViolation removes by pluginId', () => {
      getState().recordPermissionViolation(violation);
      getState().recordPermissionViolation({
        ...violation,
        pluginId: 'other-plugin',
        pluginName: 'Other Plugin',
      });
      getState().clearPermissionViolation('bad-plugin');
      expect(getState().permissionViolations).toHaveLength(1);
      expect(getState().permissionViolations[0].pluginId).toBe('other-plugin');
    });

    it('clearPermissionViolation is a no-op for unknown pluginId', () => {
      getState().recordPermissionViolation(violation);
      getState().clearPermissionViolation('nonexistent');
      expect(getState().permissionViolations).toHaveLength(1);
    });
  });

  describe('safe mode', () => {
    it('defaults to false', () => {
      expect(getState().safeModeActive).toBe(false);
    });

    it('can be set to true', () => {
      getState().setSafeModeActive(true);
      expect(getState().safeModeActive).toBe(true);
    });

    it('can be toggled back to false', () => {
      getState().setSafeModeActive(true);
      getState().setSafeModeActive(false);
      expect(getState().safeModeActive).toBe(false);
    });
  });
});
