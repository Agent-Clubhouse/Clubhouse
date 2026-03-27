import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clubhouse-test' },
}));

const mockIsMcpEnabled = vi.fn();
vi.mock('../mcp-settings', () => ({
  isMcpEnabled: () => mockIsMcpEnabled(),
}));

vi.mock('../log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

vi.mock('../fs-utils', () => ({
  pathExists: vi.fn(async (p: string) => {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  }),
}));

import { injectClubhouseMcp, isClubhouseMcpEntry, stripClubhouseMcp, stripClubhouseMcpToml, buildClubhouseMcpDef } from './injection';

describe('MCP Injection', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-injection-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  describe('injectClubhouseMcp', () => {
    it('does nothing when feature is disabled', async () => {
      mockIsMcpEnabled.mockReturnValue(false);
      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, 'nonce-1');
      // .mcp.json should not exist
      await expect(fsp.access(path.join(tmpDir, '.mcp.json'))).rejects.toThrow();
    });

    it('creates .mcp.json with clubhouse entry when feature is enabled', async () => {
      mockIsMcpEnabled.mockReturnValue(true);
      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, 'nonce-1');

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers.clubhouse).toBeDefined();
      expect(content.mcpServers.clubhouse.command).toBe('node');
      expect(content.mcpServers.clubhouse.env.CLUBHOUSE_MCP_PORT).toBe('12345');
      expect(content.mcpServers.clubhouse.env.CLUBHOUSE_AGENT_ID).toBe('agent-1');
      expect(content.mcpServers.clubhouse.env.CLUBHOUSE_HOOK_NONCE).toBe('nonce-1');
    });

    it('preserves existing MCP servers', async () => {
      mockIsMcpEnabled.mockReturnValue(true);
      const existing = {
        mcpServers: {
          'my-server': { command: 'my-cmd', args: ['--flag'] },
        },
      };
      await fsp.writeFile(path.join(tmpDir, '.mcp.json'), JSON.stringify(existing), 'utf-8');

      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, 'nonce-1');

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers['my-server']).toBeDefined();
      expect(content.mcpServers.clubhouse).toBeDefined();
    });

    it('overwrites existing clubhouse entry', async () => {
      mockIsMcpEnabled.mockReturnValue(true);
      const existing = {
        mcpServers: {
          clubhouse: { command: 'old', args: [] },
        },
      };
      await fsp.writeFile(path.join(tmpDir, '.mcp.json'), JSON.stringify(existing), 'utf-8');

      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, 'nonce-1');

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers.clubhouse.command).toBe('node');
    });

    it('uses custom conventions for config file path', async () => {
      mockIsMcpEnabled.mockReturnValue(true);
      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, 'nonce-1', {
        mcpConfigFile: 'custom-mcp.json',
      });

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, 'custom-mcp.json'), 'utf-8'));
      expect(content.mcpServers.clubhouse).toBeDefined();
    });

    it('handles malformed existing JSON gracefully', async () => {
      mockIsMcpEnabled.mockReturnValue(true);
      await fsp.writeFile(path.join(tmpDir, '.mcp.json'), 'not valid json!!!', 'utf-8');

      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, 'nonce-1');

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers.clubhouse).toBeDefined();
    });

    it('serializes concurrent injections (no clobbering)', async () => {
      mockIsMcpEnabled.mockReturnValue(true);

      // Run 3 injections concurrently
      await Promise.all([
        injectClubhouseMcp(tmpDir, 'agent-A', 10001, 'nonce-a'),
        injectClubhouseMcp(tmpDir, 'agent-B', 10002, 'nonce-b'),
        injectClubhouseMcp(tmpDir, 'agent-C', 10003, 'nonce-c'),
      ]);

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      // Because of the mutex, the last writer wins, and only one entry
      // should exist — but the file should be valid JSON, not corrupted
      expect(content.mcpServers).toBeDefined();
      expect(content.mcpServers.clubhouse).toBeDefined();
      // The clubhouse entry should be valid (from the last injection in serial order)
      expect(content.mcpServers.clubhouse.command).toBe('node');
    });

    it('creates parent directory if it does not exist', async () => {
      mockIsMcpEnabled.mockReturnValue(true);
      const nestedDir = path.join(tmpDir, 'nested', 'deep');

      await injectClubhouseMcp(nestedDir, 'agent-1', 12345, 'nonce-1', {
        mcpConfigFile: '.mcp.json',
      });

      // Should NOT throw — directory was created
      const content = JSON.parse(await fsp.readFile(path.join(nestedDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers.clubhouse).toBeDefined();
    });

    it('injects TOML MCP config for TOML config format (Codex CLI)', async () => {
      mockIsMcpEnabled.mockReturnValue(true);
      const codexDir = path.join(tmpDir, '.codex');
      await fsp.mkdir(codexDir, { recursive: true });

      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, 'nonce-1', {
        configDir: '.codex',
        mcpConfigFile: '.codex/config.toml',
        settingsFormat: 'toml',
      });

      const content = await fsp.readFile(path.join(tmpDir, '.codex', 'config.toml'), 'utf-8');
      expect(content).toContain('[mcp_servers.clubhouse]');
      expect(content).toContain('command = "node"');
      expect(content).toContain('CLUBHOUSE_MCP_PORT = "12345"');
      expect(content).toContain('CLUBHOUSE_AGENT_ID = "agent-1"');
      expect(content).toContain('CLUBHOUSE_HOOK_NONCE = "nonce-1"');
    });

    it('preserves existing TOML content when injecting', async () => {
      mockIsMcpEnabled.mockReturnValue(true);
      const codexDir = path.join(tmpDir, '.codex');
      await fsp.mkdir(codexDir, { recursive: true });
      await fsp.writeFile(
        path.join(codexDir, 'config.toml'),
        '[mcp_servers.existing]\ncommand = "other"\n',
        'utf-8',
      );

      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, 'nonce-1', {
        configDir: '.codex',
        mcpConfigFile: '.codex/config.toml',
        settingsFormat: 'toml',
      });

      const content = await fsp.readFile(path.join(codexDir, 'config.toml'), 'utf-8');
      expect(content).toContain('[mcp_servers.existing]');
      expect(content).toContain('[mcp_servers.clubhouse]');
    });

    it('replaces existing clubhouse section in TOML', async () => {
      mockIsMcpEnabled.mockReturnValue(true);
      const codexDir = path.join(tmpDir, '.codex');
      await fsp.mkdir(codexDir, { recursive: true });
      await fsp.writeFile(
        path.join(codexDir, 'config.toml'),
        '[mcp_servers.clubhouse]\ncommand = "old"\n',
        'utf-8',
      );

      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, 'nonce-1', {
        configDir: '.codex',
        mcpConfigFile: '.codex/config.toml',
        settingsFormat: 'toml',
      });

      const content = await fsp.readFile(path.join(codexDir, 'config.toml'), 'utf-8');
      expect(content).not.toContain('command = "old"');
      expect(content).toContain('command = "node"');
    });

    it('still injects for JSON config format', async () => {
      mockIsMcpEnabled.mockReturnValue(true);
      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, 'nonce-1', {
        configDir: '.claude',
        mcpConfigFile: '.mcp.json',
        settingsFormat: 'json',
      });

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers.clubhouse).toBeDefined();
    });

    it('no temp files left behind after injection', async () => {
      mockIsMcpEnabled.mockReturnValue(true);
      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, 'nonce-1');

      const files = await fsp.readdir(tmpDir);
      const tmpFiles = files.filter(f => f.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe('isClubhouseMcpEntry', () => {
    it('detects clubhouse bridge entries', () => {
      expect(isClubhouseMcpEntry({
        command: 'node',
        args: ['/path/to/clubhouse-mcp-bridge.js'],
      })).toBe(true);
    });

    it('rejects non-clubhouse entries', () => {
      expect(isClubhouseMcpEntry({
        command: 'node',
        args: ['/path/to/other-server.js'],
      })).toBe(false);
    });

    it('rejects non-node entries', () => {
      expect(isClubhouseMcpEntry({
        command: 'python',
        args: ['clubhouse-mcp-bridge.js'],
      })).toBe(false);
    });

    it('handles null/undefined', () => {
      expect(isClubhouseMcpEntry(null)).toBe(false);
      expect(isClubhouseMcpEntry(undefined)).toBe(false);
    });
  });

  describe('stripClubhouseMcp', () => {
    it('removes clubhouse entry from config', () => {
      const config = {
        mcpServers: {
          clubhouse: { command: 'node', args: ['clubhouse-mcp-bridge.js'] },
          'my-server': { command: 'my-cmd', args: [] },
        },
      };
      const result = stripClubhouseMcp(config);
      expect(result.mcpServers).toBeDefined();
      expect((result.mcpServers as Record<string, unknown>)['clubhouse']).toBeUndefined();
      expect((result.mcpServers as Record<string, unknown>)['my-server']).toBeDefined();
    });

    it('returns config unchanged when no mcpServers', () => {
      const config = { someOther: 'value' };
      expect(stripClubhouseMcp(config)).toEqual(config);
    });
  });

  describe('stripClubhouseMcpToml', () => {
    it('removes clubhouse section from TOML', () => {
      const toml = [
        '[mcp_servers.clubhouse]',
        'command = "node"',
        '',
        '[mcp_servers.clubhouse.env]',
        'KEY = "VALUE"',
        '',
        '[other_section]',
        'key = "value"',
      ].join('\n');
      const result = stripClubhouseMcpToml(toml);
      expect(result).not.toContain('[mcp_servers.clubhouse]');
      expect(result).not.toContain('KEY = "VALUE"');
      expect(result).toContain('[other_section]');
    });

    it('preserves other MCP servers', () => {
      const toml = [
        '[mcp_servers.clubhouse]',
        'command = "node"',
        '',
        '[mcp_servers.other]',
        'command = "python"',
      ].join('\n');
      const result = stripClubhouseMcpToml(toml);
      expect(result).not.toContain('[mcp_servers.clubhouse]');
      expect(result).toContain('[mcp_servers.other]');
    });

    it('handles TOML without clubhouse section', () => {
      const toml = '[mcp_servers.other]\ncommand = "node"';
      expect(stripClubhouseMcpToml(toml)).toBe(toml);
    });
  });

  describe('buildClubhouseMcpDef', () => {
    it('returns a valid MCP server definition with type stdio', () => {
      const def = buildClubhouseMcpDef(12345, 'agent-1', 'nonce-1');
      expect(def.type).toBe('stdio');
      expect(def.command).toBe('node');
      expect(def.args).toBeDefined();
      expect(def.args!.length).toBe(1);
      expect(def.args![0]).toContain('clubhouse-mcp-bridge');
      expect(def.env).toEqual({
        CLUBHOUSE_MCP_PORT: '12345',
        CLUBHOUSE_AGENT_ID: 'agent-1',
        CLUBHOUSE_HOOK_NONCE: 'nonce-1',
      });
    });
  });
});
