/**
 * The Dispatcher inspector's reads (#3912), for Dispatcher debug only:
 *
 * - each role's instructions file for every CLI, with the saved and the
 *   running CLI marked, and each role's session start;
 * - the skills installed in each role's active CLI skills folder;
 * - the memory index and one page at a time, with the memory reader's naming
 *   rules and caps, without recording a read;
 * - the memory access record (#3219), most recent first.
 *
 * Read-only: nothing here writes, deletes or regenerates. Every read stays in
 * the Dispatcher's own folders, memory included: each path part below a
 * folder is checked with lstat and a link anywhere is refused; a file with
 * more than one hard link is refused; files are opened without following
 * links and checked by fstat to be the plain file lstat saw; and no file is
 * read past its cap, however it grows. Content never goes to logs or
 * telemetry: callers log codes and counts.
 *
 * The gate is main's own: assertDispatcherDebugOn reads the saved
 * experimental settings, where a build that isn't preview-eligible reads the
 * flag as off.
 */
import { constants, type Stats } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { DispatcherRole } from '../../../shared/dispatcher-behavior';
import type {
  InspectorFile, InspectorFileError, InspectorInstructionFile, InspectorInstructions, InspectorMemoryAccess,
  InspectorMemoryIndex, InspectorMemoryPage, InspectorMemoryPageEntry, InspectorRoleSession, InspectorSessions,
  InspectorSkill, InspectorSkills,
} from '../../../shared/dispatcher-inspector';
import { MANAGED_SKILLS_MANIFEST, skillsFolderOf } from '../../../shared/skills-folder';
import { DISPATCHER_DEBUG_FLAG } from '../../../shared/types';
import type { OrchestratorProvider } from '../../orchestrators/types';
import { getSettings as getExperimentalSettings, savedSettingsUnreadable } from '../experimental-settings';
import {
  boundedMemoryText, listMemoryPages, MAX_MEMORY_PAGE_CHARS, MemoryReadError, resolveMemoryPage,
} from './dispatcher-memory-reader';
import { capIndex, memoryAccessPath, parseMemoryAccess, parseTopicPage } from './dispatcher-memory';

/** An instructions file's content at most. The built-in part is 16 KB; the rest is the person's text and the memory lookup. */
export const MAX_INSTRUCTIONS_BYTES = 256 * 1024;
/** A SKILL.md's content at most. */
export const MAX_SKILL_BYTES = 256 * 1024;
/** Skill folders listed per role at most. */
export const MAX_SKILLS_LISTED = 100;
/** The managed-skills manifest is a short list of names. */
const MAX_MANIFEST_BYTES = 64 * 1024;
/**
 * A memory page's bytes read at most: enough for the reader's 64,000-char cap
 * in any UTF-8 text. The rest of a longer page is never read.
 */
export const MAX_MEMORY_PAGE_BYTES = MAX_MEMORY_PAGE_CHARS * 4;
/** The access record holds at most 1,000 pages. */
export const MAX_ACCESS_RECORD_BYTES = 2 * 1024 * 1024;
/** Access entries returned at most. */
export const MAX_ACCESS_ENTRIES = 200;

const ROLES: readonly DispatcherRole[] = ['work', 'chat'];

/** Why a request was refused. The code is all that leaves main. */
export type InspectorErrorCode = 'debug_off' | 'invalid_request' | 'missing' | 'no_agent' | InspectorFileError;

export class InspectorError extends Error {
  constructor(readonly code: InspectorErrorCode) {
    super(`dispatcher_inspector:${code}`);
  }
}

/** Where the Dispatcher's files are and which CLI each role uses. Injected so tests need no app. */
export interface InspectorContext {
  folders: Record<DispatcherRole, string>;
  /** The memory folder, inside the work folder. */
  memoryRoot: string;
  providers: readonly OrchestratorProvider[];
  /** A role's saved and running CLI and its session start. */
  session: (role: DispatcherRole) => InspectorRoleSession;
}

// ── Gate ───────────────────────────────────────────────────────────────────

/** Dispatcher debug as main reads it: preview-only, so off in a stable build, and off while the file can't be read. */
export function isDispatcherDebugOn(): boolean {
  return !savedSettingsUnreadable() && getExperimentalSettings()[DISPATCHER_DEBUG_FLAG] === true;
}

export function assertDispatcherDebugOn(): void {
  if (!isDispatcherDebugOn()) throw new InspectorError('debug_off');
}

// ── Confined file access ──────────────────────────────────────────────────

const FILE_ERRORS: readonly string[] = ['link', 'not_file', 'too_large', 'changed', 'hard_link', 'outside', 'unreadable'];

function fileErrorCode(err: unknown): InspectorFileError {
  if (err instanceof InspectorError && FILE_ERRORS.includes(err.code)) return err.code as InspectorFileError;
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ELOOP' || code === 'EMLINK') return 'link';
  return 'unreadable';
}

/** Any failure as an InspectorError, keeping a request-level code. */
function asInspectorError(err: unknown): InspectorError {
  return err instanceof InspectorError ? err : new InspectorError(fileErrorCode(err));
}

function relativeInside(root: string, target: string): string[] | null {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  return parts.includes('..') ? null : parts;
}

/**
 * The path of `target` under `root`'s real path and its lstat, walking down
 * part by part. Null when a part is missing. Throws an InspectorError for a
 * link or a non-folder in the way, or a target outside `root`.
 */
async function confinedLstat(root: string, target: string): Promise<{ real: string; stat: Stats } | null> {
  const parts = relativeInside(path.resolve(root), path.resolve(target));
  if (!parts) throw new InspectorError('outside');
  let realRoot: string;
  try { realRoot = await fsp.realpath(root); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let current = realRoot;
  let stat: Stats | undefined;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try { stat = await fsp.lstat(current); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
      throw err;
    }
    if (stat.isSymbolicLink()) throw new InspectorError('link');
    if (i < parts.length - 1 && !stat.isDirectory()) throw new InspectorError('not_file');
  }
  return { real: current, stat: stat! };
}

/** Tests only: runs between the checks and the open, to change the file in that window. */
let beforeOpenHook: ((file: string) => Promise<void> | void) | null = null;
export function _setBeforeOpenHookForTesting(hook: typeof beforeOpenHook): void {
  beforeOpenHook = hook;
}

/** Up to `cap` bytes of a plain file, opened without following links and checked to be the single-link file lstat saw. */
async function readCapped(real: string, before: Stats, cap: number): Promise<{ content: string; truncated: boolean }> {
  if (beforeOpenHook) await beforeOpenHook(real);
  // O_NOFOLLOW doesn't exist on Windows; the dev/ino check below still catches a swap there.
  const file = await fsp.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new InspectorError('changed');
    if (opened.nlink > 1) throw new InspectorError('hard_link');
    // Sized from the open file, so growth after the lstat is cut at the cap too.
    const want = Math.min(opened.size, cap);
    const buffer = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      const { bytesRead } = await file.read(buffer, read, want - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    const truncated = opened.size > cap;
    // A cut inside a character drops that character rather than showing a broken one.
    const content = new TextDecoder('utf-8').decode(buffer.subarray(0, read), { stream: truncated });
    return { content, truncated };
  } finally {
    await file.close();
  }
}

/** A plain single-link file inside `root`, or null when it isn't there. Throws InspectorErrors. */
async function readConfined(root: string, target: string, cap: number, withContent = true): Promise<{
  stat: Stats; content?: string; truncated?: boolean;
} | null> {
  const found = await confinedLstat(root, target);
  if (!found) return null;
  if (!found.stat.isFile()) throw new InspectorError('not_file');
  if (found.stat.nlink > 1) throw new InspectorError('hard_link');
  if (!withContent) return { stat: found.stat };
  return { stat: found.stat, ...await readCapped(found.real, found.stat, cap) };
}

/** A file inside `root`, with content unless `withContent` is false. Never throws: a refusal is in the result. */
async function inspectFile(root: string, target: string, cap: number, withContent = true): Promise<InspectorFile> {
  try {
    const read = await readConfined(root, target, cap, withContent);
    if (!read) return { path: target, exists: false };
    return {
      path: target, exists: true, size: read.stat.size, mtimeMs: read.stat.mtimeMs,
      ...(read.content !== undefined && { content: read.content }),
      ...(read.truncated && { truncated: true }),
    };
  } catch (err) {
    // telemetry-exempt: the refusal is returned as a code; callers log codes only
    const error = fileErrorCode(err);
    // Outside the folder nothing was looked at; any other refusal means something is there.
    return { path: target, exists: error !== 'outside', error };
  }
}

// ── Sessions and instructions ─────────────────────────────────────────────

function sessions(ctx: InspectorContext): InspectorSessions {
  return { work: ctx.session('work'), chat: ctx.session('chat') };
}

/** Every CLI's instructions file in each role's folder, marked by the saved and running CLI. */
export async function inspectInstructions(ctx: InspectorContext): Promise<InspectorInstructions> {
  const current = sessions(ctx);
  const files: InspectorInstructionFile[] = [];
  for (const role of ROLES) {
    const folder = ctx.folders[role];
    const { saved, running } = current[role];
    for (const provider of ctx.providers) {
      if (!provider.instructionsPathOf) continue;
      let file: InspectorFile;
      try { file = await inspectFile(folder, provider.instructionsPathOf(folder), MAX_INSTRUCTIONS_BYTES); } catch {
        // telemetry-exempt: a CLI that can't name its file is shown as unavailable; the rest still load
        file = { path: '', exists: false, error: 'unreadable' };
      }
      files.push({
        ...file, role, provider: provider.id,
        active: provider.id === (running ?? saved), saved: provider.id === saved, running: provider.id === running,
      });
    }
  }
  return { sessions: current, files };
}

// ── Skills ─────────────────────────────────────────────────────────────────

/** The skills folder of the CLI the role works from: the running one, else the saved one. */
function skillsRootFor(ctx: InspectorContext, role: DispatcherRole): string | null {
  const { saved, running } = ctx.session(role);
  const id = running ?? saved;
  const provider = id ? ctx.providers.find((p) => p.id === id) : undefined;
  if (!provider) return null;
  return path.join(ctx.folders[role], ...skillsFolderOf(provider.conventions).split('/'));
}

function plainName(name: unknown): name is string {
  return typeof name === 'string' && !!name && name.length <= 200 && name === path.basename(name)
    && !/[\\/:\0]/.test(name) && name !== '.' && name !== '..';
}

async function managedNames(folder: string, root: string): Promise<Set<string>> {
  const manifest = await inspectFile(folder, path.join(root, MANAGED_SKILLS_MANIFEST), MAX_MANIFEST_BYTES);
  if (!manifest.content || manifest.truncated) return new Set();
  try {
    const raw = JSON.parse(manifest.content);
    return new Set(Array.isArray(raw?.skills) ? raw.skills.filter(plainName) : []);
  } catch {
    // telemetry-exempt: a manifest that isn't JSON names no skills; the folders are still listed
    return new Set();
  }
}

/** One role's skills, without content. Throws an InspectorError when its folder can't be listed. */
async function roleSkills(ctx: InspectorContext, role: DispatcherRole): Promise<{ skills: InspectorSkill[]; truncated: boolean }> {
  const root = skillsRootFor(ctx, role);
  if (!root) return { skills: [], truncated: false };
  const folder = ctx.folders[role];
  const found = await confinedLstat(folder, root);
  if (!found) return { skills: [], truncated: false };
  if (!found.stat.isDirectory()) throw new InspectorError('not_file');
  const listed = await fsp.readdir(found.real, { withFileTypes: true });
  // readdir follows a link swapped in after the check: look again, and list nothing if it isn't the same folder.
  const after = await fsp.lstat(found.real);
  if (after.isSymbolicLink() || !after.isDirectory() || after.dev !== found.stat.dev || after.ino !== found.stat.ino) {
    throw new InspectorError('changed');
  }
  const managed = await managedNames(folder, root);
  const entries = listed.filter((e) => e.isDirectory() && !e.isSymbolicLink() && plainName(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const skills: InspectorSkill[] = [];
  for (const entry of entries.slice(0, MAX_SKILLS_LISTED)) {
    // Each entry is checked again from the folder down; a link or a swap drops it.
    const file = await inspectFile(folder, path.join(root, entry.name, 'SKILL.md'), MAX_SKILL_BYTES, false);
    if (!file.exists || file.error === 'link' || file.error === 'outside' || file.error === 'changed') continue;
    skills.push({
      role, name: entry.name, path: file.path, managed: managed.has(entry.name),
      ...(file.size !== undefined && { size: file.size }),
      ...(file.mtimeMs !== undefined && { mtimeMs: file.mtimeMs }),
      ...(file.error && { error: file.error }),
    });
  }
  return { skills, truncated: entries.length > MAX_SKILLS_LISTED };
}

/** The skills in each role's CLI skills folder, without content. One role's failure leaves the other listed. */
export async function inspectSkills(ctx: InspectorContext): Promise<InspectorSkills> {
  const skills: InspectorSkill[] = [];
  const errors: Partial<Record<DispatcherRole, InspectorFileError>> = {};
  let truncated = false;
  for (const role of ROLES) {
    try {
      const listed = await roleSkills(ctx, role);
      skills.push(...listed.skills);
      truncated ||= listed.truncated;
    } catch (err) {
      // telemetry-exempt: shown per role by code; the caller's log has the counts
      errors[role] = fileErrorCode(err);
    }
  }
  return { skills, ...(truncated && { truncated: true }), ...(Object.keys(errors).length > 0 && { errors }) };
}

/** One skill's SKILL.md, from the role's CLI skills folder. */
export async function inspectSkill(ctx: InspectorContext, role: DispatcherRole, name: string): Promise<InspectorFile> {
  if (!ROLES.includes(role) || !plainName(name)) throw new InspectorError('invalid_request');
  const root = skillsRootFor(ctx, role);
  if (!root) throw new InspectorError('no_agent');
  const file = await inspectFile(ctx.folders[role], path.join(root, name, 'SKILL.md'), MAX_SKILL_BYTES);
  if (!file.exists) throw new InspectorError('missing');
  return file;
}

// ── Memory ─────────────────────────────────────────────────────────────────

/** The memory reader's refusal as a code; its message names the page, so it isn't passed on. */
function readErrorCode(err: MemoryReadError): InspectorErrorCode {
  if (/no memory page/.test(err.message)) return 'missing';
  if (/links/.test(err.message)) return 'link';
  if (/is not a page/.test(err.message)) return 'not_file';
  return 'invalid_request';
}

/** The memory folder's real path, or null when there is none. Refuses a memory folder that is a link. */
async function memoryRealRoot(ctx: InspectorContext): Promise<string | null> {
  const found = await confinedLstat(ctx.folders.work, ctx.memoryRoot);
  if (!found) return null;
  if (!found.stat.isDirectory()) throw new InspectorError('not_file');
  return found.real;
}

/** index.md and the pages, with the memory reader's caps (8 KB index, 64,000 chars, 300 pages). Records no read. */
export async function inspectMemoryIndex(ctx: InspectorContext): Promise<InspectorMemoryIndex> {
  try {
    const root = await memoryRealRoot(ctx);
    if (!root) return { exists: false, indexExists: false, text: '', pages: [] };
    const listing = await listMemoryPages(root);
    const pages: InspectorMemoryPageEntry[] = [];
    for (const page of listing.pages) {
      try {
        const stat = await fsp.lstat(path.join(root, ...page.split('/')));
        pages.push(stat.isFile() ? { page, size: stat.size, mtimeMs: stat.mtimeMs } : { page });
      } catch {
        // telemetry-exempt: a page gone since the listing is shown without its size
        pages.push({ page });
      }
    }
    const index = await readConfined(root, path.join(root, 'index.md'), MAX_MEMORY_PAGE_BYTES);
    const shaped = index ? boundedMemoryText(capIndex(index.content ?? '')) : { text: '' };
    return {
      exists: true, indexExists: !!index, text: shaped.text, pages,
      ...(shaped.truncated && { truncated: true }),
      ...(listing.truncated && { pagesTruncated: true }),
    };
  } catch (err) {
    throw asInspectorError(err);
  }
}

/** One memory page, by the memory reader's naming rules and caps, with a topic's Created and Updated (#3218). Records no read. */
export async function inspectMemoryPage(ctx: InspectorContext, page: string): Promise<InspectorMemoryPage> {
  if (typeof page !== 'string' || !page.trim() || page.length > 500) throw new InspectorError('invalid_request');
  try {
    const root = await memoryRealRoot(ctx);
    if (!root) throw new InspectorError('missing');
    let target: string;
    try { target = await resolveMemoryPage(page, root); } catch (err) {
      throw err instanceof MemoryReadError ? new InspectorError(readErrorCode(err)) : err;
    }
    const read = await readConfined(root, target, MAX_MEMORY_PAGE_BYTES);
    if (!read) throw new InspectorError('missing');
    const name = path.relative(root, target).split(path.sep).join('/');
    const shaped = boundedMemoryText(read.content ?? '');
    const topic = name.startsWith('topics/') ? parseTopicPage(shaped.text) : null;
    return {
      page: name, text: shaped.text, size: read.stat.size, mtimeMs: read.stat.mtimeMs,
      ...((shaped.truncated || read.truncated) && { truncated: true }),
      ...(topic?.created !== undefined && { created: topic.created }),
      ...(topic?.updated !== undefined && { updated: topic.updated }),
    };
  } catch (err) {
    throw asInspectorError(err);
  }
}

/** The access record (#3219), most recent first, at most MAX_ACCESS_ENTRIES pages, with each role's session start. */
export async function inspectMemoryAccess(ctx: InspectorContext): Promise<InspectorMemoryAccess> {
  const current = sessions(ctx);
  const none: InspectorMemoryAccess = { sessions: current, entries: [], total: 0 };
  const file = await inspectFile(ctx.folders.work, memoryAccessPath(ctx.memoryRoot), MAX_ACCESS_RECORD_BYTES);
  if (!file.exists) return none;
  if (file.error) return { ...none, error: file.error };
  if (file.truncated) return { ...none, error: 'too_large' };
  let pages: ReturnType<typeof parseMemoryAccess>;
  try { pages = parseMemoryAccess(file.content ?? ''); } catch {
    // telemetry-exempt: shown as an invalid record; the caller logs the code
    return { ...none, error: 'invalid' };
  }
  const recent = (e: { lastRead?: number; lastWrite?: number }) => Math.max(e.lastRead ?? 0, e.lastWrite ?? 0);
  const all = Object.entries(pages).sort((a, b) => recent(b[1]) - recent(a[1]) || a[0].localeCompare(b[0]));
  const entries = all.slice(0, MAX_ACCESS_ENTRIES).map(([page, e]) => ({
    page, reads: e.reads, writes: e.writes,
    ...(e.lastRead !== undefined && { lastRead: e.lastRead }),
    ...(e.lastWrite !== undefined && { lastWrite: e.lastWrite }),
    ...(e.lastWriter !== undefined && { lastWriter: e.lastWriter }),
  }));
  return { sessions: current, entries, total: all.length, ...(all.length > MAX_ACCESS_ENTRIES && { truncated: true }) };
}
