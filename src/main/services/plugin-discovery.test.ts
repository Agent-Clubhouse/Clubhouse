import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
  unlink: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('./fs-utils', () => ({
  pathExists: vi.fn(),
}));

vi.mock('./plugin-manifest-registry', () => ({
  registerTrustedManifest: vi.fn(),
}));

vi.mock('./agent-settings-service', () => ({
  listSourceSkills: vi.fn(async () => []),
  listSourceAgentTemplates: vi.fn(async () => []),
  deleteSourceSkill: vi.fn(async () => undefined),
  deleteSourceAgentTemplate: vi.fn(async () => undefined),
  readProjectAgentDefaults: vi.fn(async () => ({})),
  writeProjectAgentDefaults: vi.fn(async () => undefined),
}));

import * as fsp from 'fs/promises';
import { pathExists } from './fs-utils';
import * as agentSettings from './agent-settings-service';
import { registerTrustedManifest } from './plugin-manifest-registry';
import {
  discoverCommunityPlugins,
  refreshManifestFromDisk,
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
    it('returns empty array when plugins dir does not exist', async () => {
      vi.mocked(pathExists).mockResolvedValue(false);
      expect(await discoverCommunityPlugins()).toEqual([]);
    });

    it('discovers plugins with valid manifest.json', async () => {
      vi.mocked(pathExists).mockImplementation(async (p: any) => {
        const s = String(p);
        if (s === PLUGINS_DIR) return true;
        if (s.endsWith('manifest.json')) return true;
        return false;
      });
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'my-plugin', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
        id: 'my-plugin',
        name: 'My Plugin',
        version: '1.0.0',
        engine: { api: 0.1 },
        scope: 'project',
      }));

      const result = await discoverCommunityPlugins();
      expect(result).toHaveLength(1);
      expect(result[0].manifest.id).toBe('my-plugin');
      expect(result[0].pluginPath).toBe(path.join(PLUGINS_DIR, 'my-plugin'));
      expect(result[0].fromMarketplace).toBe(false);
    });

    it('sets fromMarketplace true when .marketplace marker exists', async () => {
      vi.mocked(pathExists).mockImplementation(async (p: any) => {
        const s = String(p);
        if (s === PLUGINS_DIR) return true;
        if (s.endsWith('manifest.json')) return true;
        if (s.endsWith('.marketplace')) return true;
        return false;
      });
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'market-plugin', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
        id: 'market-plugin',
        name: 'Market Plugin',
        version: '1.0.0',
        engine: { api: 0.5 },
        scope: 'project',
      }));

      const result = await discoverCommunityPlugins();
      expect(result).toHaveLength(1);
      expect(result[0].fromMarketplace).toBe(true);
    });

    it('sets fromMarketplace false when .marketplace marker is absent', async () => {
      vi.mocked(pathExists).mockImplementation(async (p: any) => {
        const s = String(p);
        if (s === PLUGINS_DIR) return true;
        if (s.endsWith('manifest.json')) return true;
        if (s.endsWith('.marketplace')) return false;
        return false;
      });
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'local-plugin', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
        id: 'local-plugin',
        name: 'Local Plugin',
        version: '1.0.0',
        engine: { api: 0.5 },
        scope: 'project',
      }));

      const result = await discoverCommunityPlugins();
      expect(result).toHaveLength(1);
      expect(result[0].fromMarketplace).toBe(false);
    });

    it('skips non-directory entries', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'readme.md', isDirectory: () => false, isSymbolicLink: () => false },
      ] as any);

      const result = await discoverCommunityPlugins();
      expect(result).toEqual([]);
    });

    it('skips directories without manifest.json', async () => {
      vi.mocked(pathExists).mockImplementation(async (p: any) => {
        const s = String(p);
        if (s === PLUGINS_DIR) return true;
        if (s.endsWith('manifest.json')) return false;
        return false;
      });
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'incomplete', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);

      const result = await discoverCommunityPlugins();
      expect(result).toEqual([]);
    });

    it('skips plugins with invalid JSON', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'bad-json', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fsp.readFile).mockResolvedValue('{{not valid json');

      const result = await discoverCommunityPlugins();
      expect(result).toEqual([]);
    });

    it('discovers multiple plugins', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'plugin-a', isDirectory: () => true, isSymbolicLink: () => false },
        { name: 'plugin-b', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
        const s = String(p);
        if (s.includes('plugin-a')) {
          return JSON.stringify({ id: 'plugin-a', name: 'A', version: '1.0.0', engine: { api: 0.1 }, scope: 'project' });
        }
        return JSON.stringify({ id: 'plugin-b', name: 'B', version: '2.0.0', engine: { api: 0.1 }, scope: 'app' });
      });

      const result = await discoverCommunityPlugins();
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.manifest.id)).toEqual(['plugin-a', 'plugin-b']);
    });

    it('discovers symlinked plugin directories', async () => {
      vi.mocked(pathExists).mockImplementation(async (p: any) => {
        const s = String(p);
        if (s === PLUGINS_DIR) return true;
        if (s.endsWith('manifest.json')) return true;
        return false;
      });
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'my-plugin', isDirectory: () => false, isSymbolicLink: () => true },
      ] as any);
      vi.mocked(fsp.stat).mockResolvedValue({ isDirectory: () => true } as any);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
        id: 'my-plugin',
        name: 'My Plugin',
        version: '1.0.0',
        engine: { api: 0.1 },
        scope: 'project',
      }));

      const result = await discoverCommunityPlugins();
      expect(result).toHaveLength(1);
      expect(result[0].manifest.id).toBe('my-plugin');
      expect(fsp.stat).toHaveBeenCalledWith(path.join(PLUGINS_DIR, 'my-plugin'));
    });

    it('skips symlinks pointing to non-directories', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'some-file', isDirectory: () => false, isSymbolicLink: () => true },
      ] as any);
      vi.mocked(fsp.stat).mockResolvedValue({ isDirectory: () => false } as any);

      const result = await discoverCommunityPlugins();
      expect(result).toEqual([]);
    });

    it('skips broken symlinks', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'broken-link', isDirectory: () => false, isSymbolicLink: () => true },
      ] as any);
      vi.mocked(fsp.stat).mockRejectedValue(new Error('ENOENT'));

      const result = await discoverCommunityPlugins();
      expect(result).toEqual([]);
    });

    it('handles unreadable plugins dir gracefully', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readdir).mockRejectedValue(new Error('EACCES'));
      expect(await discoverCommunityPlugins()).toEqual([]);
    });
  });

  describe('uninstallPlugin', () => {
    it('removes plugin directory recursively with async rm', async () => {
      vi.mocked(fsp.lstat).mockResolvedValue({
        isSymbolicLink: () => false,
      } as any);
      vi.mocked(fsp.rm).mockResolvedValue(undefined);

      await uninstallPlugin('my-plugin');

      expect(fsp.rm).toHaveBeenCalledWith(
        path.join(PLUGINS_DIR, 'my-plugin'),
        { recursive: true, force: true },
      );
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('removes only the symlink when plugin is a symlink', async () => {
      vi.mocked(fsp.lstat).mockResolvedValue({
        isSymbolicLink: () => true,
      } as any);
      vi.mocked(fsp.unlink).mockResolvedValue(undefined);
      vi.mocked(fsp.rm).mockResolvedValue(undefined);

      await uninstallPlugin('linked-plugin');

      expect(fsp.unlink).toHaveBeenCalledWith(
        path.join(PLUGINS_DIR, 'linked-plugin'),
      );
      // rm is still called for data dir cleanup
      expect(fsp.rm).toHaveBeenCalledWith(
        path.join(PLUGIN_DATA_DIR, 'linked-plugin'),
        { recursive: true, force: true },
      );
    });

    it('does nothing when plugin path does not exist', async () => {
      vi.mocked(fsp.lstat).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      await uninstallPlugin('nonexistent');

      expect(fsp.rm).not.toHaveBeenCalled();
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('cleans up plugin data directory on uninstall', async () => {
      vi.mocked(fsp.lstat).mockResolvedValue({
        isSymbolicLink: () => false,
      } as any);
      vi.mocked(fsp.rm).mockResolvedValue(undefined);

      await uninstallPlugin('my-plugin');

      expect(fsp.rm).toHaveBeenCalledWith(
        path.join(PLUGIN_DATA_DIR, 'my-plugin'),
        { recursive: true, force: true },
      );
    });

    it('does not fail if data directory cleanup throws', async () => {
      vi.mocked(fsp.lstat).mockResolvedValue({
        isSymbolicLink: () => false,
      } as any);
      let callCount = 0;
      vi.mocked(fsp.rm).mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error('ENOENT');
      });

      // Should not throw even if data dir rm fails
      await expect(uninstallPlugin('my-plugin')).resolves.toBeUndefined();
    });
  });

  describe('listProjectPluginInjections', () => {
    const PROJECT_PATH = '/my/project';

    it('returns empty result when no injections exist', async () => {
      vi.mocked(agentSettings.listSourceSkills).mockResolvedValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockResolvedValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockResolvedValue({});

      const result = await listProjectPluginInjections('my-plugin', PROJECT_PATH);
      expect(result).toEqual({
        skills: [],
        agentTemplates: [],
        hasInstructions: false,
        permissionAllowCount: 0,
        permissionDenyCount: 0,
        mcpServerNames: [],
      });
    });

    it('returns injected skills (stripping prefix)', async () => {
      vi.mocked(agentSettings.listSourceSkills).mockResolvedValue([
        { name: 'plugin-my-plugin-skill-one', path: '/p', hasReadme: false },
        { name: 'plugin-my-plugin-skill-two', path: '/p', hasReadme: false },
        { name: 'other-skill', path: '/p', hasReadme: false },
      ]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockResolvedValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockResolvedValue({});

      const result = await listProjectPluginInjections('my-plugin', PROJECT_PATH);
      expect(result.skills).toEqual(['skill-one', 'skill-two']);
    });

    it('returns injected agent templates (stripping prefix)', async () => {
      vi.mocked(agentSettings.listSourceSkills).mockResolvedValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockResolvedValue([
        { name: 'plugin-my-plugin-my-template', path: '/p', hasReadme: false },
      ]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockResolvedValue({});

      const result = await listProjectPluginInjections('my-plugin', PROJECT_PATH);
      expect(result.agentTemplates).toEqual(['my-template']);
    });

    it('detects instructions block', async () => {
      vi.mocked(agentSettings.listSourceSkills).mockResolvedValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockResolvedValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockResolvedValue({
        instructions: '<!-- plugin:my-plugin:start -->\nHello\n<!-- plugin:my-plugin:end -->',
      });

      const result = await listProjectPluginInjections('my-plugin', PROJECT_PATH);
      expect(result.hasInstructions).toBe(true);
    });

    it('counts permission rules', async () => {
      vi.mocked(agentSettings.listSourceSkills).mockResolvedValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockResolvedValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockResolvedValue({
        permissions: {
          allow: ['Bash(read:**) /* plugin:my-plugin */'],
          deny: ['Bash(write:/etc/**) /* plugin:my-plugin */', 'Bash(rm:**) /* plugin:my-plugin */'],
        },
      });

      const result = await listProjectPluginInjections('my-plugin', PROJECT_PATH);
      expect(result.permissionAllowCount).toBe(1);
      expect(result.permissionDenyCount).toBe(2);
    });

    it('lists MCP server names (stripping prefix)', async () => {
      vi.mocked(agentSettings.listSourceSkills).mockResolvedValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockResolvedValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockResolvedValue({
        mcpJson: JSON.stringify({ mcpServers: { 'plugin-my-plugin-server': {}, 'other-server': {} } }),
      });

      const result = await listProjectPluginInjections('my-plugin', PROJECT_PATH);
      expect(result.mcpServerNames).toEqual(['server']);
    });
  });

  describe('cleanupProjectPluginInjections', () => {
    const PROJECT_PATH = '/my/project';

    beforeEach(() => {
      vi.mocked(fsp.rm).mockResolvedValue(undefined);
    });

    it('deletes source skills with the plugin prefix', async () => {
      vi.mocked(agentSettings.listSourceSkills).mockResolvedValue([
        { name: 'plugin-my-plugin-skill', path: '/p', hasReadme: false },
        { name: 'other-skill', path: '/p', hasReadme: false },
      ]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockResolvedValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockResolvedValue({});

      await cleanupProjectPluginInjections('my-plugin', PROJECT_PATH);

      expect(agentSettings.deleteSourceSkill).toHaveBeenCalledWith(PROJECT_PATH, 'plugin-my-plugin-skill');
      expect(agentSettings.deleteSourceSkill).not.toHaveBeenCalledWith(PROJECT_PATH, 'other-skill');
    });

    it('strips instruction block and writes back defaults', async () => {
      vi.mocked(agentSettings.listSourceSkills).mockResolvedValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockResolvedValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockResolvedValue({
        instructions: 'Before\n\n<!-- plugin:my-plugin:start -->\nContent\n<!-- plugin:my-plugin:end -->',
      });

      await cleanupProjectPluginInjections('my-plugin', PROJECT_PATH);

      expect(agentSettings.writeProjectAgentDefaults).toHaveBeenCalledWith(
        PROJECT_PATH,
        expect.objectContaining({ instructions: 'Before' }),
      );
    });

    it('removes tagged permission rules', async () => {
      vi.mocked(agentSettings.listSourceSkills).mockResolvedValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockResolvedValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockResolvedValue({
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
      vi.mocked(agentSettings.listSourceSkills).mockResolvedValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockResolvedValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockResolvedValue({
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
      vi.mocked(agentSettings.listSourceSkills).mockResolvedValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockResolvedValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockResolvedValue({});

      await cleanupProjectPluginInjections('my-plugin', PROJECT_PATH);

      expect(fsp.rm).toHaveBeenCalledWith(
        path.join(PROJECT_PATH, '.clubhouse', 'plugin-data', '_agentconfig:my-plugin'),
        { recursive: true, force: true },
      );
    });

    it('does not write defaults when nothing changed', async () => {
      vi.mocked(agentSettings.listSourceSkills).mockResolvedValue([]);
      vi.mocked(agentSettings.listSourceAgentTemplates).mockResolvedValue([]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockResolvedValue({
        instructions: 'No plugin markers here',
      });

      await cleanupProjectPluginInjections('my-plugin', PROJECT_PATH);

      expect(agentSettings.writeProjectAgentDefaults).not.toHaveBeenCalled();
    });
  });

  describe('listOrphanedPluginIds', () => {
    const PROJECT_PATH = '/my/project';

    it('returns empty array when no plugin-data dir exists', async () => {
      vi.mocked(fsp.readdir).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(agentSettings.readProjectAgentDefaults).mockResolvedValue({});

      const result = await listOrphanedPluginIds(PROJECT_PATH, ['plugin-a']);
      expect(result).toEqual([]);
    });

    it('finds orphaned _agentconfig directories', async () => {
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: '_agentconfig:orphan-plugin', isDirectory: () => true } as any,
        { name: '_agentconfig:known-plugin', isDirectory: () => true } as any,
        { name: 'other-dir', isDirectory: () => true } as any,
      ]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockResolvedValue({});

      const result = await listOrphanedPluginIds(PROJECT_PATH, ['known-plugin']);
      expect(result).toContain('orphan-plugin');
      expect(result).not.toContain('known-plugin');
    });

    it('finds orphaned plugin IDs from instruction markers', async () => {
      vi.mocked(fsp.readdir).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(agentSettings.readProjectAgentDefaults).mockResolvedValue({
        instructions: '<!-- plugin:ghost-plugin:start -->\nHello\n<!-- plugin:ghost-plugin:end -->',
      });

      const result = await listOrphanedPluginIds(PROJECT_PATH, ['other-plugin']);
      expect(result).toContain('ghost-plugin');
    });

    it('finds orphaned plugin IDs from permission rule comments', async () => {
      vi.mocked(fsp.readdir).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(agentSettings.readProjectAgentDefaults).mockResolvedValue({
        permissions: { allow: ['Bash(read:**) /* plugin:ghost-plugin */'] },
      });

      const result = await listOrphanedPluginIds(PROJECT_PATH, ['other-plugin']);
      expect(result).toContain('ghost-plugin');
    });

    it('does not flag known plugins as orphans', async () => {
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: '_agentconfig:known-plugin', isDirectory: () => true } as any,
      ]);
      vi.mocked(agentSettings.readProjectAgentDefaults).mockResolvedValue({
        instructions: '<!-- plugin:known-plugin:start -->\nHello\n<!-- plugin:known-plugin:end -->',
        permissions: { allow: ['Bash(read:**) /* plugin:known-plugin */'] },
      });

      const result = await listOrphanedPluginIds(PROJECT_PATH, ['known-plugin']);
      expect(result).toEqual([]);
    });
  });

  // ── Trusted manifest registration during discovery ─────────────────

  describe('trusted manifest registration', () => {
    it('registers discovered manifests as trusted during discovery', async () => {
      vi.mocked(pathExists).mockImplementation(async (p: any) => {
        const s = String(p);
        if (s === PLUGINS_DIR) return true;
        if (s.endsWith('manifest.json')) return true;
        return false;
      });
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'my-plugin', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
        id: 'my-plugin',
        name: 'My Plugin',
        version: '1.0.0',
        engine: { api: 0.5 },
        scope: 'project',
        allowedCommands: ['git'],
      }));

      await discoverCommunityPlugins();

      expect(registerTrustedManifest).toHaveBeenCalledWith('my-plugin', expect.objectContaining({
        id: 'my-plugin',
        allowedCommands: ['git'],
      }));
    });

    it('does not register manifest without an id', async () => {
      vi.mocked(pathExists).mockImplementation(async (p: any) => {
        const s = String(p);
        if (s === PLUGINS_DIR) return true;
        if (s.endsWith('manifest.json')) return true;
        return false;
      });
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'no-id-plugin', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
        name: 'No ID',
        version: '1.0.0',
        engine: { api: 0.5 },
        scope: 'project',
      }));

      await discoverCommunityPlugins();

      expect(registerTrustedManifest).not.toHaveBeenCalled();
    });
  });

  // ── refreshManifestFromDisk ──────────────────────────────────────────

  describe('refreshManifestFromDisk', () => {
    it('reads manifest from disk and registers as trusted', async () => {
      vi.mocked(fsp.realpath).mockImplementation(async (p: any) => String(p));
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
        id: 'my-plugin',
        name: 'My Plugin',
        version: '2.0.0',
        engine: { api: 0.5 },
        scope: 'project',
        allowedCommands: ['node'],
      }));

      const result = await refreshManifestFromDisk('my-plugin');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('my-plugin');
      expect(result!.allowedCommands).toEqual(['node']);
      expect(registerTrustedManifest).toHaveBeenCalledWith('my-plugin', expect.objectContaining({
        id: 'my-plugin',
        allowedCommands: ['node'],
      }));
    });

    it('returns null when manifest file does not exist', async () => {
      vi.mocked(fsp.realpath).mockImplementation(async (p: any) => String(p));
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));

      const result = await refreshManifestFromDisk('nonexistent-plugin');

      expect(result).toBeNull();
      expect(registerTrustedManifest).not.toHaveBeenCalled();
    });

    it('returns null for path traversal attempts', async () => {
      // Simulate a pluginId that resolves outside the plugins directory
      vi.mocked(fsp.realpath).mockImplementation(async (p: any) => {
        const s = String(p);
        if (s.includes('plugins') && !s.includes('..')) return s;
        return '/etc/evil';
      });

      const result = await refreshManifestFromDisk('../../../etc/passwd');

      expect(result).toBeNull();
      expect(registerTrustedManifest).not.toHaveBeenCalled();
    });

    it('returns null for invalid JSON in manifest', async () => {
      vi.mocked(fsp.realpath).mockImplementation(async (p: any) => String(p));
      vi.mocked(fsp.readFile).mockResolvedValue('{{invalid json');

      const result = await refreshManifestFromDisk('bad-plugin');

      expect(result).toBeNull();
    });
  });
});
