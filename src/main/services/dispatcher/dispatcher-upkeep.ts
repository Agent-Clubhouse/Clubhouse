/**
 * Memory upkeep (#3040): the part Clubhouse does itself, with no model and no
 * tokens. The hidden upkeep Actions run it first; whatever needs judgment
 * (does a transcript back this note?) is then handed to the Dispatcher, and
 * only when there is something to check (dispatcher-background.ts).
 *
 *   1. Roll the timeline up: days into weeks, weeks into months (rollUpTimeline).
 *   2. Fix links that moved: a day rolled into its week, a week into its month,
 *      a page linked by its title instead of its file name, a page that went to
 *      the archive. A link it can't fix is reported, never removed.
 *   3. Prune stale pages: a topic still unconfirmed, untouched for
 *      `staleDays`, that no kept page links to or names moves to
 *      `memory/archive/topics/`. Nothing is deleted. Confirmed topics, agent
 *      pages, the timeline and the index are never pruned.
 *   4. Check cited sources: a topic's Source and the timeline's transcript
 *      links that point at a file that is gone are reported.
 *
 * Idempotent: a second run with nothing new changes nothing. An agent page's
 * card is the agent's own section, so only its notes are ever edited.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  AGENT_NOTES_HEADING,
  MEMORY_INDEX_CAP_BYTES,
  memoryPaths,
  memorySlug,
  parseTopicPage,
  topicUpdatedAt,
  hasConflictNotes,
  readIfExists,
  memoryWrite,
  withMemoryPageLock,
  moveMemoryHistory,
  observeMemoryPage,
  readMemoryAccess,
  pruneMemoryHistory,
  MEMORY_HISTORY_DIR,
  type TopicStatus,
} from './dispatcher-memory';
import { isoWeekOf, linkTargets, rollUpTimeline, type RollupResult } from './dispatcher-memory-timeline';
import type { DispatcherMemoryHealth } from '../../telemetry/dispatcher-telemetry';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const WEEK_FILE = /^(\d{4})-W(\d{2})\.md$/;

/** Where pruned pages go, inside memory so Forget everything clears them too. */
export const MEMORY_ARCHIVE_DIR = 'archive';

/** An unconfirmed topic nobody touched or linked to for this long is pruned. */
export const DEFAULT_STALE_DAYS = 30;

export interface UpkeepOptions {
  root?: string;
  keepDays?: number;
  keepWeeks?: number;
  staleDays?: number;
  neglectDays?: number;
  /** Whether a cited file exists. Defaults to the file system. */
  fileExists?: (file: string) => Promise<boolean>;
}

export interface MemoryPage {
  /** Path inside memory with forward slashes, e.g. `topics/checkout.md`. */
  page: string;
  mtimeMs: number;
  /** Topics only: their Status line. */
  status?: TopicStatus;
  updatedAt?: number;
}

export interface UpkeepReport {
  rolledUp: RollupResult;
  linksFixed: Array<{ page: string; from: string; to: string }>;
  /** Pages moved to the archive, by their old path. */
  archived: string[];
  /** Links between memory pages that point nowhere and couldn't be fixed. */
  brokenLinks: Array<{ page: string; target: string }>;
  /** Cited files (transcripts, mostly) that are gone. */
  missingSources: Array<{ page: string; source: string }>;
  conflictingPages: string[];
  directEdits: string[];
  neglectedPages: string[];
  /** Whether anything on disk changed. */
  changed: boolean;
}

const toPosix = (p: string): string => p.split(path.sep).join('/');

async function defaultFileExists(file: string): Promise<boolean> {
  try {
    await fsp.stat(file);
    return true;
  } catch {
    // telemetry-exempt: missing or unreadable both count as gone
    return false;
  }
}

/**
 * Every page in memory, not counting the archive, with when it last changed.
 * Mechanical link repairs preserve these times so only agent edits trigger review.
 */
export async function listMemoryPages(root?: string, nowMs: number = Date.now()): Promise<MemoryPage[]> {
  const base = memoryPaths(root).root;
  const out: MemoryPage[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dir === base && (entry.name === MEMORY_ARCHIVE_DIR || entry.name === MEMORY_HISTORY_DIR)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const page = toPosix(path.relative(base, full));
      const stat = await fsp.stat(full);
      const item: MemoryPage = { page, mtimeMs: stat.mtimeMs };
      if (page.startsWith('topics/')) {
        const parsed = parseTopicPage((await readIfExists(full)) ?? '');
        if (parsed) {
          item.status = parsed.status;
          item.updatedAt = topicUpdatedAt(parsed, stat.mtimeMs, nowMs);
        }
      }
      out.push(item);
    }
  }
  await walk(base);
  return out.sort((a, b) => a.page.localeCompare(b.page));
}

// ── Links ──────────────────────────────────────────────────────────────────

/** A web address or other URI: not a file. A Windows drive (`C:\`) is a file. */
function isUri(target: string): boolean {
  return /^[a-z][a-z0-9+.-]+:/i.test(target) && !/^[a-z]:[\\/]/i.test(target);
}

function isAbsoluteFile(target: string): boolean {
  return path.isAbsolute(target) || /^[a-z]:[\\/]/i.test(target);
}

function splitAnchor(target: string): { file: string; anchor: string } {
  const at = target.indexOf('#');
  return at < 0 ? { file: target, anchor: '' } : { file: target.slice(0, at), anchor: target.slice(at) };
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    // telemetry-exempt: a stray % is read as written
    return text;
  }
}

/**
 * Where a relative link from a page could point: next to the page, from the
 * memory root, or from the Dispatcher's folder (search hits link
 * `memory/topics/x.md`). Absolute paths are themselves.
 */
function candidates(root: string, page: string, file: string): string[] {
  const decoded = safeDecode(file);
  if (isAbsoluteFile(decoded)) return [path.normalize(decoded)];
  const out = [path.join(root, path.dirname(page), decoded), path.join(root, decoded)];
  if (/^memory[\\/]/.test(decoded)) out.push(path.join(path.dirname(root), decoded));
  return [...new Set(out.map((p) => path.normalize(p)))];
}

function insideMemory(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The month a week rolls into: its Thursday's, as rollUpTimeline does. */
function monthOfWeek(week: string): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(week)!;
  const year = Number(match[1]);
  const jan4 = Date.UTC(year, 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() || 7) - 1) * DAY_MS + (Number(match[2]) - 1) * 7 * DAY_MS;
  const thursday = new Date(monday + 3 * DAY_MS);
  return `${thursday.getUTCFullYear()}-${String(thursday.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface Resolver {
  exists(file: string): boolean;
}

/**
 * Where a link that points nowhere went, or null. Its anchor names the rolled
 * section (`## 2026-11-02` in the week, `## 2026-W45` in the month).
 */
function relocate(root: string, page: string, file: string, files: Resolver): { file: string; anchor?: string } | null {
  const paths = memoryPaths(root);
  const name = path.basename(safeDecode(file));
  const day = DAY_FILE.exec(name);
  if (day) {
    const { week } = isoWeekOf(day[1]);
    const weekFile = path.join(paths.timeline, `${week}.md`);
    if (files.exists(weekFile)) return { file: weekFile, anchor: day[1] };
    const monthFile = path.join(paths.timeline, `${monthOfWeek(week)}.md`);
    if (files.exists(monthFile)) return { file: monthFile, anchor: week.toLowerCase() };
    return null;
  }
  if (WEEK_FILE.test(name)) {
    const week = name.slice(0, -3);
    const monthFile = path.join(paths.timeline, `${monthOfWeek(week)}.md`);
    if (files.exists(monthFile)) return { file: monthFile, anchor: week.toLowerCase() };
    return null;
  }
  // A page linked by its title, or one that went to the archive.
  for (const candidate of candidates(root, page, file)) {
    if (!insideMemory(root, candidate)) continue;
    const rel = toPosix(path.relative(root, candidate));
    const folder = rel.split('/')[0];
    if (folder !== 'topics' && folder !== 'agents') continue;
    const slugged = path.join(root, folder, `${memorySlug(path.basename(candidate).replace(/\.md$/i, ''))}.md`);
    if (files.exists(slugged)) return { file: slugged };
    const archived = path.join(root, MEMORY_ARCHIVE_DIR, folder, path.basename(slugged));
    if (files.exists(archived)) return { file: archived };
  }
  return null;
}

/** The link as the page should write it: relative to the page, forward slashes. */
function linkFrom(root: string, page: string, file: string, anchor?: string): string {
  const rel = toPosix(path.relative(path.dirname(path.join(root, page)), file));
  return `${rel}${anchor ? `#${anchor}` : ''}`;
}

/**
 * The part of a page upkeep may edit: everything, except on an agent page,
 * where only the notes under `## Notes` are the Dispatcher's.
 */
function editableRange(page: string, text: string): { start: number; end: number } {
  if (!page.startsWith('agents/')) return { start: 0, end: text.length };
  const match = new RegExp(`^${AGENT_NOTES_HEADING}[ \\t]*$`, 'm').exec(text);
  return match ? { start: match.index + match[0].length, end: text.length } : { start: text.length, end: text.length };
}

function replaceLinks(text: string, replacements: Map<string, string>): string {
  if (!replacements.size) return text;
  return text.replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
    const next = replacements.get(target);
    return next === undefined ? whole : `](${next})`;
  });
}

// ── Upkeep ─────────────────────────────────────────────────────────────────

/** The files in memory now, archive included, for quick existence checks. */
async function snapshot(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  async function walk(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !(dir === root && entry.name === MEMORY_HISTORY_DIR)) await walk(full);
      else out.add(path.normalize(full));
    }
  }
  await walk(root);
  return out;
}

/** Whether `text` links to or names the topic file `file` (from page `page`). */
function refersTo(root: string, page: string, text: string, file: string): boolean {
  for (const target of linkTargets(text)) {
    if (isUri(target)) continue;
    const { file: linked } = splitAnchor(target);
    if (!linked) continue;
    for (const c of candidates(root, page, linked)) {
      if (c === file) return true;
      // A link by title counts, since upkeep fixes it to this page.
      if (path.dirname(c) === path.dirname(file) && path.join(path.dirname(c), `${memorySlug(path.basename(c).replace(/\.md$/i, ''))}.md`) === file) return true;
    }
  }
  // Named without a link: `topics/checkout.md` or `topics/checkout`.
  const name = path.basename(file, '.md');
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])topics/${escaped}(\\.md)?(?![\\w-])`, 'm').test(text);
}

/** A free name in the archive folder: `x.md`, then `x-2.md`, and so on. */
async function archiveTarget(root: string, folder: string, name: string): Promise<string> {
  const dir = path.join(root, MEMORY_ARCHIVE_DIR, folder);
  await fsp.mkdir(dir, { recursive: true });
  const stem = name.replace(/\.md$/i, '');
  for (let n = 1; ; n++) {
    const target = path.join(dir, n === 1 ? `${stem}.md` : `${stem}-${n}.md`);
    if ((await readIfExists(target)) === null) return target;
  }
}

/** The files a topic's Source line or a page's links cite outside memory. */
function citedFiles(root: string, page: string, text: string): string[] {
  const out = new Set<string>();
  const consider = (target: string) => {
    if (isUri(target)) return;
    const { file } = splitAnchor(target);
    const decoded = safeDecode(file);
    if (!decoded || !isAbsoluteFile(decoded)) return;
    const normalized = path.normalize(decoded);
    if (insideMemory(root, normalized)) return;
    out.add(target);
  };
  for (const target of linkTargets(text)) consider(target);
  if (page.startsWith('topics/')) {
    const parsed = parseTopicPage(text);
    const bare = parsed?.source.trim();
    // A Source that is one bare path, e.g. a search hit's `<file>#L12`.
    if (bare && !/\s/.test(bare)) consider(bare);
  }
  return [...out];
}

export async function runMemoryUpkeep(now: Date, options: UpkeepOptions = {}): Promise<UpkeepReport> {
  const root = memoryPaths(options.root).root;
  const fileExists = options.fileExists ?? defaultFileExists;
  const staleMs = (options.staleDays ?? DEFAULT_STALE_DAYS) * DAY_MS;
  const report: UpkeepReport = { rolledUp: { days: [], weeks: [] }, linksFixed: [], archived: [], brokenLinks: [], missingSources: [], conflictingPages: [], directEdits: [], neglectedPages: [], changed: false };
  if ((await readIfExists(path.join(root, 'index.md'))) === null && (await snapshot(root)).size === 0) return report;

  const before = await readMemoryAccess(root);
  for (const { page } of await listMemoryPages(root)) await observeMemoryPage(page, root, now.getTime());
  const observed = await readMemoryAccess(root);
  report.directEdits = Object.entries(observed).filter(([page, entry]) => entry.lastWriter === 'agent direct'
    && (entry.observed?.mtimeMs !== before[page]?.observed?.mtimeMs || entry.observed?.hash !== before[page]?.observed?.hash)).map(([page]) => page);
  await pruneMemoryHistory(root, now.getTime());

  // 1. Timeline.
  report.rolledUp = await rollUpTimeline(now, { keepDays: options.keepDays, keepWeeks: options.keepWeeks }, root);
  if (report.rolledUp.days.length || report.rolledUp.weeks.length) report.changed = true;

  // 2. Links between pages.
  const files = await snapshot(root);
  const resolver: Resolver = { exists: (f) => files.has(path.normalize(f)) };
  let pages = await listMemoryPages(root, now.getTime());
  for (const { page } of pages) {
    const full = path.join(root, page);
    const text = (await readIfExists(full)) ?? '';
    const range = editableRange(page, text);
    const editable = text.slice(range.start, range.end);
    const replacements = new Map<string, string>();
    for (const target of linkTargets(text)) {
      if (isUri(target)) continue;
      const { file, anchor } = splitAnchor(target);
      if (!file) continue;
      const where = candidates(root, page, file);
      // Outside memory: a cited file, checked in step 4.
      if (!where.some((c) => insideMemory(root, c))) continue;
      if (where.some((c) => resolver.exists(c))) continue;
      const moved = relocate(root, page, file, resolver);
      const inEditable = editable.includes(`](${target})`);
      if (moved && inEditable) {
        const next = linkFrom(root, page, moved.file, moved.anchor ?? (anchor ? anchor.slice(1) : undefined));
        replacements.set(target, next);
        report.linksFixed.push({ page, from: target, to: next });
      } else {
        report.brokenLinks.push({ page, target });
      }
    }
    if (!replacements.size) continue;
    const next = `${text.slice(0, range.start)}${replaceLinks(editable, replacements)}${text.slice(range.end)}`;
    if (next !== text) {
      // Link maintenance is not a new fact or a freshness signal.
      await memoryWrite(page, (current) => {
        if (current === null) throw new Error('Memory page disappeared during link repair.');
        const range = editableRange(page, current);
        return current.slice(0, range.start) + replaceLinks(current.slice(range.start, range.end), replacements) + current.slice(range.end);
      }, 'upkeep link fix', root, { preserveFreshness: true });
      report.changed = true;
    }
  }

  // 3. Stale topics, until nothing more is stale: a page only a pruned page named is stale too,
  //    so a second run finds nothing left to do.
  pages = await listMemoryPages(root, now.getTime());
  const texts = new Map<string, string>();
  for (const { page } of pages) texts.set(page, (await readIfExists(path.join(root, page))) ?? '');
  const kept = new Set(pages.map((p) => p.page));
  for (;;) {
    const stale = pages.filter((p) => {
      if (!kept.has(p.page) || !p.page.startsWith('topics/') || p.status !== 'unconfirmed') return false;
      if (hasConflictNotes(texts.get(p.page) ?? '')) return false;
      if (now.getTime() - (p.updatedAt ?? p.mtimeMs) < staleMs) return false;
      const file = path.normalize(path.join(root, p.page));
      for (const other of kept) {
        if (other === p.page) continue;
        if (refersTo(root, other, texts.get(other) ?? '', file)) return false;
      }
      return true;
    });
    if (!stale.length) break;
    for (const p of stale) kept.delete(p.page);
  }
  for (const p of pages) {
    if (kept.has(p.page)) continue;
    const to = await archiveTarget(root, 'topics', path.basename(p.page));
    await withMemoryPageLock(p.page, root, async (from) => {
      const current = await readIfExists(from);
      if (current === null) return;
      const stat = await fsp.stat(from);
      const topic = parseTopicPage(current);
      if (topic?.status !== 'unconfirmed' || hasConflictNotes(current)
        || now.getTime() - topicUpdatedAt(topic, stat.mtimeMs, now.getTime()) < staleMs) return;
      await memoryWrite(toPosix(path.relative(root, to)), current, 'archive', root,
        { preserveFreshness: true, timestamps: stat });
      await moveMemoryHistory(p.page, toPosix(path.relative(root, to)), root);
      await fsp.rm(from);
      report.archived.push(p.page);
      report.changed = true;
    });
  }

  // 4. Cited files that are gone.
  for (const page of kept) {
    if (hasConflictNotes(texts.get(page) ?? '')) report.conflictingPages.push(page);
    for (const source of citedFiles(root, page, texts.get(page) ?? '')) {
      const { file } = splitAnchor(source);
      if (!(await fileExists(path.normalize(safeDecode(file))))) report.missingSources.push({ page, source });
    }
  }
  const access = await readMemoryAccess(root);
  report.neglectedPages = neglectedMemoryPages(now, pages.filter((p) => kept.has(p.page)), access, options.neglectDays);
  return report;
}

export function neglectedMemoryPages(
  now: Date, pages: MemoryPage[], access: Awaited<ReturnType<typeof readMemoryAccess>>, days: number = DEFAULT_STALE_DAYS,
): string[] {
  const cutoff = now.getTime() - days * DAY_MS;
  return pages.filter((p) => {
    const entry = access[p.page];
    const lastContent = entry?.lastAgentWrite ?? p.updatedAt ?? p.mtimeMs;
    return (entry?.lastRead ?? lastContent) <= cutoff && lastContent <= cutoff;
  }).map((p) => p.page);
}

/**
 * Memory health for telemetry (#3052), as upkeep left it: counts and sizes
 * only. Broken links and missing sources are the ones `report` couldn't fix.
 * A topic is unlinked when no other page, the index included, links to or
 * names it, and stale when nobody touched it for `staleDays`.
 */
export async function measureMemoryHealth(
  now: Date,
  report: Pick<UpkeepReport, 'brokenLinks' | 'missingSources'>,
  options: Pick<UpkeepOptions, 'root' | 'staleDays' | 'neglectDays'> = {},
): Promise<DispatcherMemoryHealth> {
  const root = memoryPaths(options.root).root;
  const staleMs = (options.staleDays ?? DEFAULT_STALE_DAYS) * DAY_MS;
  const pages = await listMemoryPages(root, now.getTime());
  const texts = new Map<string, string>();
  let bytes = 0;
  for (const { page } of pages) {
    const text = (await readIfExists(path.join(root, page))) ?? '';
    texts.set(page, text);
    bytes += Buffer.byteLength(text, 'utf8');
  }
  const topics = pages.filter((p) => p.page.startsWith('topics/'));
  let unlinkedTopics = 0;
  for (const topic of topics) {
    const file = path.normalize(path.join(root, topic.page));
    const linked = pages.some((other) => other.page !== topic.page && refersTo(root, other.page, texts.get(other.page) ?? '', file));
    if (!linked) unlinkedTopics++;
  }
  return {
    pages: pages.length,
    bytes,
    topics: topics.length,
    agentPages: pages.filter((p) => p.page.startsWith('agents/')).length,
    timelinePages: pages.filter((p) => p.page.startsWith('timeline/')).length,
    indexBytes: Buffer.byteLength(texts.get('index.md') ?? '', 'utf8'),
    indexCapBytes: MEMORY_INDEX_CAP_BYTES,
    unlinkedTopics,
    staleTopics: topics.filter((p) => now.getTime() - (p.updatedAt ?? p.mtimeMs) >= staleMs).length,
    unconfirmedTopics: topics.filter((p) => p.status === 'unconfirmed').length,
    conflictingPages: pages.filter((p) => hasConflictNotes(texts.get(p.page) ?? '')).length,
    neglectedPages: neglectedMemoryPages(now, pages, await readMemoryAccess(root), options.neglectDays).length,
    brokenLinks: report.brokenLinks.length,
    missingSources: report.missingSources.length,
  };
}
