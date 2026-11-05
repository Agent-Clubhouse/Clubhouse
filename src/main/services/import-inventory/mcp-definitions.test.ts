import { describe, it, expect, vi } from 'vitest';

vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { parseJsonMcpServers, parseTomlMcpServers, readMcpEntry } from './mcp-definitions';

describe('parseTomlMcpServers', () => {
  it('reads quoted server names, literal strings and nested tables', () => {
    const servers = parseTomlMcpServers([
      '[mcp_servers."dotted.name"]',
      "command = 'literal'",
      '[mcp_servers.other.http_headers]',
      'Authorization = "x"',
    ].join('\n'));

    expect(servers).toEqual({
      'dotted.name': { command: 'literal' },
      other: { http_headers: { Authorization: 'x' } },
    });
  });

  it('reads dotted keys and non-string values', () => {
    const servers = parseTomlMcpServers('[mcp_servers.a]\ncommand = "x"\nenv.TOKEN = "v"\nenabled = true\nstartup_timeout_sec = 20\n');

    expect(servers).toEqual({ a: { command: 'x', env: { TOKEN: 'v' }, enabled: 'true', startup_timeout_sec: '20' } });
  });

  it('skips a line it can\'t read and keeps going', () => {
    const servers = parseTomlMcpServers('[mcp_servers.a]\ncommand "no equals"\nbroken = "unterminated\nurl = "https://example.com"\n');

    expect(servers).toEqual({ a: { url: 'https://example.com' } });
  });

  it('parses past multi-line strings and array tables outside the MCP tables', () => {
    const servers = parseTomlMcpServers('note = """\n[mcp_servers.fake]\ncommand = "x"\n"""\n[[things]]\nname = "y"\n[mcp_servers.real]\ncommand = "z"\n');

    expect(servers).toEqual({ real: { command: 'z' } });
  });

  it('returns nothing for a file with no MCP tables, or that isn\'t TOML', () => {
    expect(parseTomlMcpServers('model = "x"\n')).toEqual({});
    expect(parseTomlMcpServers('{ "mcpServers": {} }')).toEqual({});
    expect(parseTomlMcpServers('')).toEqual({});
  });
});

describe('parseJsonMcpServers', () => {
  it('accepts either key, and treats a config with neither as empty', () => {
    expect(parseJsonMcpServers('{"mcpServers":{"a":{}}}')).toEqual({ a: {} });
    expect(parseJsonMcpServers('{"mcp_servers":{"b":{}}}')).toEqual({ b: {} });
    expect(parseJsonMcpServers('{"other":1}')).toEqual({});
  });

  it('returns null for text that doesn\'t parse to an object', () => {
    expect(parseJsonMcpServers('{ nope')).toBeNull();
    expect(parseJsonMcpServers('[1]')).toBeNull();
  });
});

describe('readMcpEntry', () => {
  it('rejects an entry with neither a command nor a URL', () => {
    expect(readMcpEntry({ args: ['x'] })).toEqual({ kind: 'invalid' });
    expect(readMcpEntry('text')).toEqual({ kind: 'invalid' });
    expect(readMcpEntry(null)).toEqual({ kind: 'invalid' });
  });

  it('keeps an env value out unless all of it is a reference', () => {
    const result = readMcpEntry({ command: 'x', env: { A: '${REF}', B: '$REF', C: '%REF%', D: 'Bearer ${REF}', E: 'plain' } });

    expect(result.kind === 'definition' && result.definition.env).toEqual([
      { name: 'A', reference: '${REF}' },
      { name: 'B', reference: '$REF' },
      { name: 'C', reference: '%REF%' },
      { name: 'D' },
      { name: 'E' },
    ]);
  });

  it('allows URLs and args that aren\'t credentials', () => {
    expect(readMcpEntry({ url: 'https://example.com/mcp' })).toMatchObject({ definition: { url: 'https://example.com/mcp', withheldValues: 0 } });
    expect(readMcpEntry({ url: '@@ServerUrl' }).kind).toBe('definition');
    expect(readMcpEntry({ command: 'x', args: ['--verbose', '--port', '3000'] }).kind).toBe('definition');
    expect(readMcpEntry({ command: 'x', args: ['--auth', '--verbose'] }).kind).toBe('definition');
  });
});
