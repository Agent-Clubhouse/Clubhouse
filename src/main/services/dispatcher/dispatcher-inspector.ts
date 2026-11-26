/**
 * The Dispatcher inspector's reads (#3912), for Dispatcher debug only:
 *
 * - each role's instructions file for every CLI, the active one marked;
 * - the skills installed in each role's active CLI skills folder;
 * - the memory index and one page at a time, through the memory reader with
 *   its caps, without recording a read;
 * - the memory access record (#3219), most recent first.
 *
 * Read-only: nothing here writes, deletes or regenerates. Every read stays in
 * the Dispatcher's own folders: each path part below a folder is checked with
 * lstat, a link anywhere is refused, files are opened without following links
 * and checked to be the file that was looked at, and no file is read past its
 * cap. Content never goes to logs or telemetry: callers log codes and counts.
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
  InspectorMemoryIndex, InspectorMemoryPage, InspectorSkill, InspectorSkills,
} from '../../../shared/dispatcher-inspector';
import { MANAGED_SKILLS_MANIFEST, skillsFolderOf } from '../../../shared/skills-folder';
import { DISPATCHER_DEBUG_FLAG } from '../../../shared/types';
import type { OrchestratorProvider } from '../../orchestrators/types';
import { getSettings as getExperimentalSettings, savedSettingsUnreadable } from '../experimental-settings';
import { MemoryReadError, readDispatcherMemory, resolveMemoryPage } from './dispatcher-memory-reader';
import { memoryAccessPath, parseMemoryAccess, parseTopicPage } from './dispatcher-memory';

/** An instructions file's content at most. The built-in part is 16 KB; the rest is the person's text and the memory lookup. */
export const MAX_INSTRUCTIONS_BYTES = 256 * 1024;
/** A SKILL.md's content at most. */
export const MAX_SKILL_BYTES = 256 * 1024;
/** Skill folders listed per role at most. */
export const MAX_SKILLS_LISTED = 100;
/** The managed-skills manifest is a short list of names. */
const MAX_MANIFEST_BYTES = 64 * 1024;
/** A memory page the inspector hands to the reader at most; the reader then cuts it to 64,000 chars. */
export const MAX_MEMORY_PAGE_BYTES = 1024 * 1024;
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

/** Where the Dispatcher's files are and which CLI each role runs on. Injected so tests need no app. */
export interface InspectorContext {
  folders: Record<DispatcherRole, string>;
  /** The memory folder, inside the work folder. */
  memoryRoot: string;
  providers: readonly OrchestratorProvider[];
  /** The provider id each role runs on now, or null before that agent exists. */
  activeProvider: (role: DispatcherRole) => string | null;
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

function errorCode(err: unknown): InspectorFileError {
  if (err instanceof InspectorError && err.code !== 'debug_off' && err.code !== 'invalid_request' && err.code !== 'missing' && err.code !== 'no_agent') return err.code;
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ELOOP' || code === 'EMLINK') return 'link';
  return 'unreadable';
}

function relativeInside(root: string, target: string): string[] | null {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  return parts.includes('..') ? null : parts;
}

/**
 * The real path of `target` and its lstat, walking down from `root` part by
 * part. Null when a part is missing. Throws an InspectorError for a link or a
 * non-folder in the way, or a target outside `root`.
 */
async function confinedLstat(root: string, target: string): Promise<{ real: string; stat: Stats } | null> {
  let realRoot: string;
  try { realRoot = await fsp.realpath(root); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parts = relativeInside(path.resolve(root), path.resolve(target));
  if (!parts) throw new InspectorError('invalid_request');
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

/** Up to `cap` bytes of a plain file, opened without following links and checked to be the file lstat saw. */
async function readCapped(real: string, before: Stats, cap: number): Promise<{ content: string; truncated: boolean }> {
  const file = await fsp.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new InspectorError('changed');
    const want = Math.min(opened.size, cap);
    const buffer = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      const { bytesRead } = await file.read(buffer, read, want - read, read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    // A cut inside a character drops that character rather than showing a broken one.
    const content = new TextDecoder('utf-8').decode(buffer.subarray(0, read), { stream: opened.size > cap });
    return { content, truncated: opened.size > cap };
  } finally {
    await file.close();
  }
}

/** A file inside `root`, with content unless `withContent` is false. Never throws for the file itself; the error is in the result. */
async function inspectFile(root: string, target: string, cap: number, withContent = true): Promise<InspectorFile> {
  const result: InspectorFile = { path: target, exists: false };
  try {
    const found = await confinedLstat(root, target);
    if (!found) return result;
    result.exists = true;
    if (!found.stat.isFile()) return { ...result, error: 'not_file' };
    result.size = found.stat.size;
    result.mtimeMs = found.stat.mtimeMs;
    if (!withContent) return result;
    const { content, truncated } = await readCapped(found.real, found.stat, cap);
    return { ...result, content, ...(truncated && { truncated: true }) };
  } catch (err) {
    if (err instanceof InspectorError && err.code === 'invalid_request') throw err;
    // A missing part reads as null above, so an error means something is there.
    return { ...result, exists: true, error: errorCode(err) };
  }
}

// ── Instructions ───────────────────────────────────────────────────────────

/** Every CLI's instructions file in each role's folder; the role's current CLI is active. */
export async function inspectInstructions(ctx: InspectorContext): Promise<InspectorInstructions> {
  const active = { work: ctx.activeProvider('work'), chat: ctx.activeProvider('chat') };
  const files: InspectorInstructionFile[] = [];
  for (const role of ROLES) {
    const folder = ctx.folders[role];
    for (const provider of ctx.providers) {
      if (!provider.instructionsPathOf) continue;
      const file = await inspectFile(folder, provider.instructionsPathOf(folder), MAX_INSTRUCTIONS_BYTES);
      files.push({ ...file, role, provider: provider.id, active: provider.id === active[role] });
    }
  }
  return { active, files };
}

// ── Skills ─────────────────────────────────────────────────────────────────

function skillsRootFor(ctx: InspectorContext, role: DispatcherRole): string | null {
  const id = ctx.activeProvider(role);
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

/** The skills in each role's active CLI skills folder, without content. */
export async function inspectSkills(ctx: InspectorContext): Promise<InspectorSkills> {
  const skills: InspectorSkill[] = [];
  let truncated = false;
  for (const role of ROLES) {
    const root = skillsRootFor(ctx, role);
    if (!root) continue;
    const folder = ctx.folders[role];
    let found: Awaited<ReturnType<typeof confinedLstat>>;
    try { found = await confinedLstat(folder, root); } catch {
      // telemetry-exempt: a link or file in place of the skills folder lists nothing
      continue;
    }
    if (!found || !found.stat.isDirectory()) continue;
    const managed = await managedNames(folder, root);
    const entries = (await fsp.readdir(found.real, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && plainName(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length > MAX_SKILLS_LISTED) truncated = true;
    for (const entry of entries.slice(0, MAX_SKILLS_LISTED)) {
      const file = await inspectFile(folder, path.join(root, entry.name, 'SKILL.md'), MAX_SKILL_BYTES, false);
      if (!file.exists) continue;
      skills.push({
        role, name: entry.name, path: file.path, managed: managed.has(entry.name),
        ...(file.size !== undefined && { size: file.size }),
        ...(file.mtimeMs !== undefined && { mtimeMs: file.mtimeMs }),
        ...(file.error && { error: file.error }),
      });
    }
  }
  return { skills, ...(truncated && { truncated: true }) };
}

/** One skill's SKILL.md, from the role's active CLI skills folder. */
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

/** index.md and the pages, through the memory reader's caps (64,000 chars, 300 pages). Records no read. */
export async function inspectMemoryIndex(ctx: InspectorContext): Promise<InspectorMemoryIndex> {
  const root = await memoryRealRoot(ctx);
  if (!root) return { exists: false, text: '', pages: [] };
  const index = await confinedLstat(root, path.join(root, 'index.md'));
  if (index?.stat.isFile() && index.stat.size > MAX_MEMORY_PAGE_BYTES) throw new InspectorError('too_large');
  let read: Awaited<ReturnType<typeof readDispatcherMemory>>;
  try { read = await readDispatcherMemory(undefined, root, { record: false }); } catch (err) {
    throw err instanceof MemoryReadError ? new InspectorError(readErrorCode(err)) : err;
  }
  const pages = [];
  for (const page of read.pages ?? []) {
    try {
      const stat = await fsp.lstat(path.join(root, ...page.split('/')));
      pages.push(stat.isFile() ? { page, size: stat.size, mtimeMs: stat.mtimeMs } : { page });
    } catch {
      // telemetry-exempt: a page gone since the listing is shown without its size
      pages.push({ page });
    }
  }
  return {
    exists: true, text: read.text, pages,
    ...(read.truncated && { truncated: true }),
    ...(read.pagesTruncated && { pagesTruncated: true }),
  };
}

/** One memory page, through the memory reader's rules and caps, with a topic's Created and Updated (#3218). Records no read. */
export async function inspectMemoryPage(ctx: InspectorContext, page: string): Promise<InspectorMemoryPage> {
  if (typeof page !== 'string' || !page.trim() || page.length > 500) throw new InspectorError('invalid_request');
  const root = await memoryRealRoot(ctx);
  if (!root) throw new InspectorError('missing');
  let target: string;
  try { target = await resolveMemoryPage(page, root); } catch (err) {
    throw err instanceof MemoryReadError ? new InspectorError(readErrorCode(err)) : err;
  }
  const stat = await fsp.lstat(target);
  if (!stat.isFile()) throw new InspectorError('not_file');
  if (stat.size > MAX_MEMORY_PAGE_BYTES) throw new InspectorError('too_large');
  const read = await readDispatcherMemory(page, root, { record: false });
  const name = read.page ?? page;
  const topic = name.startsWith('topics/') ? parseTopicPage(read.text) : null;
  return {
    page: name, text: read.text, size: stat.size, mtimeMs: stat.mtimeMs,
    ...(read.truncated && { truncated: true }),
    ...(topic?.created !== undefined && { created: topic.created }),
    ...(topic?.updated !== undefined && { updated: topic.updated }),
  };
}

/** The access record (#3219), most recent first, at most MAX_ACCESS_ENTRIES pages. */
export async function inspectMemoryAccess(ctx: InspectorContext): Promise<InspectorMemoryAccess> {
  const file = await inspectFile(ctx.folders.work, memoryAccessPath(ctx.memoryRoot), MAX_ACCESS_RECORD_BYTES);
  if (!file.exists) return { entries: [], total: 0 };
  if (file.error) return { entries: [], total: 0, error: file.error };
  if (file.truncated) return { entries: [], total: 0, error: 'too_large' };
  let pages: ReturnType<typeof parseMemoryAccess>;
  try { pages = parseMemoryAccess(file.content ?? ''); } catch {
    // telemetry-exempt: shown as an invalid record; the caller logs the code
    return { entries: [], total: 0, error: 'invalid' };
  }
  const recent = (e: { lastRead?: number; lastWrite?: number }) => Math.max(e.lastRead ?? 0, e.lastWrite ?? 0);
  const all = Object.entries(pages).sort((a, b) => recent(b[1]) - recent(a[1]) || a[0].localeCompare(b[0]));
  const entries = all.slice(0, MAX_ACCESS_ENTRIES).map(([page, e]) => ({
    page, reads: e.reads, writes: e.writes,
    ...(e.lastRead !== undefined && { lastRead: e.lastRead }),
    ...(e.lastWrite !== undefined && { lastWrite: e.lastWrite }),
    ...(e.lastWriter !== undefined && { lastWriter: e.lastWriter }),
  }));
  return { entries, total: all.length, ...(all.length > MAX_ACCESS_ENTRIES && { truncated: true }) };
}
