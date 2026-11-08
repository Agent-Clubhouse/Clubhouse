/**
 * The one-time move from `notes/` to memory (#3038), and what a Dispatcher
 * start loads from memory.
 *
 * `notes/` was written by the agent following the old instructions, so it can
 * hold anything: pages, JSON, folders of scripts and large bundles. Sorting it:
 *
 *   - `YYYY-MM-DD.md` becomes that day's timeline file (added to it if the day exists)
 *   - any other top-level `.md` becomes a topic page, marked unconfirmed, with
 *     the note's text kept exactly under the header
 *   - a top-level folder becomes a topic page listing its files
 *
 * Then the whole folder is renamed to `notes-archive/` next to it, outside
 * memory, so every note survives as it was, including files that aren't pages,
 * and large bundles stay out of memory's size and search.
 *
 * Idempotent: with no `notes/` there is nothing to do, and a run that stopped
 * before the move finds its pages already written and doesn't write them twice.
 * A `notes/` that appears again later is sorted the same way and renamed to
 * `notes-archive-2/`, then `-3/` and so on.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { Dirent } from 'fs';
import { appLog } from '../log-service';
import { getDispatcherMemoryPath, getDispatcherNotesArchivePath, getDispatcherNotesPath } from './dispatcher-paths';
import {
  ensureMemoryLayout,
  loadIndex,
  memorySlug,
  parseTopicPage,
  readIfExists,
  renderTopicPage,
  setIndexSection,
  writeFileAtomic,
} from './dispatcher-memory';

const NS = 'core:dispatcher';
const DAY_NOTE = /^\d{4}-\d{2}-\d{2}\.md$/i;
/** A folder's page lists at most this many of its files. */
const FOLDER_LIST_LIMIT = 50;
export const MIGRATED_INDEX_SECTION = 'Moved from notes';

export interface MigratedPage {
  /** The note, relative to the notes folder. */
  source: string;
  /** The page it landed on, relative to the memory folder. */
  page: string;
}

export interface NotesMigrationResult {
  /** False when there was no `notes/` to sort. */
  migrated: boolean;
  pages: MigratedPage[];
  /** The folder the notes were renamed to; null when there were none, or the folder was empty and removed. */
  archive: string | null;
}

export interface NotesMigrationOptions {
  notesDir?: string;
  memoryRoot?: string;
  /** The first archive folder's path; later ones get `-2`, `-3`, ... Defaults to `notes-archive` next to `notesDir`. */
  archiveDir?: string;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function archiveCandidate(first: string, n: number): string {
  return n === 1 ? first : `${first}-${n}`;
}

/** The first of `notes-archive`, `notes-archive-2`, ... that isn't taken. */
async function freeArchiveDir(first: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = archiveCandidate(first, n);
    if (!(await exists(candidate))) return candidate;
  }
}

/**
 * Every archive folder a migration made, in order. Forget everything (#3046)
 * clears these along with memory.
 */
export async function listNotesArchives(first: string = getDispatcherNotesArchivePath()): Promise<string[]> {
  const found: string[] = [];
  for (let n = 1; await exists(archiveCandidate(first, n)); n++) found.push(archiveCandidate(first, n));
  return found;
}

/** Every regular file under `dir`, relative to it, sorted. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

/**
 * Write a topic page for `slug` with this body, or find the one an earlier run
 * wrote. A page someone else already has under that name is left alone and the
 * next free name (`slug-2`, `slug-3`, ...) is used.
 */
async function placeTopic(topicsDir: string, slug: string, source: string, body: string): Promise<string> {
  for (let n = 1; ; n++) {
    const file = path.join(topicsDir, `${n === 1 ? slug : `${slug}-${n}`}.md`);
    const existing = await readIfExists(file);
    if (existing === null) {
      await writeFileAtomic(file, renderTopicPage({ status: 'unconfirmed', source, body }));
      return file;
    }
    if (parseTopicPage(existing)?.body === body) return file;
  }
}

/** Put a dated note into its timeline day, unless an earlier run already did. */
async function placeDay(timelineDir: string, name: string, text: string): Promise<string> {
  const file = path.join(timelineDir, name.toLowerCase());
  const existing = await readIfExists(file);
  if (existing === null) await writeFileAtomic(file, text);
  else if (!existing.includes(text)) {
    await writeFileAtomic(file, `${existing.trimEnd()}\n\n## Moved from notes/${name}\n\n${text}`);
  }
  return file;
}

/** `archiveRel` is relative to the memory folder; the page sits one level down, in topics/. */
function folderPageBody(name: string, files: string[], archiveRel: string, archiveName: string): string {
  const shown = files.slice(0, FOLDER_LIST_LIMIT);
  const lines = shown.map((f) => `- [${f}](${encodeURI(`../${archiveRel}/${name}/${f}`)})`);
  if (files.length > shown.length) lines.push(`- ${files.length - shown.length} more files in \`${archiveName}/${name}/\``);
  return `# ${name}\n\nThe folder \`notes/${name}/\` from before memory, kept as it was in \`${archiveName}/${name}/\`, next to memory.\n\n${lines.join('\n') || '- (empty)'}\n`;
}

/** Move `from` to `to`, copying when they are on different volumes. */
async function moveDir(from: string, to: string): Promise<void> {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await fsp.rm(from, { recursive: true, force: true });
  }
}

/** Sort `notes/` into memory and retire it. See the file comment. */
export async function migrateNotesToMemory(options: NotesMigrationOptions = {}): Promise<NotesMigrationResult> {
  const notesDir = options.notesDir ?? getDispatcherNotesPath();
  const root = options.memoryRoot ?? getDispatcherMemoryPath();
  const paths = await ensureMemoryLayout(root);
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(notesDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { migrated: false, pages: [], archive: null };
    throw err;
  }
  if (entries.length === 0) {
    await fsp.rmdir(notesDir);
    return { migrated: true, pages: [], archive: null };
  }

  const archiveDir = await freeArchiveDir(options.archiveDir ?? path.join(path.dirname(notesDir), 'notes-archive'));
  // Links from memory to the archive, which sits next to it.
  const archiveRel = toPosix(path.relative(root, archiveDir));
  const archiveName = path.basename(archiveDir);
  const pages: MigratedPage[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(notesDir, entry.name);
    let page: string | null = null;
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const text = await fsp.readFile(full, 'utf-8');
      page = DAY_NOTE.test(entry.name)
        ? await placeDay(paths.timeline, entry.name, text)
        : await placeTopic(
          paths.topics,
          memorySlug(entry.name.slice(0, -3)),
          `notes/${entry.name}, moved when memory was set up; the original is in ${archiveName}/${entry.name}`,
          text,
        );
    } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const files = await listFiles(full);
      page = await placeTopic(
        paths.topics,
        memorySlug(entry.name),
        `notes/${entry.name}/, moved when memory was set up`,
        folderPageBody(entry.name, files, archiveRel, archiveName),
      );
    }
    if (page) pages.push({ source: entry.name, page: toPosix(path.relative(root, page)) });
  }

  // Point the index at what moved before the folder goes, so a stop here leaves nothing unlisted.
  const lines = [
    `- The old notes folder is kept as it was in \`${archiveName}/\`, next to memory: [${archiveName}](${encodeURI(archiveRel)}/).`,
    ...pages.map((p) => `- [${p.source}](${encodeURI(p.page)})`),
  ];
  const section = archiveName === 'notes-archive' ? MIGRATED_INDEX_SECTION : `${MIGRATED_INDEX_SECTION} (${archiveName})`;
  await setIndexSection(section, lines, (left) => `- ${left} more pages in \`topics/\` and \`timeline/\``, root);

  await moveDir(notesDir, archiveDir);
  appLog(NS, 'info', 'Dispatcher notes moved into memory', {
    meta: { pages: pages.length, archive: archiveName },
  });
  return { migrated: true, pages, archive: archiveDir };
}

/** Heading of the index's section in the instructions file. */
export const MEMORY_INSTRUCTIONS_HEADING = '## Your memory index';

/**
 * The instructions a Dispatcher start gets: Clubhouse's own text, then its
 * memory index, cut to its cap. Sorts an old `notes/` folder in first. Memory
 * trouble is logged and the instructions go out without the index rather than
 * not at all.
 */
export async function withMemoryIndex(instructions: string, options: NotesMigrationOptions = {}): Promise<string> {
  try {
    await migrateNotesToMemory(options);
    const index = (await loadIndex(options.memoryRoot ?? getDispatcherMemoryPath())).trim();
    return `${instructions.trimEnd()}\n\n${MEMORY_INSTRUCTIONS_HEADING}\n\nThis is \`memory/index.md\` as it was when this file was written.\n\n${index}\n`;
  } catch (err) {
    // telemetry-exempt: logged; the Dispatcher still gets its instructions, just without memory
    appLog(NS, 'warn', 'Dispatcher memory could not be loaded', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return instructions;
  }
}
