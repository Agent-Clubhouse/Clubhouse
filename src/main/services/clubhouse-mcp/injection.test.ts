import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clubhouse-test' },
}));

const mockGetSettings = vi.fn();
vi.mock('../experimental-settings', () => ({
  getSettings: () => mockGetSettings(),
}));

vi.mock('../log-service', () => ({
  appLog: vi.fn(),
}));

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

import { injectClubhouseMcp, isClubhouseMcpEntry, stripClubhouseMcp } from './injection';

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
      mockGetSettings.mockReturnValue({});
      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, 'nonce-1');
      // .mcp.json should not exist
      await expect(fsp.access(path.join(tmpDir, '.mcp.json'))).rejects.toThrow();
    });

    it('creates .mcp.json with clubhouse entry when feature is enabled', async () => {
      mockGetSettings.mockReturnValue({ clubhouseMcp: true });
      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, 'nonce-1');

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers.clubhouse).toBeDefined();
      expect(content.mcpServers.clubhouse.command).toBe('node');
      expect(content.mcpServers.clubhouse.env.CLUBHOUSE_MCP_PORT).toBe('12345');
      expect(content.mcpServers.clubhouse.env.CLUBHOUSE_AGENT_ID).toBe('agent-1');
      expect(content.mcpServers.clubhouse.env.CLUBHOUSE_HOOK_NONCE).toBe('nonce-1');
    });

    it('preserves existing MCP servers', async () => {
      mockGetSettings.mockReturnValue({ clubhouseMcp: true });
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
      mockGetSettings.mockReturnValue({ clubhouseMcp: true });
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
      mockGetSettings.mockReturnValue({ clubhouseMcp: true });
      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, 'nonce-1', {
        mcpConfigFile: 'custom-mcp.json',
      });

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, 'custom-mcp.json'), 'utf-8'));
      expect(content.mcpServers.clubhouse).toBeDefined();
    });

    it('handles malformed existing JSON gracefully', async () => {
      mockGetSettings.mockReturnValue({ clubhouseMcp: true });
      await fsp.writeFile(path.join(tmpDir, '.mcp.json'), 'not valid json!!!', 'utf-8');

      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, 'nonce-1');

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers.clubhouse).toBeDefined();
    });

    it('serializes concurrent injections (no clobbering)', async () => {
      mockGetSettings.mockReturnValue({ clubhouseMcp: true });

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
      mockGetSettings.mockReturnValue({ clubhouseMcp: true });
      const nestedDir = path.join(tmpDir, 'nested', 'deep');

      await injectClubhouseMcp(nestedDir, 'agent-1', 12345, 'nonce-1', {
        mcpConfigFile: '.mcp.json',
      });

      // Should NOT throw — directory was created
      const content = JSON.parse(await fsp.readFile(path.join(nestedDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers.clubhouse).toBeDefined();
    });

    it('no temp files left behind after injection', async () => {
      mockGetSettings.mockReturnValue({ clubhouseMcp: true });
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
});
