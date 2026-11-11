/**
 * The chat's read-only way into the Dispatcher's memory (#3036), in the
 * layout of dispatcher-memory (#3038): index.md, agents/, timeline/, topics/. The memory folder is inside the coordinator's folder, which the chat
 * doesn't run in, and CLI file permissions differ by provider and Access
 * level. Both roles can read through read_memory, confined to markdown pages
 * inside memory. Reads record access outside the memory folder.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { getDispatcherMemoryPath } from './dispatcher-paths';
import { capIndex, readIndex, recordMemoryRead, MEMORY_HISTORY_DIR } from './dispatcher-memory';

/** One page's text at most; memory pages are meant to be short. */
export const MAX_MEMORY_PAGE_CHARS = 64_000;
/** Pages listed with the index at most. */
export const MAX_MEMORY_PAGES_LISTED = 300;

export interface MemoryRead {
  /** The page read, relative to the memory folder. */
  page?: string;
  text: string;
  truncated?: boolean;
  /** With no page asked for: every page there is, relative to the memory folder. */
  pages?: string[];
  pagesTruncated?: boolean;
}

export class MemoryReadError extends Error {}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function exists(p: string): Promise<boolean> {
  return fsp.access(p).then(() => true, () => false);
}

async function listPages(root: string): Promise<{ pages: string[]; truncated: boolean }> {
  const pages: string[] = [];
  const walk = async (dir: string): Promise<boolean> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      // Links are never followed: they could lead out of the folder.
      if (entry.isSymbolicLink()) continue;
      if (dir === root && entry.name === MEMORY_HISTORY_DIR) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!(await walk(full))) return false;
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        if (pages.length >= MAX_MEMORY_PAGES_LISTED) return false;
        pages.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
    return true;
  };
  const complete = await walk(root);
  return { pages, truncated: !complete };
}

function bounded(text: string): Pick<MemoryRead, 'text' | 'truncated'> {
  return text.length <= MAX_MEMORY_PAGE_CHARS ? { text } : { text: text.slice(0, MAX_MEMORY_PAGE_CHARS), truncated: true };
}

/** Shared read/write path rules; validate existing ancestors before creating anything. */
export async function resolveMemoryPage(page: string, root: string, writing = false): Promise<string> {
  const wanted = page.trim().replace(/\\/g, '/');
  if (path.isAbsolute(wanted) || wanted.includes(':') || wanted.includes('\0') || wanted.split('/').includes('..')) {
    throw new MemoryReadError('Name a page inside memory, such as agents/webapp-lead.md.');
  }
  if (!wanted.endsWith('.md')) throw new MemoryReadError('Memory pages are .md files.');
  const realRoot = await fsp.realpath(root);
  const target = path.join(realRoot, ...wanted.split('/'));
  if (!isInside(realRoot, target)) throw new MemoryReadError('Name a page inside memory.');
  let current = realRoot;
  const parts = path.relative(realRoot, target).split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat: import('fs').Stats;
    try { stat = await fsp.lstat(current); } catch (err) {
      if (writing && (err as NodeJS.ErrnoException).code === 'ENOENT') return target;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new MemoryReadError(`There is no memory page "${wanted}". Read memory with no page for the list.`);
      throw err;
    }
    if (stat.isSymbolicLink()) throw new MemoryReadError('Memory page paths cannot contain links.');
    if (i < parts.length - 1 && !stat.isDirectory()) throw new MemoryReadError(`"${wanted}" is not a page.`);
    if (i === parts.length - 1 && !stat.isFile()) throw new MemoryReadError(`"${wanted}" is not a page.`);
  }
  return target;
}

/**
 * Read one memory page, or with none, the index and the list of pages. A page
 * is a `.md` path relative to the memory folder, such as `agents/webapp-lead.md`.
 */
export async function readDispatcherMemory(page?: string, root: string = getDispatcherMemoryPath()): Promise<MemoryRead> {
  if (!(await exists(root))) return { text: 'There is no memory yet.', pages: [] };
  const realRoot = await fsp.realpath(root);

  if (page === undefined || page.trim() === '' || page.trim() === 'index.md') {
    const { pages, truncated } = await listPages(realRoot);
    // The index as a start loads it, cut to its cap; never created from here.
    // Validate index.md too: it must not be a link out of memory.
    await resolveMemoryPage('index.md', realRoot, true);
    const index = await readIndex(realRoot);
    const text = index ? capIndex(index) : 'There is no index yet.';
    return { page: 'index.md', ...bounded(text), pages, ...(truncated && { pagesTruncated: true }) };
  }

  const target = await resolveMemoryPage(page, realRoot);
  const wanted = path.relative(realRoot, target).split(path.sep).join('/');
  const text = await fsp.readFile(target, 'utf-8');
  await recordMemoryRead(wanted, realRoot);
  return { page: wanted, ...bounded(text) };
}
