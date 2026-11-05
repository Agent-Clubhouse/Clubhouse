/**
 * MCP server definitions for the import inventory (#2820). Reads the JSON and
 * TOML shapes the CLIs use. A result carries no argument, URL or env value: a
 * credential can take any shape, so patterns can't be relied on to find one. It
 * gets the command's name, how many arguments, env names that pass a check and
 * the URL's scheme and host. A later import step reads details on the user's
 * explicit action. The injected bridge is filtered with isClubhouseMcpEntry.
 */
import { isClubhouseMcpEntry } from '../clubhouse-mcp/injection';
import type { InventoryMcpDefinition } from '../../../shared/import-inventory-types';
import { isSafeIdentifier } from './classify';

/** Keys that reach Object.prototype or mean nothing as a name. Refused in every parser here. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

export type McpEntryResult =
  | { kind: 'bridge' }
  | { kind: 'invalid' }
  | { kind: 'definition'; definition: InventoryMcpDefinition; details: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value as string[] : undefined;
}

const KNOWN_TRANSPORTS = new Set(['stdio', 'http', 'sse', 'streamable-http', 'streamableHttp', 'ws']);
const MAX_URL_CHARS = 4096;

/** A plain executable name, or nothing: a command holding spaces is a whole command line. */
function commandNameOf(command: string): string | undefined {
  if (command.length > 4096 || /\s/.test(command)) return undefined;
  const name = command.slice(Math.max(command.lastIndexOf('/'), command.lastIndexOf('\\')) + 1);
  return isSafeIdentifier(name) ? name : undefined;
}

/** Scheme and host only. Userinfo, path, query and fragment never leave here. */
function urlOriginOf(url: string): { scheme: string; host?: string } | null {
  const scheme = url.slice(0, 32).match(/^([a-z][a-z0-9+.-]{0,15}):\/\//i)?.[1].toLowerCase();
  if (!scheme) return null;
  if (url.length > MAX_URL_CHARS) return { scheme };
  try {
    const host = new URL(url).hostname;
    const labelsAreShort = host.split('.').every((label) => label.length < 32);
    return /^[a-z0-9.-]{1,253}$/i.test(host) && labelsAreShort && isSafeIdentifier(host, 253) ? { scheme, host } : { scheme };
  } catch {
    // telemetry-exempt: not a URL this can read, so only the scheme is known; nothing about it is kept
    return { scheme };
  }
}

/**
 * One stored entry, or why it isn't offered. `details` holds what makes it differ
 * from another definition, env and header values excluded. It's for comparing
 * within one scan through a keyed hash, and never goes in a result.
 */
export function readMcpEntry(entry: unknown): McpEntryResult {
  if (isClubhouseMcpEntry(entry)) return { kind: 'bridge' };
  if (!isRecord(entry)) return { kind: 'invalid' };

  const command = typeof entry.command === 'string' ? entry.command : undefined;
  const url = typeof entry.url === 'string' ? entry.url : undefined;
  if (!command && !url) return { kind: 'invalid' };

  const args = Array.isArray(entry.args) ? entry.args : [];
  const rawEnvNames = isRecord(entry.env) ? Object.keys(entry.env).filter((name) => !isForbiddenKey(name)) : [];
  const forwarded = stringArray(entry.env_vars) ?? [];
  const headers = isRecord(entry.headers) ? entry.headers : isRecord(entry.http_headers) ? entry.http_headers : {};
  const headerNames = Object.keys(headers).filter((name) => !isForbiddenKey(name));
  const otherKeys = Object.keys(entry).filter((key) => !['command', 'args', 'url', 'type', 'env', 'env_vars', 'headers', 'http_headers'].includes(key) && !isForbiddenKey(key));

  const candidates = [...rawEnvNames, ...forwarded];
  const envNames = [...new Set(candidates.filter((name) => isSafeIdentifier(name)))].sort();
  const commandName = command ? commandNameOf(command) : undefined;
  const origin = url ? urlOriginOf(url) : null;
  const transport = typeof entry.type === 'string' && KNOWN_TRANSPORTS.has(entry.type) ? entry.type : undefined;

  const definition: InventoryMcpDefinition = {
    argumentCount: args.length,
    envNames,
    // Near every real server has something past these fields. It's false only when what's shown is all there is.
    detailsWithheld: args.length > 0
      || (command !== undefined && commandName !== command)
      || (url !== undefined && (!origin || !origin.host || url.replace(/\/$/, '').toLowerCase() !== `${origin.scheme}://${origin.host}`))
      || (typeof entry.type === 'string' && !transport)
      || rawEnvNames.length > 0
      || candidates.some((name) => !envNames.includes(name))
      || headerNames.length > 0
      || otherKeys.length > 0,
  };
  if (commandName) definition.commandName = commandName;
  if (origin) definition.url = origin;
  if (transport) definition.transport = transport;

  const details = JSON.stringify([command ?? null, args, url ?? null, entry.type ?? null, rawEnvNames.sort(), [...forwarded].sort(), headerNames.sort(), otherKeys.sort()]);
  return { kind: 'definition', definition, details };
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
  // A null prototype makes `__proto__` a plain key here; mcpItems refuses it by name.
  const safe: Record<string, unknown> = Object.create(null);
  if (isRecord(servers)) {
    for (const [name, entry] of Object.entries(servers)) safe[name] = entry;
  }
  return safe;
}

class TomlScanner {
  private pos = 0;
  constructor(private readonly text: string) {}

  get done(): boolean {
    return this.pos >= this.text.length;
  }

  get atHeader(): boolean {
    return this.text[this.pos] === '[';
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
      const key = this.key();
      if (isForbiddenKey(key)) throw new Error('forbidden key');
      keys.push(key);
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
    const table: Record<string, unknown> = Object.create(null);
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
  if (keys.some(isForbiddenKey)) throw new Error('forbidden key');
  let at = target;
  for (const key of keys.slice(0, -1)) {
    if (!isRecord(at[key])) at[key] = Object.create(null);
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
  const servers: Record<string, unknown> = Object.create(null);
  const scanner = new TomlScanner(text);
  let table: string[] = [];
  while (!scanner.done) {
    scanner.skipBlank(true);
    if (scanner.done) break;
    const atHeader = scanner.atHeader;
    try {
      const header = scanner.header();
      if (header) {
        table = header;
        if (table[0] === 'mcp_servers' && table.length >= 2) setPath(servers, table.slice(1), Object.create(null));
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
      // A bad header's keys must not land in the table before it.
      if (atHeader) table = [];
      scanner.skipLine();
    }
  }
  return servers;
}
