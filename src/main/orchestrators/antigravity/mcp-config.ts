/**
 * Clubhouse MCP delivery for Antigravity (#3793, #3794).
 *
 * Terminal: a `clubhouse` stdio entry is merged into
 * `<worktree>/.agents/mcp_config.json` (https://antigravity.google/docs/mcp/).
 * The file is edited as text: the entry goes in as one recognizable line
 * right after an opening brace, and cleanup takes that line out again. The
 * user's bytes (BOM, comments, order, formatting, other entries, edits made
 * while the agent ran) are never re-serialized, so a start/stop cycle with no
 * user edits restores the file byte for byte. Cleanup depends only on the
 * current bytes, so it also removes an entry a crashed run left behind.
 *
 * The entry holds neither the nonce nor the agent id (#2222): the bridge reads
 * CLUBHOUSE_HOOK_NONCE, CLUBHOUSE_AGENT_ID and CLUBHOUSE_MCP_PORT from the
 * environment agy passes it. Whether agy passes its environment to stdio
 * children is undocumented (#3802 V3); if it doesn't, the bridge can't
 * authenticate and the identity fence below refuses the start.
 *
 * Managed delivery (#3792) merges its servers into the same file through
 * mergeAntigravityMcpServers, the single owner of edits to it.
 *
 * Chat: the bridge goes to `agy acp` as an ACP stdio server with explicit
 * `env`, over the ACP pipe only (https://antigravity.google/docs/ide/extensions/acp/).
 *
 * Ownership is never guessed. A `clubhouse` entry that is not Clubhouse's exact
 * line, a `clubhouse` server in the global config or the project's server
 * list, or a config that can't be parsed refuses the start with a reason.
 * A server answering under the name `clubhouse` is never trusted on its name:
 * only a nonce-verified handshake for this launch counts (awaitAuthenticatedBridge).
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getBridgeScriptPath, CLUBHOUSE_NONCE_ENV } from '../../services/clubhouse-mcp/injection';
import { ANTIGRAVITY_BRIDGE_SERVER_NAME, ANTIGRAVITY_PATHS } from '../../../shared/providers/antigravity';
import type { McpServerDef } from '../../../shared/types';
import { memberOf, parseJsonc, readGlobalMcpServerNames, type JsoncNode } from './profile-reads';

export const CLUBHOUSE_MCP_SERVER_NAME = ANTIGRAVITY_BRIDGE_SERVER_NAME;

export function antigravityWorkspaceMcpPath(worktree: string): string {
  return path.join(worktree, ...ANTIGRAVITY_PATHS.mcpConfig.split('/'));
}

export function isAntigravityWorkspaceMcpPath(file: string): boolean {
  const resolved = path.resolve(file);
  return path.basename(resolved) === 'mcp_config.json' && path.basename(path.dirname(resolved)) === ANTIGRAVITY_PATHS.configDir;
}

/** Why a merge refused; every code means "do not launch with this config". */
export type AntigravityMcpConfigErrorCode =
  /** A `clubhouse` server Clubhouse didn't write (workspace, global or project list). */
  | 'collision'
  /** A config that can't be parsed, or whose shape makes ownership unclear. */
  | 'unparsable'
  /** A managed server name already used by an entry Clubhouse didn't write (or one the person edited). */
  | 'ambiguous_ownership'
  /** The file kept changing while Clubhouse edited it. */
  | 'concurrent_edit';

export class AntigravityMcpConfigError extends Error {
  constructor(readonly code: AntigravityMcpConfigErrorCode, message: string) {
    super(message);
    this.name = 'AntigravityMcpConfigError';
  }
}

// ── Entry lines ────────────────────────────────────────────────────────────

/** The bridge line. No env: no nonce, no identity (see top). */
export function bridgeMemberText(bridgeScriptPath: string = getBridgeScriptPath()): string {
  return `"${CLUBHOUSE_MCP_SERVER_NAME}": {"command": "node", "args": [${JSON.stringify(bridgeScriptPath)}]}`;
}

/** A managed server line, in the one form Clubhouse writes and later recognizes. */
export function managedMemberText(name: string, def: McpServerDef): string {
  return `${JSON.stringify(name)}: ${JSON.stringify(def)}`;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The bridge line for any bridge path (an older build's, after a crash), in Clubhouse's exact formatting. */
const MEMBER_SRC = String.raw`"clubhouse": \{"command": "node", "args": \["(?:[^"\\\n]|\\.)*clubhouse-mcp-bridge\.js"\]\}`;
/** A whole file Clubhouse created for the bridge alone. */
const CREATED_RE = new RegExp(String.raw`^\{\n  "mcpServers": \{\n    ${MEMBER_SRC}\n  \}\n\}\n$`);
/** The `mcpServers` object Clubhouse added to an existing file for the bridge. */
const ADDED_SERVERS_SRC = String.raw`"mcpServers": \{\n    ${MEMBER_SRC}\n  \}`;
/** What is left of a file Clubhouse created once every line it wrote is gone. */
const EMPTY_SKELETON = '{\n  "mcpServers": {\n  }\n}\n';

/**
 * Remove every `\n<indent><line>` match with the separator Clubhouse wrote:
 * its own trailing comma, or, when it was the last member, the comma before it.
 */
function removeLines(text: string, lineSrc: string): string {
  const re = new RegExp(String.raw`\n[ \t]*(?:${lineSrc})([ \t]*,)?`, 'g');
  let out = '';
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const cut = m.index;
    if (!m[1]) {
      let j = cut - 1;
      while (j >= last && /[ \t\r\n]/.test(text[j])) j--;
      if (j >= last && text[j] === ',') {
        out += text.slice(last, j) + text.slice(j + 1, cut);
        last = m.index + m[0].length;
        continue;
      }
    }
    out += text.slice(last, cut);
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

// ── Pure text operations ───────────────────────────────────────────────────

type Shape =
  | { ok: true; root: JsoncNode & { kind: 'object' }; servers?: JsoncNode & { kind: 'object' }; names: string[] }
  | { ok: false; reason: string };

function shapeOf(text: string): Shape {
  let root: JsoncNode;
  try { root = parseJsonc(text); }
  catch { return { ok: false, reason: 'the file is not valid JSON' }; }
  if (root.kind !== 'object') return { ok: false, reason: 'the top level is not an object' };
  const servers = memberOf(root, 'mcpServers');
  if (servers === 'duplicate') return { ok: false, reason: '"mcpServers" appears more than once' };
  if (!servers) return { ok: true, root, names: [] };
  if (servers.value.kind !== 'object') return { ok: false, reason: '"mcpServers" is not an object' };
  return { ok: true, root, servers: servers.value, names: servers.value.members.map((m) => m.key) };
}

export type StripResult =
  /** No Clubhouse entry: leave the file. */
  | { status: 'clean' }
  /** `text: null` means delete the file (Clubhouse created all of it). */
  | { status: 'stripped'; text: string | null }
  /** A `clubhouse` entry that isn't Clubhouse's exact line, or bytes that don't parse: leave them for the person. */
  | { status: 'repair'; code: AntigravityMcpConfigErrorCode; reason: string };

const NOT_OURS = 'a "clubhouse" server that Clubhouse did not write is configured';

/** Take the bridge line out of a workspace MCP config text. */
export function stripWorkspaceBridge(text: string): StripResult {
  const before = shapeOf(text);
  if (before.ok && !before.names.includes(CLUBHOUSE_MCP_SERVER_NAME)) return { status: 'clean' };
  if (CREATED_RE.test(text)) return { status: 'stripped', text: null };
  const stripped = removeLines(removeLines(text, ADDED_SERVERS_SRC), MEMBER_SRC);
  if (stripped === text) {
    return before.ok === false ? { status: 'repair', code: 'unparsable', reason: before.reason } : { status: 'repair', code: 'collision', reason: NOT_OURS };
  }
  const after = shapeOf(stripped);
  if (after.ok === false) return { status: 'repair', code: 'unparsable', reason: `removing the Clubhouse entry would leave invalid JSON (${after.reason})` };
  if (after.names.includes(CLUBHOUSE_MCP_SERVER_NAME)) return { status: 'repair', code: 'collision', reason: NOT_OURS };
  return { status: 'stripped', text: stripped };
}

export type InsertResult = { ok: true; text: string } | { ok: false; code: AntigravityMcpConfigErrorCode; reason: string };

/** Indentation of the first member when it sits on its own line. */
function memberIndent(text: string, obj: JsoncNode & { kind: 'object' }, fallback: string): string {
  const first = obj.members[0];
  if (!first) return fallback;
  const lineStart = text.lastIndexOf('\n', first.keyStart) + 1;
  const lead = text.slice(lineStart, first.keyStart);
  return /^[ \t]*$/.test(lead) && lineStart > obj.start ? lead : fallback;
}

/** Insert whole lines right after `mcpServers`' opening brace (adding the object when absent). */
function insertLines(text: string | null, lines: string[]): InsertResult {
  if (lines.length === 0) return text === null ? { ok: false, code: 'unparsable', reason: 'nothing to write' } : { ok: true, text };
  if (text === null) return { ok: true, text: `{\n  "mcpServers": {\n    ${lines.join(',\n    ')}\n  }\n}\n` };
  const shape = shapeOf(text);
  if (shape.ok === false) return { ok: false, code: 'unparsable', reason: shape.reason };
  if (shape.servers) {
    const at = shape.servers.start + 1;
    const indent = memberIndent(text, shape.servers, '    ');
    const sep = shape.servers.members.length > 0 ? ',' : '';
    return { ok: true, text: `${text.slice(0, at)}\n${indent}${lines.join(`,\n${indent}`)}${sep}${text.slice(at)}` };
  }
  const at = shape.root.start + 1;
  const sep = shape.root.members.length > 0 ? ',' : '';
  return { ok: true, text: `${text.slice(0, at)}\n  "mcpServers": {\n    ${lines.join(',\n    ')}\n  }${sep}${text.slice(at)}` };
}

/**
 * Add the bridge line to a workspace MCP config text (null: no file yet).
 * A leftover bridge line from a crashed run is replaced; any other
 * `clubhouse` entry, or a file that doesn't parse, is refused.
 */
export function insertWorkspaceBridge(text: string | null, bridgeScriptPath?: string): InsertResult {
  let base = text;
  if (text !== null) {
    const leftover = stripWorkspaceBridge(text);
    if (leftover.status === 'repair') return { ok: false, code: leftover.code, reason: leftover.reason };
    if (leftover.status === 'stripped') base = leftover.text;
  }
  return insertLines(base, [bridgeMemberText(bridgeScriptPath)]);
}

/**
 * Replace Clubhouse's managed server lines. Lines exactly as Clubhouse wrote
 * them for `previous` or `servers` come out; an entry the person edited is no
 * longer recognized and stays theirs. A wanted name still taken after that is
 * refused as ambiguous ownership. Pure.
 */
export function replaceManagedServers(
  text: string | null,
  servers: Record<string, McpServerDef>,
  previous: Record<string, McpServerDef> = {},
): InsertResult & { emptied?: boolean } {
  if (CLUBHOUSE_MCP_SERVER_NAME in servers) return { ok: false, code: 'collision', reason: 'a managed server may not be named "clubhouse"' };
  let base = text;
  if (base !== null) {
    const shape = shapeOf(base);
    if (shape.ok === false) {
      return { ok: false, code: 'unparsable', reason: shape.reason };
    }
    const owned = new Set<string>();
    for (const [name, def] of [...Object.entries(previous), ...Object.entries(servers)]) {
      if (name !== CLUBHOUSE_MCP_SERVER_NAME) owned.add(escapeRe(managedMemberText(name, def)));
    }
    for (const src of owned) base = removeLines(base, src);
    const after = shapeOf(base);
    if (after.ok === false) return { ok: false, code: 'unparsable', reason: `removing Clubhouse's entries would leave invalid JSON (${after.reason})` };
    const taken = Object.keys(servers).filter((n) => after.names.includes(n));
    if (taken.length) {
      return { ok: false, code: 'ambiguous_ownership', reason: `MCP server ${taken.map((n) => JSON.stringify(n)).join(', ')} is already configured and was not written by Clubhouse` };
    }
  }
  const lines = Object.keys(servers).sort().map((n) => managedMemberText(n, servers[n]));
  if (lines.length === 0) return base === EMPTY_SKELETON ? { ok: true, text: base, emptied: true } : base === null ? { ok: true, text: '', emptied: true } : { ok: true, text: base };
  return insertLines(base, lines);
}

// ── Collision check ────────────────────────────────────────────────────────

/** The reason a configured `clubhouse` server blocks the start, or undefined. Pure. */
export function findClubhouseCollision(projectServers: Record<string, unknown> | readonly string[] | undefined): string | undefined {
  if (!projectServers) return undefined;
  const names = Array.isArray(projectServers) ? projectServers : Object.keys(projectServers);
  return names.includes(CLUBHOUSE_MCP_SERVER_NAME)
    ? 'The project configures an MCP server named "clubhouse", which Antigravity would run instead of the Clubhouse bridge. Rename it, then start the agent again.'
    : undefined;
}

export type CheckResult = { ok: true } | { ok: false; code: AntigravityMcpConfigErrorCode; reason: string };

/**
 * Refuse when any readable config outside the workspace file defines
 * `clubhouse`: the global `~/.gemini/config/mcp_config.json` (names only, read
 * only) or the project's own server list. An unparsable global file refuses
 * too, since the check can't pass. Plugin servers can't all be listed from
 * documented files; the identity fence is the backstop for those.
 */
export async function checkClubhouseCollisions(input: { home?: string; projectServers?: Record<string, unknown> | readonly string[] }): Promise<CheckResult> {
  const project = findClubhouseCollision(input.projectServers);
  if (project) return { ok: false, code: 'collision', reason: project };
  const global = await readGlobalMcpServerNames(input.home);
  if (global.status === 'unreadable') {
    return { ok: false, code: 'unparsable', reason: `Your Antigravity MCP config (~/.gemini/config/mcp_config.json) could not be checked for a "clubhouse" server: ${global.reason}. Fix the file, then start the agent again.` };
  }
  if (global.status === 'ok' && global.names.includes(CLUBHOUSE_MCP_SERVER_NAME)) {
    return { ok: false, code: 'collision', reason: 'Your Antigravity MCP config (~/.gemini/config/mcp_config.json) defines a server named "clubhouse", which Antigravity would run instead of the Clubhouse bridge. Rename it, then start the agent again.' };
  }
  return { ok: true };
}

// ── File operations ────────────────────────────────────────────────────────

async function readOrNull(file: string): Promise<string | null> {
  try { return await fsp.readFile(file, 'utf-8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}

/** `.agents` folders this process created, removed again only when empty. */
const createdDirs = new Set<string>();

/** Attempts before a file that keeps changing under us is left alone. */
const MAX_ATTEMPTS = 3;

/**
 * Write `next` over `file` (null: delete it) only if it still holds
 * `expected` just before the rename, so an edit the person saved meanwhile is
 * not lost.
 */
async function writeIfUnchanged(file: string, expected: string | null, next: string | null): Promise<boolean> {
  if (next === null) {
    if (await readOrNull(file) !== expected) return false;
    await fsp.unlink(file).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'ENOENT') throw err; });
    return true;
  }
  if (expected === null) {
    const dir = path.dirname(file);
    try { await fsp.mkdir(dir); createdDirs.add(dir); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
  }
  const tmp = `${file}.tmp.${randomUUID().slice(0, 8)}`;
  await fsp.writeFile(tmp, next, 'utf-8');
  try {
    if (await readOrNull(file) !== expected) return false;
    await fsp.rename(tmp, file);
    return true;
  } finally {
    await fsp.unlink(tmp).catch(() => { /* telemetry-exempt: already renamed into place */ });
  }
}

async function removeCreatedDir(file: string): Promise<void> {
  const dir = path.dirname(file);
  if (!createdDirs.delete(dir)) return;
  // rmdir only removes an empty folder: anything the person added stays.
  await fsp.rmdir(dir).catch(() => { /* telemetry-exempt: not empty, or already gone */ });
}

/** Serialize edits of the same file inside this process (bridge merge, managed delivery, cleanup). */
const fileLocks = new Map<string, Promise<unknown>>();
function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.then(() => {}, () => {});
  fileLocks.set(key, tail);
  void tail.then(() => { if (fileLocks.get(key) === tail) fileLocks.delete(key); });
  return next;
}

const concurrent = (file: string) => new AntigravityMcpConfigError('concurrent_edit', `${file} kept changing while Clubhouse edited it; start the agent again.`);

export interface MergeOutcome { file: string; created: boolean }

/**
 * Merge the bridge line into `<worktree>/.agents/mcp_config.json`. Call
 * `configPipeline.snapshotFile` on the same path first, so stop and app quit
 * clean it up. `created` tells the caller to add the path to
 * `.git/info/exclude`. Throws AntigravityMcpConfigError, leaving the file
 * as it was, on any refusal: the agent must not start.
 */
export function mergeAntigravityWorkspaceMcp(worktree: string, bridgeScriptPath?: string): Promise<MergeOutcome> {
  const file = antigravityWorkspaceMcpPath(worktree);
  return withFileLock(file, async () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const current = await readOrNull(file);
      const next = insertWorkspaceBridge(current, bridgeScriptPath);
      if (next.ok === false) throw new AntigravityMcpConfigError(next.code, `${ANTIGRAVITY_PATHS.mcpConfig}: ${next.reason}. Fix the file, then start the agent again.`);
      if (await writeIfUnchanged(file, current, next.text)) return { file, created: current === null };
    }
    throw concurrent(ANTIGRAVITY_PATHS.mcpConfig);
  });
}

/**
 * Managed delivery's servers (#3792) in the same file, merged instead of
 * written over it. Pass the servers delivered last time as `previous` so ones
 * removed from the setup go away; entries the person wrote or edited stay.
 * Throws AntigravityMcpConfigError on any refusal, leaving the file as it was.
 */
export function mergeAntigravityMcpServers(
  worktree: string,
  servers: Record<string, McpServerDef>,
  previous?: Record<string, McpServerDef>,
): Promise<MergeOutcome> {
  const file = antigravityWorkspaceMcpPath(worktree);
  return withFileLock(file, async () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const current = await readOrNull(file);
      const next = replaceManagedServers(current, servers, previous);
      if (next.ok === false) throw new AntigravityMcpConfigError(next.code, `${ANTIGRAVITY_PATHS.mcpConfig}: ${next.reason}. Fix the file, then start the agent again.`);
      if (next.emptied && current === null) return { file, created: false };
      const target = next.emptied && next.text === EMPTY_SKELETON ? null : next.text;
      if (target === current) return { file, created: false };
      if (await writeIfUnchanged(file, current, target)) {
        if (target === null) await removeCreatedDir(file);
        return { file, created: current === null };
      }
    }
    throw concurrent(ANTIGRAVITY_PATHS.mcpConfig);
  });
}

export type RestoreResult = 'clean' | 'restored' | 'deleted' | { repair: string };

/**
 * Take the bridge line out of the workspace file, from its current bytes.
 * Edits the person made while the agent ran are kept; a file Clubhouse
 * created and nobody touched is deleted. Anything ambiguous is left as is
 * and reported for repair. Managed servers are delivery's and stay.
 */
export function restoreAntigravityWorkspaceMcp(file: string): Promise<RestoreResult> {
  return withFileLock(file, async () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const current = await readOrNull(file);
      if (current === null) return 'clean';
      const result = stripWorkspaceBridge(current);
      if (result.status === 'clean') return 'clean';
      if (result.status === 'repair') return { repair: result.reason };
      if (await writeIfUnchanged(file, current, result.text)) {
        if (result.text !== null) return 'restored';
        await removeCreatedDir(file);
        return 'deleted';
      }
    }
    return { repair: 'the file kept changing during cleanup' };
  });
}

// ── ACP mcpServers (chat) ──────────────────────────────────────────────────

/** ACP v1 `McpServerStdio` (https://agentclientprotocol.com/protocol/session-setup). */
export interface AcpStdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface AcpHttpMcpServer {
  type: 'http';
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export type AcpMcpServer = AcpStdioMcpServer | AcpHttpMcpServer;

/**
 * The bridge as an ACP stdio server. ACP makes `env` explicit, so the
 * launch's identity and nonce go here; this value travels only over the ACP
 * stdio pipe. Never put it in argv, a file or a log line.
 */
export function buildAntigravityAcpBridgeServer(input: { agentId: string; nonce: string; mcpPort: number; bridgeScriptPath?: string }): AcpStdioMcpServer {
  if (!input.agentId) throw new Error('Antigravity ACP bridge: agentId is required');
  if (!input.nonce) throw new Error('Antigravity ACP bridge: nonce is required');
  if (!Number.isInteger(input.mcpPort) || input.mcpPort <= 0 || input.mcpPort > 65535) throw new Error('Antigravity ACP bridge: invalid MCP port');
  return {
    name: CLUBHOUSE_MCP_SERVER_NAME,
    command: 'node',
    args: [input.bridgeScriptPath ?? getBridgeScriptPath()],
    env: [
      { name: 'CLUBHOUSE_AGENT_ID', value: input.agentId },
      { name: CLUBHOUSE_NONCE_ENV, value: input.nonce },
      { name: 'CLUBHOUSE_MCP_PORT', value: String(input.mcpPort) },
    ],
  };
}

const nameValues = (v: unknown): Array<{ name: string; value: string }> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string').map(([name, value]) => ({ name, value }))
    : [];

export type AcpPlan = { ok: true; servers: AcpMcpServer[]; notices: string[] } | { ok: false; reason: string };

/**
 * Servers for ACP `session/new`, `load` and `resume`: the bridge first, then
 * the project's stdio servers with only their declared env, then its HTTP
 * servers only when `initialize` advertised `mcpCapabilities.http`.
 * Others are left to the workspace file with a notice. A project server named
 * `clubhouse` refuses the start.
 */
export function planAntigravityAcpMcpServers(input: { bridge: AcpStdioMcpServer; projectServers?: Record<string, unknown>; mcpCapabilities?: { http?: boolean; sse?: boolean } }): AcpPlan {
  const collision = findClubhouseCollision(input.projectServers);
  if (collision) return { ok: false, reason: collision };
  const servers: AcpMcpServer[] = [input.bridge];
  const notices: string[] = [];
  for (const [name, raw] of Object.entries(input.projectServers ?? {})) {
    const def = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if (def && typeof def.command === 'string' && def.command) {
      const args = Array.isArray(def.args) && def.args.every((a) => typeof a === 'string') ? def.args as string[] : [];
      servers.push({ name, command: def.command, args, env: nameValues(def.env) });
      continue;
    }
    const url = def && (typeof def.url === 'string' ? def.url : typeof def.serverUrl === 'string' ? def.serverUrl : undefined);
    if (def && url && (def.type === undefined || def.type === 'http')) {
      if (input.mcpCapabilities?.http) servers.push({ type: 'http', name, url, headers: nameValues(def.headers) });
      else notices.push(`MCP server "${name}" uses HTTP, which this Antigravity version doesn't accept from Clubhouse; it is available only from the workspace config.`);
      continue;
    }
    notices.push(`MCP server "${name}" has a type Clubhouse can't pass to Antigravity; it is available only from the workspace config.`);
  }
  return { ok: true, servers, notices };
}

// ── Identity fence ─────────────────────────────────────────────────────────

/** What the fence reads; the caller passes the bridge server's and registry's functions. */
export interface BridgeIdentityDeps {
  /** The registry's current nonce for the agent (agent-registry getAgentNonce). */
  getAgentNonce(agentId: string): string | undefined;
  /** The handshake whose admitted nonce still matches (bridge-server getCurrentAgentConnection). */
  getCurrentAgentConnection(agentId: string): { connectedAt: number } | null;
  /** connection-events onAgentMcpConnected. */
  onAgentMcpConnected(listener: (agentId: string) => void): () => void;
  /** agentRegistry.onAuthChange. */
  onAuthChange(listener: (agentId: string) => void): () => void;
}

export type FenceResult = { ok: true; connectedAt: number } | { ok: false; reason: 'timeout' | 'nonce_changed' | 'aborted' };

export const FENCE_REASONS: Record<Exclude<FenceResult, { ok: true }>['reason'], string> = {
  timeout: 'The Clubhouse MCP bridge did not authenticate for this launch in time, so the agent was not given Clubhouse tools.',
  nonce_changed: 'The agent was restarted or stopped before its Clubhouse MCP bridge authenticated.',
  aborted: 'The start was cancelled before the Clubhouse MCP bridge authenticated.',
};

/**
 * Resolve ok only once the bridge server has recorded a nonce-verified
 * handshake for this agent, admitted under `expectedNonce` (this launch's)
 * and made at or after `launchedAt`. A server answering as `clubhouse` that
 * never presents the nonce never resolves ok. Holds no nonce after it settles.
 */
export function awaitAuthenticatedBridge(
  input: { agentId: string; expectedNonce: string; launchedAt: number; deadlineMs: number; signal?: AbortSignal },
  deps: BridgeIdentityDeps,
): Promise<FenceResult> {
  return new Promise<FenceResult>((resolve) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    const finish = (result: FenceResult): void => {
      if (settled) return;
      settled = true;
      for (const c of cleanups) c();
      resolve(result);
    };
    const check = (): void => {
      if (deps.getAgentNonce(input.agentId) !== input.expectedNonce) return finish({ ok: false, reason: 'nonce_changed' });
      const conn = deps.getCurrentAgentConnection(input.agentId);
      if (conn && conn.connectedAt >= input.launchedAt) finish({ ok: true, connectedAt: conn.connectedAt });
    };
    if (!input.expectedNonce) return finish({ ok: false, reason: 'nonce_changed' });
    if (input.signal?.aborted) return finish({ ok: false, reason: 'aborted' });
    const onAbort = () => finish({ ok: false, reason: 'aborted' });
    input.signal?.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => input.signal?.removeEventListener('abort', onAbort));
    cleanups.push(deps.onAgentMcpConnected((id) => { if (id === input.agentId) check(); }));
    cleanups.push(deps.onAuthChange((id) => { if (id === input.agentId) check(); }));
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), Math.max(0, input.deadlineMs));
    cleanups.push(() => clearTimeout(timer));
    check();
  });
}
