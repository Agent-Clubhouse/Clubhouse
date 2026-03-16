import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-app' },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(() => Promise.reject(new Error('ENOENT'))),
  writeFile: vi.fn(() => Promise.resolve(undefined)),
  mkdir: vi.fn(() => Promise.resolve(undefined)),
  readdir: vi.fn(() => Promise.resolve([])),
  rm: vi.fn(() => Promise.resolve(undefined)),
  access: vi.fn(() => Promise.reject(new Error('ENOENT'))),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  promises: {
    readFile: vi.fn(() => Promise.reject(new Error('ENOENT'))),
    writeFile: vi.fn(() => Promise.resolve(undefined)),
    mkdir: vi.fn(() => Promise.resolve(undefined)),
    readdir: vi.fn(() => Promise.resolve([])),
    rm: vi.fn(() => Promise.resolve(undefined)),
    access: vi.fn(() => Promise.reject(new Error('ENOENT'))),
  },
}));

vi.mock('./fs-utils', () => ({
  pathExists: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('./plugin-manifest-registry', () => ({
  registerTrustedManifest: vi.fn(),
}));

import * as fsp from 'fs/promises';
import {
  getProjectConfigBreakdown,
  removePluginInjectionItem,
  parsePluginPrefix,
} from './config-provenance-service';

const PROJECT_PATH = '/project';

function mockSettingsFile(agentDefaults: Record<string, unknown> = {}): void {
  vi.mocked(fsp.readFile).mockImplementation(async (p: unknown) => {
    const filePath = String(p);
    if (filePath.includes('settings.json')) {
      return JSON.stringify({
        defaults: {},
        quickOverrides: {},
        agentDefaults,
      });
    }
    throw new Error('ENOENT');
  });
}

describe('config-provenance-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    vi.mocked(fsp.rm).mockResolvedValue(undefined);
  });

  describe('parsePluginPrefix', () => {
    it('returns null for non-plugin-prefixed names', () => {
      expect(parsePluginPrefix('mission')).toBeNull();
      expect(parsePluginPrefix('create-pr')).toBeNull();
      expect(parsePluginPrefix('my-custom-skill')).toBeNull();
    });

    it('parses simple plugin IDs', () => {
      expect(parsePluginPrefix('plugin-hub-tools')).toBe('hub');
    });

    it('parses hyphenated plugin IDs', () => {
      // For plugin-buddy-system-mission, the first candidate is 'buddy'
      // which is correct since we try shortest first
      const result = parsePluginPrefix('plugin-buddy-system-mission');
      expect(result).toBeTruthy();
    });

    it('returns null for bare plugin- prefix without item name', () => {
      // 'plugin-' alone has nothing after it
      expect(parsePluginPrefix('plugin-')).toBeNull();
    });
  });

  describe('getProjectConfigBreakdown', () => {
    it('returns empty breakdown when no defaults', async () => {
      mockSettingsFile({});

      const bd = await getProjectConfigBreakdown(PROJECT_PATH, []);

      expect(bd.userInstructions).toBe('');
      expect(bd.pluginInstructionBlocks).toHaveLength(0);
      expect(bd.allowRules).toHaveLength(0);
      expect(bd.denyRules).toHaveLength(0);
      expect(bd.skills).toHaveLength(0);
      expect(bd.agentTemplates).toHaveLength(0);
      expect(bd.mcpServers).toHaveLength(0);
    });

    it('separates user instructions from plugin blocks', async () => {
      const instructions = [
        'You are an agent.',
        '',
        '<!-- plugin:buddy-system:start -->',
        'Join the buddy system.',
        '<!-- plugin:buddy-system:end -->',
      ].join('\n');

      mockSettingsFile({ instructions });

      const bd = await getProjectConfigBreakdown(PROJECT_PATH, ['buddy-system']);

      expect(bd.userInstructions).toBe('You are an agent.');
      expect(bd.pluginInstructionBlocks).toHaveLength(1);
      expect(bd.pluginInstructionBlocks[0].provenance).toEqual({
        source: 'plugin',
        pluginId: 'buddy-system',
      });
      expect(bd.pluginInstructionBlocks[0].value).toBe('Join the buddy system.');
    });

    it('tags permission rules with plugin provenance', async () => {
      mockSettingsFile({
        permissions: {
          allow: [
            'Read(@@Path**)',
            'Bash(read:/tmp/**) /* plugin:buddy-system */',
          ],
          deny: ['Write(../**)'],
        },
      });

      const bd = await getProjectConfigBreakdown(PROJECT_PATH, ['buddy-system']);

      expect(bd.allowRules).toHaveLength(2);
      expect(bd.allowRules[0].provenance).toEqual({ source: 'user' });
      expect(bd.allowRules[1].provenance).toEqual({
        source: 'plugin',
        pluginId: 'buddy-system',
      });
      // Plugin tag should be stripped from display label
      expect(bd.allowRules[1].label).not.toContain('/* plugin:');
      expect(bd.denyRules).toHaveLength(1);
      expect(bd.denyRules[0].provenance).toEqual({ source: 'user' });
    });

    it('tags skills with correct provenance', async () => {
      mockSettingsFile({});

      // Mock source skills listing (normalize path separators for Windows)
      vi.mocked(fsp.readdir).mockImplementation(async (p: unknown) => {
        const dirPath = String(p).replace(/\\/g, '/');
        if (dirPath.includes('/skills')) {
          return [
            { name: 'mission', isDirectory: () => true },
            { name: 'plugin-hub-tools', isDirectory: () => true },
            { name: 'my-custom-skill', isDirectory: () => true },
          ] as any;
        }
        return [];
      });

      const bd = await getProjectConfigBreakdown(PROJECT_PATH, ['hub']);

      expect(bd.skills).toHaveLength(3);

      const missionSkill = bd.skills.find((s) => s.label === 'mission');
      expect(missionSkill?.provenance).toEqual({ source: 'built-in' });

      const pluginSkill = bd.skills.find((s) => s.label === 'plugin-hub-tools');
      expect(pluginSkill?.provenance).toEqual({ source: 'plugin', pluginId: 'hub' });

      const userSkill = bd.skills.find((s) => s.label === 'my-custom-skill');
      expect(userSkill?.provenance).toEqual({ source: 'user' });
    });

    it('tags MCP servers with correct provenance', async () => {
      mockSettingsFile({
        mcpJson: JSON.stringify({
          mcpServers: {
            'my-server': { command: 'node', args: ['server.js'] },
            'plugin-hub-api': { command: 'hub-api' },
          },
        }),
      });

      const bd = await getProjectConfigBreakdown(PROJECT_PATH, ['hub']);

      expect(bd.mcpServers).toHaveLength(2);

      const userServer = bd.mcpServers.find((s) => s.label === 'my-server');
      expect(userServer?.provenance).toEqual({ source: 'user' });

      const pluginServer = bd.mcpServers.find((s) => s.label === 'plugin-hub-api');
      expect(pluginServer?.provenance).toEqual({ source: 'plugin', pluginId: 'hub' });
    });

    it('detects orphaned plugin IDs', async () => {
      const instructions = [
        'User instructions.',
        '<!-- plugin:old-plugin:start -->',
        'Old plugin stuff.',
        '<!-- plugin:old-plugin:end -->',
      ].join('\n');

      mockSettingsFile({ instructions });

      const bd = await getProjectConfigBreakdown(PROJECT_PATH, ['active-plugin']);

      expect(bd.orphanedPluginIds).toContain('old-plugin');
    });
  });

  describe('removePluginInjectionItem', () => {
    it('removes a plugin instruction block', async () => {
      const instructions = [
        'User instructions.',
        '',
        '<!-- plugin:test-plugin:start -->',
        'Plugin content.',
        '<!-- plugin:test-plugin:end -->',
      ].join('\n');

      mockSettingsFile({ instructions });

      const result = await removePluginInjectionItem(PROJECT_PATH, 'instructions:plugin:test-plugin');

      expect(result).toBe(true);

      // Verify the write call stripped the block
      const writeCall = vi.mocked(fsp.writeFile).mock.calls.find(
        (call) => (call[0] as string).includes('settings.json'),
      );
      expect(writeCall).toBeDefined();
      const written = JSON.parse(writeCall![1] as string);
      expect(written.agentDefaults.instructions).not.toContain('<!-- plugin:test-plugin');
      expect(written.agentDefaults.instructions).toContain('User instructions.');
    });

    it('removes a permission allow rule by index', async () => {
      mockSettingsFile({
        permissions: {
          allow: ['Read(**)', 'Bash(test) /* plugin:foo */', 'Write(**)'],
          deny: [],
        },
      });

      const result = await removePluginInjectionItem(PROJECT_PATH, 'allow-rule:1');

      expect(result).toBe(true);

      const writeCall = vi.mocked(fsp.writeFile).mock.calls.find(
        (call) => (call[0] as string).includes('settings.json'),
      );
      expect(writeCall).toBeDefined();
      const written = JSON.parse(writeCall![1] as string);
      expect(written.agentDefaults.permissions.allow).toEqual(['Read(**)', 'Write(**)']);
    });

    it('removes a skill', async () => {
      mockSettingsFile({});

      const result = await removePluginInjectionItem(PROJECT_PATH, 'skill:plugin-test-tool');

      // The delete happens via fsp.rm
      expect(result).toBe(true);
      expect(fsp.rm).toHaveBeenCalled();
    });

    it('removes an MCP server', async () => {
      mockSettingsFile({
        mcpJson: JSON.stringify({
          mcpServers: {
            'user-server': { command: 'test' },
            'plugin-foo-api': { command: 'foo' },
          },
        }),
      });

      const result = await removePluginInjectionItem(PROJECT_PATH, 'mcp:plugin-foo-api');

      expect(result).toBe(true);

      const writeCall = vi.mocked(fsp.writeFile).mock.calls.find(
        (call) => (call[0] as string).includes('settings.json'),
      );
      expect(writeCall).toBeDefined();
      const written = JSON.parse(writeCall![1] as string);
      const mcpConfig = JSON.parse(written.agentDefaults.mcpJson);
      expect(mcpConfig.mcpServers['user-server']).toBeDefined();
      expect(mcpConfig.mcpServers['plugin-foo-api']).toBeUndefined();
    });

    it('returns false for unknown item categories', async () => {
      const result = await removePluginInjectionItem(PROJECT_PATH, 'unknown:item');
      expect(result).toBe(false);
    });

    it('returns false when instruction block not found', async () => {
      mockSettingsFile({ instructions: 'Just user content.' });

      const result = await removePluginInjectionItem(PROJECT_PATH, 'instructions:plugin:nonexistent');
      expect(result).toBe(false);
    });

    it('returns false for out-of-range permission index', async () => {
      mockSettingsFile({
        permissions: { allow: ['Read(**)'], deny: [] },
      });

      const result = await removePluginInjectionItem(PROJECT_PATH, 'allow-rule:5');
      expect(result).toBe(false);
    });
  });
});
