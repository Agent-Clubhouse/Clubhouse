import { describe, expect, it } from 'vitest';
import { parseMcpJson } from './mcp-config';

describe('desired MCP JSON validation', () => {
  it.each([
    { command: 'synthetic', args: ['one'], env: { KEY: 'value' }, env_vars: ['FORWARD'] },
    { type: 'stdio', command: 'synthetic' },
    { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'synthetic' } },
    { type: 'sse', url: 'https://example.invalid/sse' },
    { type: 'streamable-http', url: 'https://example.invalid/mcp' },
  ])('preserves a valid desired definition without a connection claim (%j)', (server) => {
    expect(parseMcpJson(JSON.stringify({ mcpServers: { example: server } }))).toEqual({ example: server });
  });
  it.each(['null', '[]', '{}', '{"mcpServers":[]}', '{"mcpServers":null}', '{broken'])('rejects malformed configuration (%s)', (raw) => {
    expect(() => parseMcpJson(raw)).toThrow(/MCP/);
  });
  it.each([null, {}, { command: '' }, { type: 'socket', url: 'secret' }, { command: 'synthetic', url: 'secret' }, { command: 'synthetic', args: [1] }, { command: 'synthetic', env: { KEY: 1 } }, { type: 'http', url: 'secret', headers: [] }])('rejects unsupported or invalid definitions without exposing values (%j)', (server) => {
    let message = '';
    try { parseMcpJson(JSON.stringify({ mcpServers: { example: server } })); } catch (err) { message = (err as Error).message; }
    expect(message).toMatch(/MCP server "example"/); expect(message).not.toContain('secret');
  });
  it('distinguishes an intentionally empty map from a malformed config', () => {
    expect(parseMcpJson('{"mcpServers":{}}')).toEqual({});
  });
});
