import { describe, it, expect } from 'vitest';
import {
  mcpServerToToml,
  jsonMcpToToml,
  stripMcpServerSection,
  injectMcpServerSection,
} from './toml-utils';

describe('toml-utils', () => {
  describe('mcpServerToToml', () => {
    it('serializes a basic server with command and args', () => {
      const toml = mcpServerToToml('my-server', {
        command: 'node',
        args: ['/path/to/script.js'],
      });
      expect(toml).toBe(
        '[mcp_servers.my-server]\n' +
        'command = "node"\n' +
        'args = ["/path/to/script.js"]',
      );
    });

    it('serializes a server with env vars', () => {
      const toml = mcpServerToToml('clubhouse', {
        command: 'node',
        args: ['/bridge.js'],
        env: {
          CLUBHOUSE_MCP_PORT: '12345',
          CLUBHOUSE_AGENT_ID: 'agent-1',
        },
      });
      expect(toml).toContain('[mcp_servers.clubhouse]');
      expect(toml).toContain('command = "node"');
      expect(toml).toContain('args = ["/bridge.js"]');
      expect(toml).toContain('[mcp_servers.clubhouse.env]');
      expect(toml).toContain('CLUBHOUSE_MCP_PORT = "12345"');
      expect(toml).toContain('CLUBHOUSE_AGENT_ID = "agent-1"');
    });

    it('includes type when present', () => {
      const toml = mcpServerToToml('test', {
        type: 'stdio',
        command: 'node',
        args: ['/test.js'],
      });
      expect(toml).toContain('type = "stdio"');
    });

    it('includes url when present', () => {
      const toml = mcpServerToToml('remote', {
        url: 'https://example.com/mcp',
      });
      expect(toml).toContain('url = "https://example.com/mcp"');
    });

    it('escapes special characters in strings', () => {
      const toml = mcpServerToToml('test', {
        command: 'path\\to\\bin',
        args: ['/path with "quotes"'],
      });
      expect(toml).toContain('command = "path\\\\to\\\\bin"');
      expect(toml).toContain('"/path with \\"quotes\\""');
    });

    it('handles empty args array', () => {
      const toml = mcpServerToToml('test', {
        command: 'node',
        args: [],
      });
      expect(toml).not.toContain('args');
    });

    it('handles server with no env', () => {
      const toml = mcpServerToToml('test', {
        command: 'node',
      });
      expect(toml).not.toContain('.env]');
    });

    it('handles server with empty env', () => {
      const toml = mcpServerToToml('test', {
        command: 'node',
        env: {},
      });
      expect(toml).not.toContain('.env]');
    });

    it('handles multiple args', () => {
      const toml = mcpServerToToml('test', {
        command: 'node',
        args: ['--flag', 'value', '/path'],
      });
      expect(toml).toContain('args = ["--flag", "value", "/path"]');
    });
  });

  describe('jsonMcpToToml', () => {
    it('converts a single server', () => {
      const json = JSON.stringify({
        mcpServers: {
          test: { command: 'node', args: ['/test.js'] },
        },
      });
      const toml = jsonMcpToToml(json);
      expect(toml).not.toBeNull();
      expect(toml).toContain('[mcp_servers.test]');
      expect(toml).toContain('command = "node"');
    });

    it('converts multiple servers', () => {
      const json = JSON.stringify({
        mcpServers: {
          server1: { command: 'node', args: ['/s1.js'] },
          server2: { command: 'python', args: ['/s2.py'] },
        },
      });
      const toml = jsonMcpToToml(json);
      expect(toml).toContain('[mcp_servers.server1]');
      expect(toml).toContain('[mcp_servers.server2]');
      expect(toml).toContain('command = "node"');
      expect(toml).toContain('command = "python"');
    });

    it('returns null for empty mcpServers', () => {
      const json = JSON.stringify({ mcpServers: {} });
      expect(jsonMcpToToml(json)).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      expect(jsonMcpToToml('not valid json')).toBeNull();
    });

    it('supports mcp_servers key (snake_case)', () => {
      const json = JSON.stringify({
        mcp_servers: {
          test: { command: 'node' },
        },
      });
      const toml = jsonMcpToToml(json);
      expect(toml).toContain('[mcp_servers.test]');
    });

    it('ends with a trailing newline', () => {
      const json = JSON.stringify({
        mcpServers: { test: { command: 'node' } },
      });
      const toml = jsonMcpToToml(json);
      expect(toml).not.toBeNull();
      expect(toml!.endsWith('\n')).toBe(true);
    });
  });

  describe('stripMcpServerSection', () => {
    it('removes a server section', () => {
      const toml = [
        '[mcp_servers.test]',
        'command = "node"',
        'args = ["/test.js"]',
        '',
        '[other_section]',
        'key = "value"',
      ].join('\n');
      const result = stripMcpServerSection(toml, 'test');
      expect(result).not.toContain('[mcp_servers.test]');
      expect(result).toContain('[other_section]');
      expect(result).toContain('key = "value"');
    });

    it('removes a server section and its env sub-section', () => {
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
      const result = stripMcpServerSection(toml, 'clubhouse');
      expect(result).not.toContain('[mcp_servers.clubhouse]');
      expect(result).not.toContain('[mcp_servers.clubhouse.env]');
      expect(result).not.toContain('KEY = "VALUE"');
      expect(result).toContain('[other_section]');
    });

    it('preserves other mcp_servers sections', () => {
      const toml = [
        '[mcp_servers.server1]',
        'command = "node"',
        '',
        '[mcp_servers.server2]',
        'command = "python"',
      ].join('\n');
      const result = stripMcpServerSection(toml, 'server1');
      expect(result).not.toContain('[mcp_servers.server1]');
      expect(result).toContain('[mcp_servers.server2]');
      expect(result).toContain('command = "python"');
    });

    it('handles missing server gracefully', () => {
      const toml = '[mcp_servers.other]\ncommand = "node"';
      const result = stripMcpServerSection(toml, 'nonexistent');
      expect(result).toBe(toml);
    });

    it('handles empty string', () => {
      expect(stripMcpServerSection('', 'test')).toBe('');
    });

    it('does not remove sections with similar name prefix', () => {
      const toml = [
        '[mcp_servers.test]',
        'command = "a"',
        '',
        '[mcp_servers.test_extended]',
        'command = "b"',
      ].join('\n');
      const result = stripMcpServerSection(toml, 'test');
      expect(result).not.toContain('[mcp_servers.test]');
      expect(result).toContain('[mcp_servers.test_extended]');
      expect(result).toContain('command = "b"');
    });
  });

  describe('injectMcpServerSection', () => {
    it('adds a new server section to empty content', () => {
      const result = injectMcpServerSection('', 'clubhouse', {
        command: 'node',
        args: ['/bridge.js'],
      });
      expect(result).toContain('[mcp_servers.clubhouse]');
      expect(result).toContain('command = "node"');
    });

    it('appends to existing content', () => {
      const existing = '[some_section]\nkey = "value"';
      const result = injectMcpServerSection(existing, 'clubhouse', {
        command: 'node',
      });
      expect(result).toContain('[some_section]');
      expect(result).toContain('key = "value"');
      expect(result).toContain('[mcp_servers.clubhouse]');
    });

    it('replaces existing server section', () => {
      const existing = [
        '[mcp_servers.clubhouse]',
        'command = "old-cmd"',
        '',
        '[mcp_servers.clubhouse.env]',
        'OLD_KEY = "old"',
        '',
        '[other]',
        'key = "value"',
      ].join('\n');
      const result = injectMcpServerSection(existing, 'clubhouse', {
        command: 'new-cmd',
        env: { NEW_KEY: 'new' },
      });
      expect(result).toContain('command = "new-cmd"');
      expect(result).toContain('NEW_KEY = "new"');
      expect(result).not.toContain('command = "old-cmd"');
      expect(result).not.toContain('OLD_KEY = "old"');
      expect(result).toContain('[other]');
    });

    it('result ends with newline', () => {
      const result = injectMcpServerSection('', 'test', {
        command: 'node',
      });
      expect(result.endsWith('\n')).toBe(true);
    });

    it('handles injection with full server def including env', () => {
      const result = injectMcpServerSection('', 'clubhouse', {
        command: 'node',
        args: ['/bridge.js'],
        env: {
          CLUBHOUSE_MCP_PORT: '12345',
          CLUBHOUSE_AGENT_ID: 'agent-1',
          CLUBHOUSE_HOOK_NONCE: 'nonce-1',
        },
      });
      expect(result).toContain('[mcp_servers.clubhouse]');
      expect(result).toContain('[mcp_servers.clubhouse.env]');
      expect(result).toContain('CLUBHOUSE_MCP_PORT = "12345"');
      expect(result).toContain('CLUBHOUSE_AGENT_ID = "agent-1"');
      expect(result).toContain('CLUBHOUSE_HOOK_NONCE = "nonce-1"');
    });
  });
});
