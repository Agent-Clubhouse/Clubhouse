/**
 * Receipt-owned edits of Antigravity workspace JSON files (#3793, #3794):
 * `.agents/mcp_config.json` (mcp-config.ts) and `.agents/hooks.json`.
 *
 * Edits are text edits bound to parsed members, either top-level or inside a
 * named top-level object (a "container", e.g. `mcpServers`). An entry goes in
 * as one line right after the object's opening brace and comes out by its
 * member span. The person's bytes (BOM, comments, order, formatting, other
 * entries) are never re-serialized, so a cycle with no edits restores the
 * file byte for byte.
 *
 * Ownership is never inferred from shape. Clubhouse removes or replaces an
 * entry only when a committed receipt (Clubhouse's userData, hashes only, no
 * values) lists the SHA-256 of that member's exact source text. A receipt is
 * two-phase: a pending record (before/after hashes) is written before the
 * file changes and committed only after the write is known to have happened.
 * A pending record never confers ownership; on recovery it is dropped, and
 * anything that looks like Clubhouse's without a committed hash is the
 * person's, which refuses rather than adopting it. A file is deleted only
 * when the receipt says Clubhouse created it and what is left is exactly the
 * skeleton Clubhouse wrote.
 *
 * Path safety: a symlinked or non-directory parent folder, a symlinked or
 * non-regular file, a path outside the worktree, or a target inside the home
 * folder's `.gemini` is refused before any write. Reads and temp files don't
 * follow links.
 *
 * Concurrency boundary: Clubhouse's own writers are serialized in-process.
 * Against other processes, the current file is moved aside atomically and
 * compared before the new one is linked into place (link fails if something
 * appeared meanwhile), so a writer that replaces the file by path is detected
 * and its bytes kept. Not covered: a writer that keeps an open descriptor to
 * the old file and writes through it after the compare, and readers during
 * the moment the file is moved aside, which see no file.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { app } from 'electron';
import { ANTIGRAVITY_GLOBAL_PATHS } from '../../../shared/providers/antigravity';
import { memberOf, parseJsonc, type JsoncNode } from './profile-reads';

/** Why an edit refused; every code means "do not launch with this config". */
export type AntigravityWorkspaceErrorCode =
  /** A reserved entry Clubhouse has no committed receipt for. */
  | 'collision'
  /** A file that can't be parsed, or whose shape makes ownership unclear. */
  | 'unparsable'
  /** A wanted entry name already used by one Clubhouse has no committed receipt for. */
  | 'ambiguous_ownership'
  /** The file changed while Clubhouse edited it. */
  | 'concurrent_edit'
  /** A symlink, a non-regular file, a path outside the worktree, or a target inside `~/.gemini`. */
  | 'unsafe_path';

export class AntigravityWorkspaceError extends Error {
  constructor(readonly code: AntigravityWorkspaceErrorCode, message: string) {
    super(message);
    this.name = 'AntigravityMcpConfigError';
  }
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** A member's identity in a receipt: its container (null: top level) and key. */
export const slotOf = (container: string | null, key: string): string => JSON.stringify([container, key]);

// ── Receipts ───────────────────────────────────────────────────────────────

/** What Clubhouse provably wrote. Hashes only: no values are stored. */
export interface CommittedOwnership {
  /** Clubhouse created the file (and `createdDir`: its parent folder). */
  created: boolean;
  createdDir: boolean;
  /** Per slot (slotOf), SHA-256 of each member's exact source text. */
  members: Record<string, string[]>;
  /** Containers Clubhouse added; each goes again once it is exactly `"name": {}`. */
  containers: string[];
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

export const emptyOwnership = (): CommittedOwnership => ({ created: false, createdDir: false, members: {}, containers: [] });
export const ownsNothing = (o: CommittedOwnership): boolean => Object.keys(o.members).length === 0 && o.containers.length === 0;

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
      throw new AntigravityWorkspaceError('unparsable', 'Clubhouse could not read its Antigravity workspace ownership record');
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

let receiptStore: ReceiptStore = fileReceiptStore(() => path.join(app.getPath('userData'), 'antigravity-workspace-receipts.json'));

/** Replace the receipt store (tests). Returns the previous one. */
export function setAntigravityReceiptStore(store: ReceiptStore): ReceiptStore {
  const previous = receiptStore;
  receiptStore = store;
  return previous;
}

// ── Pure text operations ───────────────────────────────────────────────────

type ObjectNode = JsoncNode & { kind: 'object' };
type Target = { ok: true; root: ObjectNode; obj?: ObjectNode } | { ok: false; reason: string };

/** The root, and the container object when `container` is given and present. */
function targetOf(text: string, container: string | null): Target {
  let root: JsoncNode;
  try { root = parseJsonc(text); }
  catch { return { ok: false, reason: 'the file is not valid JSON' }; }
  if (root.kind !== 'object') return { ok: false, reason: 'the top level is not an object' };
  if (container === null) return { ok: true, root, obj: root };
  const member = memberOf(root, container);
  if (member === 'duplicate') return { ok: false, reason: `${JSON.stringify(container)} appears more than once` };
  if (!member) return { ok: true, root };
  if (member.value.kind !== 'object') return { ok: false, reason: `${JSON.stringify(container)} is not an object` };
  return { ok: true, root, obj: member.value };
}

/** Whether the text parses into an object whose container (if any) is usable; the reason when not. */
export function shapeProblem(text: string, container: string | null): string | undefined {
  const t = targetOf(text, container);
  return t.ok === false ? t.reason : undefined;
}

/** Member keys at the top level or in `container`. */
export function keysOf(text: string, container: string | null): string[] {
  const t = targetOf(text, container);
  return t.ok === true && t.obj ? t.obj.members.map((m) => m.key) : [];
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
  | { ok: true; text: string; removed: string[]; removedContainers: string[] }
  | { ok: false; code: AntigravityWorkspaceErrorCode; reason: string };

/**
 * Remove members whose exact source hash a committed receipt lists, for the
 * slots `which` selects, one at a time from a fresh parse; then containers
 * Clubhouse added that are now exactly empty. Only members of the root or of
 * a named top-level container are considered, so nested values and comments
 * can never match.
 */
export function stripOwned(text: string, owned: CommittedOwnership, which: (slot: string) => boolean): OwnedStrip {
  let current = text;
  const removed: string[] = [];
  const removedContainers: string[] = [];
  const slots = Object.keys(owned.members).filter(which).map((slot) => ({ slot, parts: JSON.parse(slot) as [string | null, string] }));
  for (;;) {
    let hit: { obj: ObjectNode; i: number; slot: string } | undefined;
    for (const { slot, parts: [container, key] } of slots) {
      const t = targetOf(current, container);
      if (t.ok === false) return { ok: false, code: 'unparsable', reason: t.reason };
      const obj = t.obj;
      if (!obj) continue;
      const i = obj.members.findIndex((m, idx) => m.key === key && owned.members[slot].includes(sha256(memberSource(current, obj, idx))));
      if (i >= 0) { hit = { obj, i, slot }; break; }
    }
    if (!hit) break;
    removed.push(hit.slot);
    current = cut(current, memberRemoval(current, hit.obj, hit.i));
  }
  for (const container of owned.containers) {
    const t = targetOf(current, null);
    if (t.ok === false) return { ok: false, code: 'unparsable', reason: t.reason };
    const idx = t.root.members.findIndex((m) => m.key === container);
    if (idx >= 0 && memberSource(current, t.root, idx) === `${JSON.stringify(container)}: {}`) {
      current = cut(current, memberRemoval(current, t.root, idx));
      removedContainers.push(container);
    }
  }
  return { ok: true, text: current, removed, removedContainers };
}

/** Indentation of the first member when it sits on its own line. */
function memberIndent(text: string, obj: ObjectNode, fallback: string): string {
  const first = obj.members[0];
  if (!first) return fallback;
  const lineStart = text.lastIndexOf('\n', first.keyStart) + 1;
  const lead = text.slice(lineStart, first.keyStart);
  return /^[ \t]*$/.test(lead) && lineStart > obj.start ? lead : fallback;
}

export type InsertResult = { ok: true; text: string; addedContainer: boolean } | { ok: false; code: AntigravityWorkspaceErrorCode; reason: string };

/**
 * Insert whole member lines right after the opening brace of the root or of
 * `container`. A missing container is added first as its own line,
 * `"name": {}`, so taking the lines and then that line out gives back the
 * original bytes.
 */
export function insertLines(text: string, container: string | null, lines: string[]): InsertResult {
  if (lines.length === 0) return { ok: true, text, addedContainer: false };
  let base = text;
  let t = targetOf(base, container);
  if (t.ok === false) return { ok: false, code: 'unparsable', reason: t.reason };
  let addedContainer = false;
  if (!t.obj && container !== null) {
    const at = t.root.start + 1;
    const sep = t.root.members.length > 0 ? ',' : '';
    base = `${base.slice(0, at)}\n  ${JSON.stringify(container)}: {}${sep}${base.slice(at)}`;
    addedContainer = true;
    t = targetOf(base, container);
    if (t.ok === false || !t.obj) return { ok: false, code: 'unparsable', reason: `could not add ${JSON.stringify(container)}` };
  }
  const obj = t.obj!;
  const at = obj.start + 1;
  const indent = memberIndent(base, obj, container === null ? '  ' : '    ');
  const sep = obj.members.length > 0 ? ',' : '';
  return { ok: true, text: `${base.slice(0, at)}\n${indent}${lines.join(`,\n${indent}`)}${sep}${base.slice(at)}`, addedContainer };
}

/** A member line in the one form Clubhouse writes. */
export const memberLine = (key: string, valueJsonText: string): string => `${JSON.stringify(key)}: ${valueJsonText}`;

// ── File operations ────────────────────────────────────────────────────────

export interface FileOptions {
  /** The home folder whose `.gemini` is off limits (tests pass a temp folder). */
  home?: string;
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const unsafe = (relFile: string, what: string) =>
  new AntigravityWorkspaceError('unsafe_path', `${relFile}: ${what}; Clubhouse will not write through it. Fix the path, then start the agent again.`);

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

/**
 * The checked target: inside the worktree, no links at any folder below it
 * or at the file, and nowhere inside `~/.gemini`.
 */
async function safeTarget(worktree: string, relFile: string, home: string = os.homedir()): Promise<{ file: string; dir: string }> {
  const realWorktree = await fsp.realpath(worktree);
  const parts = relFile.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) throw unsafe(relFile, 'the path is not inside the worktree');
  const file = path.join(realWorktree, ...parts);
  const dir = path.dirname(file);
  let cur = realWorktree;
  for (const part of parts.slice(0, -1)) {
    cur = path.join(cur, part);
    const st = await lstatOrNull(cur);
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw unsafe(relFile, `${path.relative(realWorktree, cur)} is a link or not a folder`);
  }
  const fileStat = await lstatOrNull(file);
  if (fileStat && (fileStat.isSymbolicLink() || !fileStat.isFile())) throw unsafe(relFile, 'the file is a link or not a regular file');
  const gemini = path.join(home, ANTIGRAVITY_GLOBAL_PATHS.globalMcp.split('/')[0]);
  const realGemini = await fsp.realpath(gemini).catch(() => path.resolve(gemini));
  if (within(dir, realGemini)) throw unsafe(relFile, 'the target is inside the Antigravity profile folder');
  return { file, dir };
}

async function readNoFollow(file: string, relFile: string): Promise<string | null> {
  let handle: fsp.FileHandle;
  try { handle = await fsp.open(file, fs.constants.O_RDONLY | NOFOLLOW); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw unsafe(relFile, 'the file is a link');
    throw err;
  }
  try { return await handle.readFile('utf-8'); }
  finally { await handle.close(); }
}

async function writeTemp(file: string, text: string, mode: number): Promise<string> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp.${randomUUID().slice(0, 8)}`);
  const handle = await fsp.open(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW, mode);
  try { await handle.writeFile(text, 'utf-8'); }
  finally { await handle.close(); }
  return tmp;
}

async function linkOrConflict(from: string, to: string): Promise<'done' | 'conflict'> {
  try { await fsp.link(from, to); return 'done'; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'conflict'; throw err; }
}

/**
 * Replace `file` (holding `expected`, null: absent) with `next` (null:
 * delete). The current file is moved aside and compared before the new one is
 * linked in; `link` fails if a file appeared meanwhile. Returns 'conflict'
 * with the bytes left in place when the file was not what was expected.
 */
async function swapFile(file: string, relFile: string, expected: string | null, next: string | null): Promise<'done' | 'conflict'> {
  const mode = (await lstatOrNull(file))?.mode ?? 0o644;
  const tmp = next === null ? null : await writeTemp(file, next, mode & 0o777);
  try {
    if (expected === null) return tmp === null ? 'done' : await linkOrConflict(tmp, file);
    const aside = path.join(path.dirname(file), `.${path.basename(file)}.prev.${randomUUID().slice(0, 8)}`);
    try { await fsp.rename(file, aside); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'conflict'; throw err; }
    const moved = await readNoFollow(aside, relFile);
    if (moved !== expected || (tmp !== null && await linkOrConflict(tmp, file) === 'conflict')) {
      // Put the moved bytes back unless something new took the path meanwhile.
      if (await linkOrConflict(aside, file) === 'done') await fsp.unlink(aside);
      else throw new AntigravityWorkspaceError('concurrent_edit', `${relFile} changed while Clubhouse edited it; the earlier contents are kept at ${aside}.`);
      return 'conflict';
    }
    await fsp.unlink(aside);
    return 'done';
  } finally {
    if (tmp) await fsp.unlink(tmp).catch(() => { /* telemetry-exempt: already linked into place and removed */ });
  }
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
  const committed: CommittedOwnership = { ...emptyOwnership(), ...receipt.committed };
  if (receipt.pending) await receiptStore.set(file, ownsNothing(committed) && !committed.created ? undefined : { committed });
  return committed;
}

const hashOrNull = (t: string | null): string | null => t === null ? null : sha256(t);

export type Plan = { next: string | null; owned: CommittedOwnership } | 'unchanged';

/**
 * One edit of `<worktree>/<relFile>`: compute the next bytes from the current
 * bytes and committed ownership, record the write as pending, swap the file,
 * then commit the new ownership. On a failure after the pending record, it
 * stays pending, which confers nothing.
 */
export async function transact(
  worktree: string,
  relFile: string,
  options: FileOptions,
  plan: (current: string | null, owned: CommittedOwnership) => Plan,
): Promise<{ file: string; changed: boolean; created: boolean; deleted: boolean }> {
  const { file, dir } = await safeTarget(worktree, relFile, options.home);
  return withFileLock(file, async () => {
    const current = await readNoFollow(file, relFile);
    const owned = await committedFor(file);
    if (current === null && (owned.created || !ownsNothing(owned))) {
      // The file is gone: nothing Clubhouse wrote is left to own.
      owned.created = false; owned.members = {}; owned.containers = [];
    }
    const result = plan(current, owned);
    if (result === 'unchanged') return { file, changed: false, created: false, deleted: false };
    let createdDir = false;
    if (current === null && result.next !== null) {
      try { await fsp.mkdir(dir); createdDir = true; }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
      await safeTarget(worktree, relFile, options.home);
    }
    const committed: CommittedOwnership = { ...result.owned, createdDir: result.owned.createdDir || createdDir };
    await receiptStore.set(file, { committed: owned, pending: { txid: randomUUID(), beforeHash: hashOrNull(current), afterHash: hashOrNull(result.next) } });
    if (await swapFile(file, relFile, current, result.next) === 'conflict') {
      await receiptStore.set(file, ownsNothing(owned) && !owned.created ? undefined : { committed: owned });
      throw new AntigravityWorkspaceError('concurrent_edit', `${relFile} changed while Clubhouse edited it; nothing was written. Start the agent again.`);
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

/** Null (delete) only for a file Clubhouse created whose remainder is exactly the skeleton it wrote. */
export const finalText = (text: string, owned: CommittedOwnership, skeleton: string): string | null =>
  owned.created && ownsNothing(owned) && text === skeleton ? null : text;

export const fail = (relFile: string, code: AntigravityWorkspaceErrorCode, reason: string): never => {
  throw new AntigravityWorkspaceError(code, `${relFile}: ${reason}. Fix the file, then start the agent again.`);
};

// ── One owned member (hooks.json and similar) ──────────────────────────────

/** What Clubhouse writes when the file is absent, before its lines go in. */
export const TOP_LEVEL_SKELETON = '{}\n';

export interface OwnedMember {
  /** Null for a top-level member; else the top-level object holding it. */
  container: string | null;
  key: string;
}

/**
 * Insert (or replace) one Clubhouse-owned member, `"key": <valueJsonText>`.
 * A previous value is replaced only when a committed receipt proves Clubhouse
 * wrote it; any other member of that name refuses with 'collision'.
 * Throws AntigravityWorkspaceError, leaving the file as it was, on any refusal.
 */
export async function insertOwnedMember(
  worktree: string,
  relFile: string,
  member: OwnedMember & { valueJsonText: string },
  options: FileOptions = {},
): Promise<{ file: string; created: boolean }> {
  try { JSON.parse(member.valueJsonText); }
  catch { fail(relFile, 'unparsable', 'the value Clubhouse would write is not JSON'); }
  if (member.valueJsonText.includes('\n')) fail(relFile, 'unparsable', 'the value Clubhouse writes must be one line');
  const slot = slotOf(member.container, member.key);
  const line = memberLine(member.key, member.valueJsonText);
  const { file, created } = await transact(worktree, relFile, options, (current, owned) => {
    const stripped = stripOwned(current ?? TOP_LEVEL_SKELETON, owned, (s) => s === slot);
    if (stripped.ok === false) return fail(relFile, stripped.code, stripped.reason);
    if (keysOf(stripped.text, member.container).includes(member.key)) {
      return fail(relFile, 'collision', `a ${JSON.stringify(member.key)} entry that Clubhouse has no record of writing is configured`);
    }
    const next = insertLines(stripped.text, member.container, [line]);
    if (next.ok === false) return fail(relFile, next.code, next.reason);
    const containers = owned.containers.filter((c) => !stripped.removedContainers.includes(c));
    if (next.addedContainer && member.container) containers.push(member.container);
    return { next: next.text, owned: { ...owned, created: owned.created || current === null, members: { ...owned.members, [slot]: [sha256(line)] }, containers } };
  });
  return { file, created };
}

export type RemoveResult = 'clean' | 'restored' | 'deleted' | { repair: string };

/**
 * Remove one Clubhouse-owned member, from the current bytes and the committed
 * receipt. Edits elsewhere in the file are kept; a file Clubhouse created and
 * nobody touched is deleted. A member of that name without a committed
 * receipt, a link, or bytes that don't parse are left as they are and
 * reported for repair.
 */
export async function removeOwnedMember(
  worktree: string,
  relFile: string,
  member: OwnedMember,
  options: FileOptions & { skeleton?: string } = {},
): Promise<RemoveResult> {
  const slot = slotOf(member.container, member.key);
  try {
    let leftover = false;
    const result = await transact(worktree, relFile, options, (current, owned) => {
      if (current === null) return 'unchanged';
      const stripped = stripOwned(current, owned, (s) => s === slot);
      if (stripped.ok === false) return fail(relFile, stripped.code, stripped.reason);
      leftover = keysOf(stripped.text, member.container).includes(member.key);
      if (stripped.removed.length === 0) return 'unchanged';
      const members = { ...owned.members };
      delete members[slot];
      const nextOwned: CommittedOwnership = { ...owned, members, containers: owned.containers.filter((c) => !stripped.removedContainers.includes(c)) };
      return { next: finalText(stripped.text, nextOwned, options.skeleton ?? TOP_LEVEL_SKELETON), owned: nextOwned };
    });
    if (leftover) return { repair: `a ${JSON.stringify(member.key)} entry that Clubhouse has no record of writing is still configured` };
    return result.deleted ? 'deleted' : result.changed ? 'restored' : 'clean';
  } catch (err) {
    if (err instanceof AntigravityWorkspaceError) return { repair: err.message };
    throw err;
  }
}
