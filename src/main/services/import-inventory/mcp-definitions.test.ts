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

  it('keeps every env value out, references included', () => {
    const result = readMcpEntry({ command: 'x', env: { A: '${REF}', B: 'plain' } });

    expect(result.kind === 'definition' && result.definition).toEqual({ commandName: 'x', argumentCount: 0, envNames: ['A', 'B'], detailsWithheld: true });
    expect(JSON.stringify(result.kind === 'definition' && result.definition)).not.toContain('REF');
  });

  it('reduces a command to its plain name, on either kind of path', () => {
    const name = (command: string) => {
      const result = readMcpEntry({ command });
      return result.kind === 'definition' ? result.definition.commandName : 'invalid';
    };
    expect(name('npx')).toBe('npx');
    expect(name('/usr/local/bin/node')).toBe('node');
    expect(name('C:\\Program Files\\nodejs\\node.exe')).toBeUndefined();
    expect(name('D:\\tools\\node.exe')).toBe('node.exe');
    expect(name('x --flag')).toBeUndefined();
    expect(name(`/opt/ghp_${'a'.repeat(36)}`)).toBeUndefined();
    expect(name('a'.repeat(100))).toBeUndefined();
    expect(name('a'.repeat(8 * 1024 * 1024))).toBeUndefined();
  });

  it('reads a definition that is nothing but its name as complete', () => {
    const result = readMcpEntry({ command: 'x' });
    expect(result.kind === 'definition' && result.definition.detailsWithheld).toBe(false);
  });
});
