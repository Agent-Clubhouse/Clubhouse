/**
 * Read-only access to the user's Antigravity profile (#3794).
 *
 * Clubhouse never writes under `~/.gemini`. It reads two documented files:
 * - `~/.gemini/antigravity-cli/settings.json`, for `auth.type`,
 *   `modelProvider` and `agentMode` only (https://antigravity.google/docs/settings/);
 * - `~/.gemini/config/mcp_config.json`, for the server names only, so the
 *   `clubhouse` collision check can run (https://antigravity.google/docs/mcp/).
 * Values, env, headers and every other key are never returned or logged.
 *
 * Both files may start with a UTF-8 BOM and may hold comments, so the parser
 * below accepts both, plus trailing commas. It also reports the position of
 * every object member, which the workspace merge in mcp-config.ts uses to
 * insert and remove its entry without rewriting the user's bytes.
 */
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ANTIGRAVITY_GLOBAL_PATHS } from '../../../shared/providers/antigravity';

// ── JSONC parser with member spans ─────────────────────────────────────────

export interface JsoncMember {
  key: string;
  /** Offset of the key's opening quote. */
  keyStart: number;
  value: JsoncNode;
}

export type JsoncNode =
  | { kind: 'object'; start: number; end: number; members: JsoncMember[] }
  | { kind: 'array'; start: number; end: number; items: JsoncNode[] }
  | { kind: 'value'; start: number; end: number; value: string | number | boolean | null };

export class JsoncError extends Error {}

/** Parse JSON with an optional BOM, comments and trailing commas. Offsets index `text` as given. */
export function parseJsonc(text: string): JsoncNode {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = (what: string): never => { throw new JsoncError(`${what} at offset ${i}`); };

  const skip = (): void => {
    for (;;) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        const close = text.indexOf('*/', i + 2);
        if (close < 0) fail('unterminated comment');
        i = close + 2;
        continue;
      }
      return;
    }
  };

  const str = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++;
      if (text[i] === '\n') fail('newline in string');
      i++;
    }
    if (i >= text.length) fail('unterminated string');
    i++;
    try { return JSON.parse(text.slice(start, i)) as string; }
    catch { return fail('invalid string'); }
  };

  const value = (depth: number): JsoncNode => {
    if (depth > 64) fail('nesting too deep');
    skip();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i++;
      const members: JsoncMember[] = [];
      for (;;) {
        skip();
        if (text[i] === '}') { i++; break; }
        if (text[i] !== '"') fail('expected key');
        const keyStart = i;
        const key = str();
        skip();
        if (text[i] !== ':') fail('expected colon');
        i++;
        members.push({ key, keyStart, value: value(depth + 1) });
        skip();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
        fail('expected comma or }');
      }
      return { kind: 'object', start, end: i, members };
    }
    if (c === '[') {
      i++;
      const items: JsoncNode[] = [];
      for (;;) {
        skip();
        if (text[i] === ']') { i++; break; }
        items.push(value(depth + 1));
        skip();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; break; }
        fail('expected comma or ]');
      }
      return { kind: 'array', start, end: i, items };
    }
    if (c === '"') return { kind: 'value', start, end: (str(), i), value: JSON.parse(text.slice(start, i)) as string };
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
    if (!m) return fail('unexpected token');
    i += m[0].length;
    return { kind: 'value', start, end: i, value: JSON.parse(m[0]) as number | boolean | null };
  };

  const root = value(0);
  skip();
  if (i !== text.length) fail('trailing content');
  return root;
}

/** The member named `key`, or 'duplicate' when the object names it more than once. */
export function memberOf(node: JsoncNode, key: string): JsoncMember | undefined | 'duplicate' {
  if (node.kind !== 'object') return undefined;
  const found = node.members.filter((m) => m.key === key);
  return found.length > 1 ? 'duplicate' : found[0];
}

/** Plain JS value of a node (for small, already allowlisted reads). */
export function toPlain(node: JsoncNode): unknown {
  if (node.kind === 'value') return node.value;
  if (node.kind === 'array') return node.items.map(toPlain);
  const out: Record<string, unknown> = {};
  for (const m of node.members) out[m.key] = toPlain(m.value);
  return out;
}

// ── Documented profile paths ───────────────────────────────────────────────

const fromHome = (rel: string, home: string = os.homedir()): string => path.join(home, ...rel.split('/'));

export function antigravitySettingsPath(home?: string): string {
  return fromHome(ANTIGRAVITY_GLOBAL_PATHS.cliSettings, home);
}

export function globalMcpConfigPath(home?: string): string {
  return fromHome(ANTIGRAVITY_GLOBAL_PATHS.globalMcp, home);
}

/** Bounded read; larger files count as unreadable. */
const MAX_PROFILE_BYTES = 1024 * 1024;

async function readBounded(file: string): Promise<{ status: 'absent' } | { status: 'unreadable' } | { status: 'ok'; text: string }> {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > MAX_PROFILE_BYTES) return { status: 'unreadable' };
    return { status: 'ok', text: await fsp.readFile(file, 'utf-8') };
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? { status: 'absent' } : { status: 'unreadable' };
  }
}

// ── settings.json allowlist ────────────────────────────────────────────────

export interface AntigravityProfileFacts {
  authType?: string;
  modelProvider?: string;
  agentMode?: string;
}

export type AntigravityProfileRead =
  | { status: 'ok'; facts: AntigravityProfileFacts }
  | { status: 'absent' }
  /** Unparsable, unreadable, or not an object: callers treat it as unknown, never as eligible. */
  | { status: 'unknown' };

const short = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[\w.:-]+$/.test(v) ? v : undefined;

/**
 * Read `auth.type`, `modelProvider` and `agentMode` from the CLI settings.
 * Every other key, including `gcp`, permissions and trusted workspaces, is
 * dropped unread. A value outside a short identifier shape is dropped too, so
 * a misplaced secret can't reach a caller or a log line.
 */
export async function readAntigravityProfile(home?: string): Promise<AntigravityProfileRead> {
  const read = await readBounded(antigravitySettingsPath(home));
  if (read.status === 'absent') return { status: 'absent' };
  if (read.status !== 'ok') return { status: 'unknown' };
  let root: JsoncNode;
  try { root = parseJsonc(read.text); }
  catch { return { status: 'unknown' }; }
  if (root.kind !== 'object') return { status: 'unknown' };
  const pick = (node: JsoncNode, key: string): JsoncNode | undefined | 'duplicate' => {
    const m = memberOf(node, key);
    return m === 'duplicate' ? m : m?.value;
  };
  const auth = pick(root, 'auth');
  const authType = auth && auth !== 'duplicate' ? pick(auth, 'type') : auth;
  const modelProvider = pick(root, 'modelProvider');
  const agentMode = pick(root, 'agentMode');
  if ([auth, authType, modelProvider, agentMode].includes('duplicate')) return { status: 'unknown' };
  const scalar = (n: JsoncNode | undefined | 'duplicate') => n && n !== 'duplicate' && n.kind === 'value' ? short(n.value) : undefined;
  const facts: AntigravityProfileFacts = {};
  const a = scalar(authType); if (a) facts.authType = a;
  const p = scalar(modelProvider); if (p) facts.modelProvider = p;
  const g = scalar(agentMode); if (g) facts.agentMode = g;
  return { status: 'ok', facts };
}

// ── Global MCP config: names only ──────────────────────────────────────────

export type GlobalMcpNamesRead =
  | { status: 'absent' }
  | { status: 'ok'; names: string[] }
  /** The collision check can't pass on this: the start is refused with the reason. */
  | { status: 'unreadable'; reason: string };

/** Server names under `mcpServers` in the global MCP config. Never returns or logs a server's definition. */
export async function readGlobalMcpServerNames(home?: string): Promise<GlobalMcpNamesRead> {
  const read = await readBounded(globalMcpConfigPath(home));
  if (read.status === 'absent') return { status: 'absent' };
  if (read.status !== 'ok') return { status: 'unreadable', reason: 'could not read the file' };
  return serverNamesOf(read.text);
}

/** `mcpServers` member names of a JSONC MCP config text. */
export function serverNamesOf(text: string): GlobalMcpNamesRead {
  let root: JsoncNode;
  try { root = parseJsonc(text); }
  catch { return { status: 'unreadable', reason: 'not valid JSON' }; }
  if (root.kind !== 'object') return { status: 'unreadable', reason: 'top level is not an object' };
  const servers = memberOf(root, 'mcpServers');
  if (servers === 'duplicate') return { status: 'unreadable', reason: 'mcpServers appears more than once' };
  if (!servers) return { status: 'ok', names: [] };
  if (servers.value.kind !== 'object') return { status: 'unreadable', reason: 'mcpServers is not an object' };
  return { status: 'ok', names: servers.value.members.map((m) => m.key) };
}

// ── Inherited customizations (read-only list) ──────────────────────────────

/** Documented global locations Antigravity also loads (rules, skills, MCP, hooks, settings), home-relative. */
export const INHERITED_PROFILE_PATHS: readonly string[] = [
  ...ANTIGRAVITY_GLOBAL_PATHS.rules,
  ...ANTIGRAVITY_GLOBAL_PATHS.skills,
  ANTIGRAVITY_GLOBAL_PATHS.globalMcp,
  ANTIGRAVITY_GLOBAL_PATHS.globalHooks,
  ANTIGRAVITY_GLOBAL_PATHS.cliSettings,
];

/**
 * Which documented global paths exist, for the agent settings view's
 * "Also loaded from your Antigravity profile" list. Uses lstat only: no
 * contents are read.
 */
export async function listInheritedProfilePaths(home?: string): Promise<string[]> {
  const found: string[] = [];
  for (const rel of INHERITED_PROFILE_PATHS) {
    const abs = fromHome(rel, home);
    try { await fsp.lstat(abs); found.push(abs); }
    catch { /* telemetry-exempt: a missing optional profile path is the common case */ }
  }
  return found;
}
