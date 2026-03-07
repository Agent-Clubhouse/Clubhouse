import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  rmSync: vi.fn(),
  promises: {
    lstat: vi.fn(),
    unlink: vi.fn(),
    rm: vi.fn(),
  },
}));

vi.mock('./agent-settings-service', () => ({
  listSourceSkills: vi.fn(() => []),
  listSourceAgentTemplates: vi.fn(() => []),
  deleteSourceSkill: vi.fn(),
  deleteSourceAgentTemplate: vi.fn(),
  readProjectAgentDefaults: vi.fn(() => ({})),
  writeProjectAgentDefaults: vi.fn(),
}));

import * as fs from 'fs';
import * as agentSettings from './agent-settings-service';
import {
  discoverCommunityPlugins,
  uninstallPlugin,
  listProjectPluginInjections,
  cleanupProjectPluginInjections,
  listOrphanedPluginIds,
} from './plugin-discovery';

const PLUGINS_DIR = path.join(os.tmpdir(), 'clubhouse-test-home', '.clubhouse', 'plugins');
const PLUGIN_DATA_DIR = path.join(os.tmpdir(), 'clubhouse-test-home', '.clubhouse', 'plugin-data');

describe('plugin-discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('discoverCommunityPlugins', () => {
    it('returns empty array when plugins dir does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(discoverCommunityPlugins()).toEqual([]);
    });

    it('discovers plugins with valid manifest.json', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s === PLUGINS_DIR) return true;
        if (s.endsWith('manifest.json')) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'my-plugin', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        id: 'my-plugin',
        name: 'My Plugin',
        version: '1.0.0',
        engine: { api: 0.1 },
        scope: 'project',
      }));

      const result = discoverCommunityPlugins();
      expect(result).toHaveLength(1);
      expect(result[0].manifest.id).toBe('my-plugin');
      expect(result[0].pluginPath).toBe(path.join(PLUGINS_DIR, 'my-plugin'));
      expect(result[0].fromMarketplace).toBe(false);
    });

    it('sets fromMarketplace true when .marketplace marker exists', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s === PLUGINS_DIR) return true;
        if (s.endsWith('manifest.json')) return true;
        if (s.endsWith('.marketplace')) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'market-plugin', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        id: 'market-plugin',
        name: 'Market Plugin',
        version: '1.0.0',
        engine: { api: 0.5 },
        scope: 'project',
      }));

      const result = discoverCommunityPlugins();
      expect(result).toHaveLength(1);
      expect(result[0].fromMarketplace).toBe(true);
    });

    it('sets fromMarketplace false when .marketplace marker is absent', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s === PLUGINS_DIR) return true;
        if (s.endsWith('manifest.json')) return true;
        if (s.endsWith('.marketplace')) return false;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'local-plugin', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        id: 'local-plugin',
        name: 'Local Plugin',
        version: '1.0.0',
        engine: { api: 0.5 },
        scope: 'project',
      }));

      const result = discoverCommunityPlugins();
      expect(result).toHaveLength(1);
      expect(result[0].fromMarketplace).toBe(false);
    });

    it('skips non-directory entries', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'readme.md', isDirectory: () => false, isSymbolicLink: () => false },
      ] as any);

      const result = discoverCommunityPlugins();
      expect(result).toEqual([]);
    });

    it('skips directories without manifest.json', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s === PLUGINS_DIR) return true;
        if (s.endsWith('manifest.json')) return false;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'incomplete', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);

      const result = discoverCommunityPlugins();
      expect(result).toEqual([]);
    });

    it('skips plugins with invalid JSON', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'bad-json', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fs.readFileSync).mockReturnValue('{{not valid json');

      const result = discoverCommunityPlugins();
      expect(result).toEqual([]);
    });

    it('discovers multiple plugins', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'plugin-a', isDirectory: () => true, isSymbolicLink: () => false },
        { name: 'plugin-b', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s.includes('plugin-a')) {
          return JSON.stringify({ id: 'plugin-a', name: 'A', version: '1.0.0', engine: { api: 0.1 }, scope: 'project' });
        }
        return JSON.stringify({ id: 'plugin-b', name: 'B', version: '2.0.0', engine: { api: 0.1 }, scope: 'app' });
      });

      const result = discoverCommunityPlugins();
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.manifest.id)).toEqual(['plugin-a', 'plugin-b']);
    });

    it('discovers symlinked plugin directories', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s === PLUGINS_DIR) return true;
        if (s.endsWith('manifest.json')) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'my-plugin', isDirectory: () => false, isSymbolicLink: () => true },
      ] as any);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        id: 'my-plugin',
        name: 'My Plugin',
        version: '1.0.0',
        engine: { api: 0.1 },
        scope: 'project',
      }));

      const result = discoverCommunityPlugins();
      expect(result).toHaveLength(1);
      expect(result[0].manifest.id).toBe('my-plugin');
      expect(fs.statSync).toHaveBeenCalledWith(path.join(PLUGINS_DIR, 'my-plugin'));
    });

    it('skips symlinks pointing to non-directories', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'some-file', isDirectory: () => false, isSymbolicLink: () => true },
      ] as any);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as any);

      const result = discoverCommunityPlugins();
      expect(result).toEqual([]);
    });

    it('skips broken symlinks', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'broken-link', isDirectory: () => false, isSymbolicLink: () => true },
      ] as any);
      vi.mocked(fs.statSync).mockImplementation(() => { throw new Error('ENOENT'); });

      const result = discoverCommunityPlugins();
      expect(result).toEqual([]);
    });

    it('handles unreadable plugins dir gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('EACCES'); });
      expect(discoverCommunityPlugins()).toEqual([]);
    });
  });

  describe('uninstallPlugin', () => {
    it('removes plugin directory recursively with async rm', async () => {
      vi.mocked(fs.promises.lstat).mockResolvedValue({
        isSymbolicLink: () => false,
      } as any);
      vi.mocked(fs.promises.rm).mockResolvedValue(undefined);

      await uninstallPlugin('my-plugin');

      expect(fs.promises.rm).toHaveBeenCalledWith(
        path.join(PLUGINS_DIR, 'my-plugin'),
        { recursive: true, force: true },
      );
      expect(fs.promises.unlink).not.toHaveBeenCalled();
    });

    it('removes only the symlink when plugin is a symlink', async () => {
      vi.mocked(fs.promises.lstat).mockResolvedValue({
        isSymbolicLink: () => true,
      } as any);
      vi.mocked(fs.promises.unlink).mockResolvedValue(undefined);
      vi.mocked(fs.promises.rm).mockResolvedValue(undefined);

      await uninstallPlugin('linked-plugin');

      expect(fs.promises.unlink).toHaveBeenCalledWith(
        path.join(PLUGINS_DIR, 'linked-plugin'),
      );
      // rm is still called for data dir cleanup
      expect(fs.promises.rm).toHaveBeenCalledWith(
        path.join(PLUGIN_DATA_DIR, 'linked-plugin'),
        { recursive: true, force: true },
      );
    });

    it('does nothing when plugin path does not exist', async () => {
      vi.mocked(fs.promises.lstat).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      await uninstallPlugin('nonexistent');

      expect(fs.promises.rm).not.toHaveBeenCalled();
      expect(fs.promises.unlink).not.toHaveBeenCalled();
    });

    it('cleans up plugin data directory on uninstall', async () => {
      vi.mocked(fs.promises.lstat).mockResolvedValue({
        isSymbolicLink: () => false,
      } as any);
      vi.mocked(fs.promises.rm).mockResolvedValue(undefined);

      await uninstallPlugin('my-plugin');

      expect(fs.promises.rm).toHaveBeenCalledWith(
        path.join(PLUGIN_DATA_DIR, 'my-plugin'),
        { recursive: true, force: true },
      );
    });

    it('does not fail if data directory cleanup throws', async () => {
      vi.mocked(fs.promises.lstat).mockResolvedValue({
        isSymbolicLink: () => false,
      } as any);
      let callCount = 0;
      vi.mocked(fs.promises.rm).mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error('ENOENT');
      });

      // Should not throw even if data dir rm fails
      await expect(uninstallPlugin('my-plugin')).resolves.toBeUndefined();
    });
  });

  describe('listProjectPluginInjections', () => {
    const PROJECT_PATH = '/my/project';

    it('returns empty result when no injections exist', () => {
      vi.mocked(agentSettings.listSourceSkills).mockReturnValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockReturnValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockReturnValue({});

      const result = listProjectPluginInjections('my-plugin', PROJECT_PATH);
      expect(result).toEqual({
        skills: [],
        agentTemplates: [],
        hasInstructions: false,
        permissionAllowCount: 0,
        permissionDenyCount: 0,
        mcpServerNames: [],
      });
    });

    it('returns injected skills (stripping prefix)', () => {
      vi.mocked(agentSettings.listSourceSkills).mockReturnValue([
        { name: 'plugin-my-plugin-skill-one', path: '/p', hasReadme: false },
        { name: 'plugin-my-plugin-skill-two', path: '/p', hasReadme: false },
        { name: 'other-skill', path: '/p', hasReadme: false },
      ]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockReturnValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockReturnValue({});

      const result = listProjectPluginInjections('my-plugin', PROJECT_PATH);
      expect(result.skills).toEqual(['skill-one', 'skill-two']);
    });

    it('returns injected agent templates (stripping prefix)', () => {
      vi.mocked(agentSettings.listSourceSkills).mockReturnValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockReturnValue([
        { name: 'plugin-my-plugin-my-template', path: '/p', hasReadme: false },
      ]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockReturnValue({});

      const result = listProjectPluginInjections('my-plugin', PROJECT_PATH);
      expect(result.agentTemplates).toEqual(['my-template']);
    });

    it('detects instructions block', () => {
      vi.mocked(agentSettings.listSourceSkills).mockReturnValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockReturnValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockReturnValue({
        instructions: '<!-- plugin:my-plugin:start -->\nHello\n<!-- plugin:my-plugin:end -->',
      });

      const result = listProjectPluginInjections('my-plugin', PROJECT_PATH);
      expect(result.hasInstructions).toBe(true);
    });

    it('counts permission rules', () => {
      vi.mocked(agentSettings.listSourceSkills).mockReturnValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockReturnValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockReturnValue({
        permissions: {
          allow: ['Bash(read:**) /* plugin:my-plugin */'],
          deny: ['Bash(write:/etc/**) /* plugin:my-plugin */', 'Bash(rm:**) /* plugin:my-plugin */'],
        },
      });

      const result = listProjectPluginInjections('my-plugin', PROJECT_PATH);
      expect(result.permissionAllowCount).toBe(1);
      expect(result.permissionDenyCount).toBe(2);
    });

    it('lists MCP server names (stripping prefix)', () => {
      vi.mocked(agentSettings.listSourceSkills).mockReturnValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockReturnValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockReturnValue({
        mcpJson: JSON.stringify({ mcpServers: { 'plugin-my-plugin-server': {}, 'other-server': {} } }),
      });

      const result = listProjectPluginInjections('my-plugin', PROJECT_PATH);
      expect(result.mcpServerNames).toEqual(['server']);
    });
  });

  describe('cleanupProjectPluginInjections', () => {
    const PROJECT_PATH = '/my/project';

    beforeEach(() => {
      vi.mocked(fs.promises.rm).mockResolvedValue(undefined);
    });

    it('deletes source skills with the plugin prefix', async () => {
      vi.mocked(agentSettings.listSourceSkills).mockReturnValue([
        { name: 'plugin-my-plugin-skill', path: '/p', hasReadme: false },
        { name: 'other-skill', path: '/p', hasReadme: false },
      ]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockReturnValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockReturnValue({});

      await cleanupProjectPluginInjections('my-plugin', PROJECT_PATH);

      expect(agentSettings.deleteSourceSkill).toHaveBeenCalledWith(PROJECT_PATH, 'plugin-my-plugin-skill');
      expect(agentSettings.deleteSourceSkill).not.toHaveBeenCalledWith(PROJECT_PATH, 'other-skill');
    });

    it('strips instruction block and writes back defaults', async () => {
      vi.mocked(agentSettings.listSourceSkills).mockReturnValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockReturnValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockReturnValue({
        instructions: 'Before\n\n<!-- plugin:my-plugin:start -->\nContent\n<!-- plugin:my-plugin:end -->',
      });

      await cleanupProjectPluginInjections('my-plugin', PROJECT_PATH);

      expect(agentSettings.writeProjectAgentDefaults).toHaveBeenCalledWith(
        PROJECT_PATH,
        expect.objectContaining({ instructions: 'Before' }),
      );
    });

    it('removes tagged permission rules', async () => {
      vi.mocked(agentSettings.listSourceSkills).mockReturnValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockReturnValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockReturnValue({
        permissions: {
          allow: ['Bash(read:**) /* plugin:my-plugin */', 'Manual(rule)'],
          deny: [],
        },
      });

      await cleanupProjectPluginInjections('my-plugin', PROJECT_PATH);

      expect(agentSettings.writeProjectAgentDefaults).toHaveBeenCalledWith(
        PROJECT_PATH,
        expect.objectContaining({
          permissions: { allow: ['Manual(rule)'], deny: [] },
        }),
      );
    });

    it('removes MCP servers with plugin prefix', async () => {
      vi.mocked(agentSettings.listSourceSkills).mockReturnValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockReturnValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockReturnValue({
        mcpJson: JSON.stringify({ mcpServers: { 'plugin-my-plugin-srv': {}, 'keep-me': {} } }),
      });

      await cleanupProjectPluginInjections('my-plugin', PROJECT_PATH);

      expect(agentSettings.writeProjectAgentDefaults).toHaveBeenCalledWith(
        PROJECT_PATH,
        expect.objectContaining({
          mcpJson: JSON.stringify({ mcpServers: { 'keep-me': {} } }, null, 2),
        }),
      );
    });

    it('removes the _agentconfig storage directory', async () => {
      vi.mocked(agentSettings.listSourceSkills).mockReturnValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockReturnValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockReturnValue({});

      await cleanupProjectPluginInjections('my-plugin', PROJECT_PATH);

      expect(fs.promises.rm).toHaveBeenCalledWith(
        path.join(PROJECT_PATH, '.clubhouse', 'plugin-data', '_agentconfig:my-plugin'),
        { recursive: true, force: true },
      );
    });

    it('does not write defaults when nothing changed', async () => {
      vi.mocked(agentSettings.listSourceSkills).mockReturnValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockReturnValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockReturnValue({
        instructions: 'No plugin markers here',
      });

      await cleanupProjectPluginInjections('my-plugin', PROJECT_PATH);

      expect(agentSettings.writeProjectAgentDefaults).not.toHaveBeenCalled();
    });
  });

  describe('listOrphanedPluginIds', () => {
    const PROJECT_PATH = '/my/project';

    it('returns empty array when no plugin-data dir exists', () => {
      vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('ENOENT'); });
      vi.mocked(agentSettings.readProjectAgentDefaults).mockReturnValue({});

      const result = listOrphanedPluginIds(PROJECT_PATH, ['plugin-a']);
      expect(result).toEqual([]);
    });

    it('finds orphaned _agentconfig directories', () => {
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: '_agentconfig:orphan-plugin', isDirectory: () => true } as any,
        { name: '_agentconfig:known-plugin', isDirectory: () => true } as any,
        { name: 'other-dir', isDirectory: () => true } as any,
      ]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockReturnValue({});

      const result = listOrphanedPluginIds(PROJECT_PATH, ['known-plugin']);
      expect(result).toContain('orphan-plugin');
      expect(result).not.toContain('known-plugin');
    });

    it('finds orphaned plugin IDs from instruction markers', () => {
      vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('ENOENT'); });
      vi.mocked(agentSettings.readProjectAgentDefaults).mockReturnValue({
        instructions: '<!-- plugin:ghost-plugin:start -->\nHello\n<!-- plugin:ghost-plugin:end -->',
      });

      const result = listOrphanedPluginIds(PROJECT_PATH, ['other-plugin']);
      expect(result).toContain('ghost-plugin');
    });

    it('finds orphaned plugin IDs from permission rule comments', () => {
      vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('ENOENT'); });
      vi.mocked(agentSettings.readProjectAgentDefaults).mockReturnValue({
        permissions: { allow: ['Bash(read:**) /* plugin:ghost-plugin */'] },
      });

      const result = listOrphanedPluginIds(PROJECT_PATH, ['other-plugin']);
      expect(result).toContain('ghost-plugin');
    });

    it('does not flag known plugins as orphans', () => {
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: '_agentconfig:known-plugin', isDirectory: () => true } as any,
      ]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockReturnValue({
        instructions: '<!-- plugin:known-plugin:start -->\nHello\n<!-- plugin:known-plugin:end -->',
        permissions: { allow: ['Bash(read:**) /* plugin:known-plugin */'] },
      });

      const result = listOrphanedPluginIds(PROJECT_PATH, ['known-plugin']);
      expect(result).toEqual([]);
    });
  });
});
