/**
 * MCP server definitions for the import inventory (#2820). Reads the JSON and
 * TOML shapes the CLIs use and keeps what defines a server: env and header
 * values are dropped here, before anything else sees them, and the injected
 * Clubhouse bridge is filtered with isClubhouseMcpEntry.
 */
import { isClubhouseMcpEntry, isEnvReference } from '../clubhouse-mcp/injection';
import type { InventoryMcpDefinition } from '../../../shared/import-inventory-types';
import { definitionHoldsSecret } from './classify';

const CARRIED_KEYS = new Set(['command', 'args', 'url', 'type', 'env', 'env_vars', 'headers', 'http_headers']);

export type McpEntryResult =
  | { kind: 'bridge' }
  | { kind: 'secret' }
  | { kind: 'invalid' }
  | { kind: 'definition'; definition: InventoryMcpDefinition };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value as string[] : undefined;
}

/** One stored entry as a definition, or why it isn't offered. */
export function readMcpEntry(entry: unknown): McpEntryResult {
  if (isClubhouseMcpEntry(entry)) return { kind: 'bridge' };
  if (!isRecord(entry)) return { kind: 'invalid' };

  const command = typeof entry.command === 'string' ? entry.command : undefined;
  const url = typeof entry.url === 'string' ? entry.url : undefined;
  const args = stringArray(entry.args);
  if (!command && !url) return { kind: 'invalid' };
  if (definitionHoldsSecret({ command, args, url }, isEnvReference)) return { kind: 'secret' };

  const env = isRecord(entry.env)
    ? Object.entries(entry.env).map(([name, value]) => (isEnvReference(value) ? { name, reference: value as string } : { name }))
    : [];
  const headers = isRecord(entry.headers) ? entry.headers : isRecord(entry.http_headers) ? entry.http_headers : {};

  const definition: InventoryMcpDefinition = {
    env: env.sort((a, b) => a.name.localeCompare(b.name)),
    forwardedEnv: [...(stringArray(entry.env_vars) ?? [])].sort(),
    headerNames: Object.keys(headers).sort(),
    omittedKeys: Object.keys(entry).filter((k) => !CARRIED_KEYS.has(k)).sort(),
  };
  if (command) definition.command = command;
  if (args) definition.args = args;
  if (url) definition.url = url;
  if (typeof entry.type === 'string') definition.type = entry.type;
  return { kind: 'definition', definition };
}

/** The server map in a JSON config, or null when it doesn't parse as an object. */
export function parseJsonMcpServers(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // telemetry-exempt: the caller counts this; a parse error can quote the file, so it goes nowhere
    return null;
  }
  if (!isRecord(parsed)) return null;
  const servers = parsed.mcpServers ?? parsed.mcp_servers;
  return isRecord(servers) ? servers : {};
}

class TomlScanner {
  private pos = 0;
  constructor(private readonly text: string) {}

  get done(): boolean {
    return this.pos >= this.text.length;
  }

  private peek(): string {
    return this.text[this.pos];
  }

  skipBlank(newlines: boolean): void {
    while (!this.done) {
      const ch = this.peek();
      if (ch === '#') {
        while (!this.done && this.peek() !== '\n') this.pos++;
      } else if (ch === ' ' || ch === '\t' || ch === '\r' || (newlines && ch === '\n')) {
        this.pos++;
      } else {
        return;
      }
    }
  }

  skipLine(): void {
    while (!this.done && this.peek() !== '\n') this.pos++;
  }

  /** A `[table]` or `[[array]]` header's dotted key, or null when this isn't one. */
  header(): string[] | null {
    if (this.peek() !== '[') return null;
    const array = this.text[this.pos + 1] === '[';
    this.pos += array ? 2 : 1;
    const keys = this.dottedKey();
    this.skipBlank(false);
    if (this.text.startsWith(array ? ']]' : ']', this.pos)) this.pos += array ? 2 : 1;
    return array ? [] : keys;
  }

  dottedKey(): string[] {
    const keys: string[] = [];
    for (;;) {
      this.skipBlank(false);
      keys.push(this.key());
      this.skipBlank(false);
      if (this.peek() !== '.') return keys;
      this.pos++;
    }
  }

  private key(): string {
    const ch = this.peek();
    if (ch === '"' || ch === "'") return this.string();
    const start = this.pos;
    while (!this.done && /[A-Za-z0-9_-]/.test(this.peek())) this.pos++;
    if (this.pos === start) throw new Error('bad key');
    return this.text.slice(start, this.pos);
  }

  expect(ch: string): void {
    if (this.peek() !== ch) throw new Error('unexpected token');
    this.pos++;
  }

  private string(): string {
    const quote = this.peek();
    const triple = quote.repeat(3);
    if (this.text.startsWith(triple, this.pos)) {
      const end = this.text.indexOf(triple, this.pos + 3);
      if (end === -1) throw new Error('unterminated string');
      const body = this.text.slice(this.pos + 3, end);
      this.pos = end + 3;
      return body;
    }
    let i = this.pos + 1;
    while (i < this.text.length && this.text[i] !== quote && this.text[i] !== '\n') {
      if (quote === '"' && this.text[i] === '\\') i++;
      i++;
    }
    if (this.text[i] !== quote) throw new Error('unterminated string');
    const raw = this.text.slice(this.pos, i + 1);
    this.pos = i + 1;
    return quote === '"' ? JSON.parse(raw.replace(/\t/g, '\\t')) as string : raw.slice(1, -1);
  }

  value(): unknown {
    const ch = this.peek();
    if (ch === '"' || ch === "'") return this.string();
    if (ch === '[') return this.array();
    if (ch === '{') return this.inlineTable();
    const start = this.pos;
    while (!this.done && !/[\s,\]}#]/.test(this.peek())) this.pos++;
    if (this.pos === start) throw new Error('bad value');
    return this.text.slice(start, this.pos);
  }

  private array(): unknown[] {
    this.pos++;
    const items: unknown[] = [];
    for (;;) {
      this.skipBlank(true);
      if (this.peek() === ']') {
        this.pos++;
        return items;
      }
      items.push(this.value());
      this.skipBlank(true);
      if (this.peek() === ',') this.pos++;
      else if (this.peek() !== ']') throw new Error('bad array');
    }
  }

  private inlineTable(): Record<string, unknown> {
    this.pos++;
    const table: Record<string, unknown> = {};
    for (;;) {
      this.skipBlank(true);
      if (this.peek() === '}') {
        this.pos++;
        return table;
      }
      const keys = this.dottedKey();
      this.expect('=');
      this.skipBlank(false);
      setPath(table, keys, this.value());
      this.skipBlank(true);
      if (this.peek() === ',') this.pos++;
      else if (this.peek() !== '}') throw new Error('bad table');
    }
  }
}

function setPath(target: Record<string, unknown>, keys: string[], value: unknown): void {
  let at = target;
  for (const key of keys.slice(0, -1)) {
    if (!isRecord(at[key])) at[key] = {};
    at = at[key] as Record<string, unknown>;
  }
  at[keys[keys.length - 1]] = value;
}

/**
 * The `[mcp_servers.*]` tables of a Codex config. No TOML parser ships with the
 * app (toml-utils only writes), and this needs only strings, arrays and tables.
 * A line it can't read is skipped; the rest of the file, including every setting
 * outside these tables, is parsed past and dropped.
 */
export function parseTomlMcpServers(text: string): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  const scanner = new TomlScanner(text);
  let table: string[] = [];
  while (!scanner.done) {
    scanner.skipBlank(true);
    if (scanner.done) break;
    try {
      const header = scanner.header();
      if (header) {
        table = header;
        if (table[0] === 'mcp_servers' && table.length >= 2) setPath(servers, table.slice(1), {});
      } else {
        const keys = scanner.dottedKey();
        scanner.expect('=');
        scanner.skipBlank(false);
        const value = scanner.value();
        const full = [...table, ...keys];
        if (full[0] === 'mcp_servers' && full.length >= 3) setPath(servers, full.slice(1), value);
      }
    } catch {
      // telemetry-exempt: a line this small reader can't follow; skipped, and nothing about it is kept
      scanner.skipLine();
    }
  }
  return servers;
}
