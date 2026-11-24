/**
 * Clubhouse MCP delivery for Antigravity (#3793, #3794).
 *
 * Terminal: a `clubhouse` stdio entry is merged into
 * `<worktree>/.agents/mcp_config.json` (https://antigravity.google/docs/mcp/).
 * Managed delivery (#3792) merges its servers into the same file through
 * mergeAntigravityMcpServers; this module is the only writer of that file.
 *
 * Edits are text edits bound to the parsed top-level `mcpServers` members:
 * an entry goes in as one line right after the object's opening brace, and
 * comes out by its member span. The person's bytes (BOM, comments, order,
 * formatting, other entries) are never re-serialized, so a cycle with no
 * edits restores the file byte for byte.
 *
 * Ownership is never inferred from shape. Clubhouse removes or replaces an
 * entry only when a committed receipt (Clubhouse's userData, hashes only, no
 * server values) lists the SHA-256 of that member's exact source text. A
 * receipt is two-phase: a pending record (before/after hashes) is written
 * before the file changes and committed only after the write is known to have
 * happened. A pending record never confers ownership; on recovery it is
 * dropped and anything that looks like ours without a committed hash is the
 * person's, which refuses the start rather than adopting it. A file is
 * deleted only when the receipt says Clubhouse created it and what is left is
 * the exact skeleton Clubhouse wrote.
 *
 * The entry holds neither the nonce nor the agent id (#2222): the bridge reads
 * CLUBHOUSE_HOOK_NONCE, CLUBHOUSE_AGENT_ID and CLUBHOUSE_MCP_PORT from the
 * environment agy passes it. Whether agy passes its environment to stdio
 * children is undocumented (#3802 V3); if it doesn't, the bridge can't
 * authenticate and the identity fence below refuses the start.
 *
 * Path safety: a symlinked or non-directory `.agents`, a symlinked or
 * non-regular `mcp_config.json`, or a target inside the home folder's
 * `.gemini` is refused before any write. Reads and temp files don't follow
 * links.
 *
 * Concurrency boundary: Clubhouse's own writers are serialized in-process.
 * Against other processes, the current file is moved aside atomically and
 * compared before the new one is linked into place (link fails if something
 * appeared meanwhile), so a writer that replaces the file by path is detected
 * and its bytes kept. Not covered: a writer that keeps an open descriptor to
 * the old file and writes through it after the compare, and readers during
 * the moment the file is moved aside, which see no file.
 *
 * Chat: the bridge goes to `agy acp` as an ACP stdio server with explicit
 * `env`, over the ACP pipe only (https://antigravity.google/docs/ide/extensions/acp/).
 * A server answering under the name `clubhouse` is never trusted on its name:
 * only a nonce-verified handshake for this launch counts (awaitAuthenticatedBridge).
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { app } from 'electron';
import { getBridgeScriptPath, CLUBHOUSE_NONCE_ENV } from '../../services/clubhouse-mcp/injection';
import { ANTIGRAVITY_BRIDGE_SERVER_NAME, ANTIGRAVITY_GLOBAL_PATHS, ANTIGRAVITY_PATHS } from '../../../shared/providers/antigravity';
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
  /** A `clubhouse` server Clubhouse has no committed receipt for (workspace, global or project list). */
  | 'collision'
  /** A config that can't be parsed, or whose shape makes ownership unclear. */
  | 'unparsable'
  /** A managed server name already used by an entry Clubhouse has no committed receipt for. */
  | 'ambiguous_ownership'
  /** The file changed while Clubhouse edited it. */
  | 'concurrent_edit'
  /** A symlink, a non-regular file, or a target inside the home folder's `.gemini`. */
  | 'unsafe_path';

export class AntigravityMcpConfigError extends Error {
  constructor(readonly code: AntigravityMcpConfigErrorCode, message: string) {
    super(message);
    this.name = 'AntigravityMcpConfigError';
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// ── Entry lines ────────────────────────────────────────────────────────────

/** The bridge line. No env: no nonce, no identity (see top). */
export function bridgeMemberText(bridgeScriptPath: string = getBridgeScriptPath()): string {
  return `"${CLUBHOUSE_MCP_SERVER_NAME}": {"command": "node", "args": [${JSON.stringify(bridgeScriptPath)}]}`;
}

/** A managed server line, in the one form Clubhouse writes. */
export function managedMemberText(name: string, def: McpServerDef): string {
  return `${JSON.stringify(name)}: ${JSON.stringify(def)}`;
}

/** The file Clubhouse writes when there is none, before its lines go in. */
export const CREATED_SKELETON = '{\n  "mcpServers": {}\n}\n';

// ── Receipts ───────────────────────────────────────────────────────────────

/** What Clubhouse provably wrote. Hashes only: no server values are stored. */
export interface CommittedOwnership {
  /** Clubhouse created the file (and `createdDir`: its `.agents` folder). */
  created: boolean;
  createdDir: boolean;
  /** SHA-256 of each bridge member's exact source text. */
  bridge: string[];
  /** Per managed server name, SHA-256 of its exact source text. */
  managed: Record<string, string[]>;
  /** Clubhouse added the `mcpServers` object itself; it goes again once it is exactly `"mcpServers": {}`. */
  container?: boolean;
}

export interface PendingWrite {
  txid: string;
  /** SHA-256 of the bytes before the write, null when the file was absent. */
  beforeHash: string | null;
  afterHash: string | null;
}

export interface FileReceipt {
  committed: CommittedOwnership;
  pending?: PendingWrite;
}

export interface ReceiptStore {
  get(file: string): Promise<FileReceipt | undefined>;
  set(file: string, receipt: FileReceipt | undefined): Promise<void>;
}

const emptyOwnership = (): CommittedOwnership => ({ created: false, createdDir: false, bridge: [], managed: {} });
const ownsNothing = (o: CommittedOwnership): boolean => o.bridge.length === 0 && Object.keys(o.managed).length === 0 && !o.container;

/** In-memory store (tests, or before userData is available). */
export function memoryReceiptStore(): ReceiptStore {
  const map = new Map<string, FileReceipt>();
  return {
    get: async (file) => { const r = map.get(file); return r && JSON.parse(JSON.stringify(r)) as FileReceipt; },
    set: async (file, receipt) => { if (receipt) map.set(file, JSON.parse(JSON.stringify(receipt)) as FileReceipt); else map.delete(file); },
  };
}

/** A JSON map in one owner-only file, replaced atomically. */
export function fileReceiptStore(storeFile: () => string): ReceiptStore {
  const load = async (): Promise<Record<string, FileReceipt>> => {
    try {
      const parsed: unknown = JSON.parse(await fsp.readFile(storeFile(), 'utf-8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, FileReceipt> : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
      // An unreadable store proves nothing: refuse rather than act without ownership.
      throw new AntigravityMcpConfigError('unparsable', 'Clubhouse could not read its Antigravity MCP ownership record');
    }
  };
  return {
    get: async (file) => (await load())[file],
    set: async (file, receipt) => {
      const all = await load();
      if (receipt) all[file] = receipt; else delete all[file];
      const target = storeFile();
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp.${randomUUID().slice(0, 8)}`;
      await fsp.writeFile(tmp, JSON.stringify(all), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
      await fsp.rename(tmp, target);
    },
  };
}

let receiptStore: ReceiptStore = fileReceiptStore(() => path.join(app.getPath('userData'), 'antigravity-mcp-receipts.json'));

/** Replace the receipt store (tests). Returns the previous one. */
export function setAntigravityReceiptStore(store: ReceiptStore): ReceiptStore {
  const previous = receiptStore;
  receiptStore = store;
  return previous;
}

// ── Pure text operations ───────────────────────────────────────────────────

type ObjectNode = JsoncNode & { kind: 'object' };
type Shape = { ok: true; root: ObjectNode; servers?: ObjectNode } | { ok: false; reason: string };

function shapeOf(text: string): Shape {
  let root: JsoncNode;
  try { root = parseJsonc(text); }
  catch { return { ok: false, reason: 'the file is not valid JSON' }; }
  if (root.kind !== 'object') return { ok: false, reason: 'the top level is not an object' };
  const servers = memberOf(root, 'mcpServers');
  if (servers === 'duplicate') return { ok: false, reason: '"mcpServers" appears more than once' };
  if (!servers) return { ok: true, root };
  if (servers.value.kind !== 'object') return { ok: false, reason: '"mcpServers" is not an object' };
  return { ok: true, root, servers: servers.value };
}

const memberSource = (text: string, obj: ObjectNode, i: number): string => text.slice(obj.members[i].keyStart, obj.members[i].value.end);

/**
 * The byte range of member `i` with the separator Clubhouse wrote for it: the
 * line break and indent before it, and its own trailing comma, or, when it is
 * the last member, the comma after the member before it.
 */
function memberRemoval(text: string, obj: ObjectNode, i: number): Array<[number, number]> {
  const m = obj.members[i];
  let a = m.keyStart;
  let j = a;
  while (j > obj.start + 1 && (text[j - 1] === ' ' || text[j - 1] === '\t')) j--;
  if (text[j - 1] === '\n') a = j - 1;
  const b = m.value.end;
  let k = b;
  while (text[k] === ' ' || text[k] === '\t') k++;
  if (text[k] === ',') return [[a, k + 1]];
  if (i > 0) {
    let c = obj.members[i - 1].value.end;
    while (c < a && /[ \t\r\n]/.test(text[c])) c++;
    if (text[c] === ',') return [[c, c + 1], [a, b]];
  }
  return [[a, b]];
}

function cut(text: string, ranges: Array<[number, number]>): string {
  let out = text;
  for (const [a, b] of [...ranges].sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + out.slice(b);
  return out;
}

export type OwnedStrip =
  | { ok: true; text: string; removedBridge: number; removedManaged: string[]; removedContainer: boolean }
  | { ok: false; code: AntigravityMcpConfigErrorCode; reason: string };

/**
 * Remove members whose exact source hash a committed receipt lists, one at a
 * time from a fresh parse. Only top-level `mcpServers` members are considered,
 * so nested values and comments can never match.
 */
export function stripOwned(text: string, owned: CommittedOwnership, which: { bridge: boolean; managed: boolean }): OwnedStrip {
  let current = text;
  let removedBridge = 0;
  const removedManaged: string[] = [];
  for (;;) {
    const shape = shapeOf(current);
    if (shape.ok === false) return { ok: false, code: 'unparsable', reason: shape.reason };
    if (!shape.servers) break;
    const servers = shape.servers;
    const i = servers.members.findIndex((m, idx) => {
      const hash = sha256(memberSource(current, servers, idx));
      if (m.key === CLUBHOUSE_MCP_SERVER_NAME) return which.bridge && owned.bridge.includes(hash);
      return which.managed && (owned.managed[m.key] ?? []).includes(hash);
    });
    if (i < 0) {
      // The object Clubhouse added, once nothing is left in it.
      const member = shape.root.members.find((m) => m.key === 'mcpServers')!;
      const idx = shape.root.members.indexOf(member);
      if (owned.container && current.slice(member.keyStart, member.value.end) === CONTAINER_TEXT) {
        return { ok: true, text: cut(current, memberRemoval(current, shape.root, idx)), removedBridge, removedManaged, removedContainer: true };
      }
      break;
    }
    const key = servers.members[i].key;
    if (key === CLUBHOUSE_MCP_SERVER_NAME) removedBridge++; else removedManaged.push(key);
    current = cut(current, memberRemoval(current, servers, i));
  }
  return { ok: true, text: current, removedBridge, removedManaged, removedContainer: false };
}

/** Indentation of the first member when it sits on its own line. */
function memberIndent(text: string, obj: ObjectNode, fallback: string): string {
  const first = obj.members[0];
  if (!first) return fallback;
  const lineStart = text.lastIndexOf('\n', first.keyStart) + 1;
  const lead = text.slice(lineStart, first.keyStart);
  return /^[ \t]*$/.test(lead) && lineStart > obj.start ? lead : fallback;
}

const CONTAINER_TEXT = '"mcpServers": {}';

export type InsertResult = { ok: true; text: string; addedContainer: boolean } | { ok: false; code: AntigravityMcpConfigErrorCode; reason: string };

/**
 * Insert whole lines right after `mcpServers`' opening brace. When the object
 * is absent it is added first as its own line, `"mcpServers": {}`, so taking
 * the lines and then that line out gives back the original bytes.
 */
export function insertLines(text: string, lines: string[]): InsertResult {
  if (lines.length === 0) return { ok: true, text, addedContainer: false };
  let base = text;
  let shape = shapeOf(base);
  if (shape.ok === false) return { ok: false, code: 'unparsable', reason: shape.reason };
  let addedContainer = false;
  if (!shape.servers) {
    const at = shape.root.start + 1;
    const sep = shape.root.members.length > 0 ? ',' : '';
    base = `${base.slice(0, at)}\n  ${CONTAINER_TEXT}${sep}${base.slice(at)}`;
    addedContainer = true;
    shape = shapeOf(base);
    if (shape.ok === false || !shape.servers) return { ok: false, code: 'unparsable', reason: 'could not add "mcpServers"' };
  }
  const at = shape.servers.start + 1;
  const indent = memberIndent(base, shape.servers, '    ');
  const sep = shape.servers.members.length > 0 ? ',' : '';
  return { ok: true, text: `${base.slice(0, at)}\n${indent}${lines.join(`,\n${indent}`)}${sep}${base.slice(at)}`, addedContainer };
}

const namesOf = (text: string): string[] => {
  const shape = shapeOf(text);
  return shape.ok && shape.servers ? shape.servers.members.map((m) => m.key) : [];
};

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

export interface FileOptions {
  /** The home folder whose `.gemini` is off limits (tests pass a temp folder). */
  home?: string;
  bridgeScriptPath?: string;
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const unsafe = (what: string) => new AntigravityMcpConfigError('unsafe_path', `${ANTIGRAVITY_PATHS.mcpConfig}: ${what}; Clubhouse will not write through it. Fix the path, then start the agent again.`);

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try { return await fsp.lstat(p); }
  catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}

const within = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};

/** The checked target: no links at `.agents` or the file, and nowhere inside `~/.gemini`. */
async function safeTarget(worktree: string, home: string = os.homedir()): Promise<{ file: string; dir: string }> {
  const realWorktree = await fsp.realpath(worktree);
  const dir = path.join(realWorktree, ANTIGRAVITY_PATHS.configDir);
  const file = path.join(dir, 'mcp_config.json');
  const dirStat = await lstatOrNull(dir);
  if (dirStat && (dirStat.isSymbolicLink() || !dirStat.isDirectory())) throw unsafe('the .agents folder is a link or not a folder');
  const fileStat = await lstatOrNull(file);
  if (fileStat && (fileStat.isSymbolicLink() || !fileStat.isFile())) throw unsafe('the file is a link or not a regular file');
  const gemini = path.join(home, ANTIGRAVITY_GLOBAL_PATHS.globalMcp.split('/')[0]);
  const realGemini = await fsp.realpath(gemini).catch(() => path.resolve(gemini));
  if (within(dir, realGemini)) throw unsafe('the target is inside the Antigravity profile folder');
  return { file, dir };
}

async function readNoFollow(file: string): Promise<string | null> {
  let handle: fsp.FileHandle;
  try { handle = await fsp.open(file, fs.constants.O_RDONLY | NOFOLLOW); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw unsafe('the file is a link');
    throw err;
  }
  try { return await handle.readFile('utf-8'); }
  finally { await handle.close(); }
}

async function writeTemp(dir: string, text: string, mode: number): Promise<string> {
  const tmp = path.join(dir, `.mcp_config.json.tmp.${randomUUID().slice(0, 8)}`);
  const handle = await fsp.open(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW, mode);
  try { await handle.writeFile(text, 'utf-8'); }
  finally { await handle.close(); }
  return tmp;
}

/**
 * Replace `file` (holding `expected`, null: absent) with `next` (null:
 * delete). The current file is moved aside and compared before the new one is
 * linked in; `link` fails if a file appeared meanwhile. Returns 'conflict'
 * with the bytes left in place when the file was not what we expected.
 */
async function swapFile(file: string, dir: string, expected: string | null, next: string | null): Promise<'done' | 'conflict'> {
  const mode = (await lstatOrNull(file))?.mode ?? 0o644;
  const tmp = next === null ? null : await writeTemp(dir, next, mode & 0o777);
  try {
    if (expected === null) {
      if (tmp === null) return 'done';
      try { await fsp.link(tmp, file); return 'done'; }
      catch (err) { if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'conflict'; throw err; }
    }
    const aside = path.join(dir, `.mcp_config.json.prev.${randomUUID().slice(0, 8)}`);
    try { await fsp.rename(file, aside); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'conflict'; throw err; }
    const moved = await readNoFollow(aside);
    if (moved !== expected || (tmp !== null && await linkOrConflict(tmp, file) === 'conflict')) {
      // Put the moved bytes back unless something new took the path meanwhile.
      if (await linkOrConflict(aside, file) === 'done') await fsp.unlink(aside);
      else throw new AntigravityMcpConfigError('concurrent_edit', `${ANTIGRAVITY_PATHS.mcpConfig} changed while Clubhouse edited it; the earlier contents are kept at ${aside}.`);
      return 'conflict';
    }
    await fsp.unlink(aside);
    return 'done';
  } finally {
    if (tmp) await fsp.unlink(tmp).catch(() => { /* telemetry-exempt: already linked into place and removed */ });
  }
}

async function linkOrConflict(from: string, to: string): Promise<'done' | 'conflict'> {
  try { await fsp.link(from, to); return 'done'; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'conflict'; throw err; }
}

/** Serialize Clubhouse's own edits of the same file inside this process. */
const fileLocks = new Map<string, Promise<unknown>>();
function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.then(() => {}, () => {});
  fileLocks.set(key, tail);
  void tail.then(() => { if (fileLocks.get(key) === tail) fileLocks.delete(key); });
  return next;
}

/** The committed receipt, after settling a pending record a crash left (it never confers ownership). */
async function committedFor(file: string): Promise<CommittedOwnership> {
  const receipt = await receiptStore.get(file);
  if (!receipt) return emptyOwnership();
  if (receipt.pending) await receiptStore.set(file, ownsNothing(receipt.committed) && !receipt.committed.created ? undefined : { committed: receipt.committed });
  return receipt.committed;
}

const hashOrNull = (t: string | null): string | null => t === null ? null : sha256(t);

/**
 * One edit: compute `next` from the current bytes and committed ownership,
 * record it as pending, swap the file, then commit the new ownership. On any
 * failure after the pending record, it stays pending, which confers nothing.
 */
async function transact(
  worktree: string,
  options: FileOptions,
  plan: (current: string | null, owned: CommittedOwnership) => { next: string | null; owned: CommittedOwnership } | 'unchanged',
): Promise<{ file: string; changed: boolean; created: boolean; deleted: boolean }> {
  const { file, dir } = await safeTarget(worktree, options.home);
  return withFileLock(file, async () => {
    const current = await readNoFollow(file);
    const owned = await committedFor(file);
    if (current === null && (owned.created || !ownsNothing(owned))) {
      // The file is gone: nothing Clubhouse wrote is left to own.
      owned.created = false; owned.bridge = []; owned.managed = {};
    }
    const result = plan(current, owned);
    if (result === 'unchanged') return { file, changed: false, created: false, deleted: false };
    let createdDir = false;
    if (current === null && result.next !== null) {
      try { await fsp.mkdir(dir); createdDir = true; }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
      await safeTarget(worktree, options.home);
    }
    const committed: CommittedOwnership = { ...result.owned, createdDir: result.owned.createdDir || createdDir };
    await receiptStore.set(file, { committed: owned, pending: { txid: randomUUID(), beforeHash: hashOrNull(current), afterHash: hashOrNull(result.next) } });
    if (await swapFile(file, dir, current, result.next) === 'conflict') {
      await receiptStore.set(file, { committed: owned });
      throw new AntigravityMcpConfigError('concurrent_edit', `${ANTIGRAVITY_PATHS.mcpConfig} changed while Clubhouse edited it; nothing was written. Start the agent again.`);
    }
    const deleted = result.next === null;
    await receiptStore.set(file, deleted || (ownsNothing(committed) && !committed.created) ? undefined : { committed });
    if (deleted && committed.createdDir) {
      // rmdir only removes an empty folder: anything the person added stays.
      await fsp.rmdir(dir).catch(() => { /* telemetry-exempt: not empty, or already gone */ });
    }
    return { file, changed: true, created: current === null, deleted };
  });
}

/** Delete only a file Clubhouse created whose remainder is exactly the skeleton it wrote. */
const finalText = (text: string, owned: CommittedOwnership): string | null =>
  owned.created && ownsNothing(owned) && text === CREATED_SKELETON ? null : text;

const fail = (code: AntigravityMcpConfigErrorCode, reason: string): never => {
  throw new AntigravityMcpConfigError(code, `${ANTIGRAVITY_PATHS.mcpConfig}: ${reason}. Fix the file, then start the agent again.`);
};

export interface MergeOutcome { file: string; created: boolean }

/**
 * Merge the bridge line into `<worktree>/.agents/mcp_config.json`, replacing
 * a bridge line a committed receipt shows Clubhouse wrote earlier. Call
 * `configPipeline.snapshotFile` on the same path first, so stop and app quit
 * clean it up. `created` tells the caller to add the path to
 * `.git/info/exclude`. Throws AntigravityMcpConfigError, leaving the file as
 * it was, on any refusal: the agent must not start.
 */
export async function mergeAntigravityWorkspaceMcp(worktree: string, options: FileOptions = {}): Promise<MergeOutcome> {
  const line = bridgeMemberText(options.bridgeScriptPath);
  const { file, created } = await transact(worktree, options, (current, owned) => {
    const base = current ?? CREATED_SKELETON;
    const stripped = stripOwned(base, owned, { bridge: true, managed: false });
    if (stripped.ok === false) return fail(stripped.code, stripped.reason);
    if (namesOf(stripped.text).includes(CLUBHOUSE_MCP_SERVER_NAME)) {
      return fail('collision', 'a "clubhouse" server that Clubhouse did not write is configured');
    }
    const next = insertLines(stripped.text, [line]);
    if (next.ok === false) return fail(next.code, next.reason);
    return { next: next.text, owned: { ...owned, created: owned.created || current === null, bridge: [sha256(line)], container: owned.container || next.addedContainer } };
  });
  return { file, created };
}

/**
 * Managed delivery's servers (#3792) in the same file. Lines a committed
 * receipt shows Clubhouse delivered come out first, so servers dropped from
 * the setup go away, across app restarts too; an entry the person wrote or
 * edited is never touched, and a wanted name it already uses is refused.
 * Throws AntigravityMcpConfigError on any refusal, leaving the file as it was.
 */
export async function mergeAntigravityMcpServers(
  worktree: string,
  servers: Record<string, McpServerDef>,
  options: FileOptions = {},
): Promise<MergeOutcome> {
  if (CLUBHOUSE_MCP_SERVER_NAME in servers) fail('collision', 'a managed server may not be named "clubhouse"');
  const lines = Object.keys(servers).sort().map((name) => [name, managedMemberText(name, servers[name])] as const);
  const { file, created } = await transact(worktree, options, (current, owned) => {
    if (current === null && lines.length === 0) return 'unchanged';
    const stripped = stripOwned(current ?? CREATED_SKELETON, owned, { bridge: false, managed: true });
    if (stripped.ok === false) return fail(stripped.code, stripped.reason);
    const names = namesOf(stripped.text);
    const taken = lines.map(([n]) => n).filter((n) => names.includes(n));
    if (taken.length) fail('ambiguous_ownership', `MCP server ${taken.map((n) => JSON.stringify(n)).join(', ')} is already configured and Clubhouse has no record of writing it`);
    const next = insertLines(stripped.text, lines.map(([, l]) => l));
    if (next.ok === false) return fail(next.code, next.reason);
    const nextOwned: CommittedOwnership = {
      ...owned,
      created: owned.created || current === null,
      managed: Object.fromEntries(lines.map(([n, l]) => [n, [sha256(l)]])),
      container: (owned.container && !stripped.removedContainer) || next.addedContainer,
    };
    const text = finalText(next.text, nextOwned);
    return text === current ? 'unchanged' : { next: text, owned: nextOwned };
  });
  return { file, created };
}

/**
 * A plugin template's servers, written at agent creation like a `.mcp.json`
 * template entry: they become part of the person's config, with no receipt,
 * so no later Clubhouse cleanup removes them. A name already in use is refused.
 */
export async function addAntigravityTemplateMcpServers(
  worktree: string,
  servers: Record<string, McpServerDef>,
  options: FileOptions = {},
): Promise<MergeOutcome> {
  if (CLUBHOUSE_MCP_SERVER_NAME in servers) fail('collision', 'a template server may not be named "clubhouse"');
  const names = Object.keys(servers).sort();
  const { file, created } = await transact(worktree, options, (current, owned) => {
    if (names.length === 0) return 'unchanged';
    const base = current ?? CREATED_SKELETON;
    const taken = names.filter((n) => namesOf(base).includes(n));
    if (taken.length) fail('ambiguous_ownership', `MCP server ${taken.map((n) => JSON.stringify(n)).join(', ')} is already configured`);
    const next = insertLines(base, names.map((n) => managedMemberText(n, servers[n])));
    if (next.ok === false) return fail(next.code, next.reason);
    // Not created by Clubhouse for cleanup purposes: the template entries are the person's now.
    return { next: next.text, owned };
  });
  return { file, created };
}

export type RestoreResult = 'clean' | 'restored' | 'deleted' | { repair: string };

/**
 * Take the bridge line out of the workspace file, from its current bytes and
 * the committed receipt. Edits the person made while the agent ran are kept;
 * a file Clubhouse created and nobody touched is deleted. A `clubhouse` entry
 * without a committed receipt, a link, or bytes that don't parse are left as
 * they are and reported for repair. Managed servers are delivery's and stay.
 */
export async function restoreAntigravityWorkspaceMcp(file: string, options: FileOptions = {}): Promise<RestoreResult> {
  const worktree = path.dirname(path.dirname(path.resolve(file)));
  try {
    let leftover = false;
    const result = await transact(worktree, options, (current, owned) => {
      if (current === null) return 'unchanged';
      const stripped = stripOwned(current, owned, { bridge: true, managed: false });
      if (stripped.ok === false) return fail(stripped.code, stripped.reason);
      leftover = namesOf(stripped.text).includes(CLUBHOUSE_MCP_SERVER_NAME);
      if (stripped.removedBridge === 0) return 'unchanged';
      const nextOwned: CommittedOwnership = { ...owned, bridge: [], container: owned.container && !stripped.removedContainer };
      return { next: finalText(stripped.text, nextOwned), owned: nextOwned };
    });
    if (leftover) return { repair: 'a "clubhouse" server that Clubhouse has no record of writing is still configured' };
    return result.deleted ? 'deleted' : result.changed ? 'restored' : 'clean';
  } catch (err) {
    if (err instanceof AntigravityMcpConfigError) return { repair: err.message };
    throw err;
  }
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

/**
 * How long a launch has for its bridge to authenticate. Unmeasured: whether
 * agy starts stdio MCP servers at launch or on first use, and whether it
 * passes its environment to them, is undocumented (#3802 V3). Until V3 runs,
 * a real binary may fail this fence on every start; that is the fail-closed outcome.
 */
export const ANTIGRAVITY_BRIDGE_AUTH_DEADLINE_MS = 60_000;

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
