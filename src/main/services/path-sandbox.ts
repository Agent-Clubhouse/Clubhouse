import * as path from 'path';
import * as fsp from 'fs/promises';
import { app } from 'electron';
import * as projectStore from './project-store';
import { appLog } from './log-service';
import { tel } from '../telemetry/facade';

/**
 * Returns the list of allowed root directories for IPC file operations.
 * Includes all registered project paths and the app data directory.
 */
export async function getAllowedRoots(): Promise<string[]> {
  const roots: string[] = [];

  for (const project of await projectStore.list()) {
    roots.push(path.resolve(project.path));
  }

  const dirName = app.isPackaged ? '.clubhouse' : '.clubhouse-dev';
  roots.push(path.resolve(app.getPath('home'), dirName));

  return roots;
}

/**
 * Check whether a resolved path falls under any of the given allowed roots.
 * Exported for direct testing.
 */
export function isPathAllowed(targetPath: string, allowedRoots: string[]): boolean {
  const resolved = path.resolve(targetPath);
  for (const rawRoot of allowedRoots) {
    const root = path.resolve(rawRoot);
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return true;
    }
  }
  return false;
}

/** Most symlinks followed in one path before it is refused, as the OS refuses a loop (ELOOP). */
const MAX_LINK_HOPS = 32;

const segmentsOf = (p: string) => p.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');

/**
 * Where a path really leads, as the OS would follow it for a write (#3177).
 * It walks the path one segment at a time with an already-resolved prefix, so
 * a symlink is followed before any `..` after it, as the OS does, and a link's
 * relative target is taken from where the link really is. A dangling link is
 * followed (writing creates its target); past the first missing segment the
 * rest is appended. Throws, never guesses, for a loop of links, too many
 * links, or a `..` past a missing segment.
 */
export async function resolveRealPath(p: string): Promise<string> {
  // Windows' file APIs collapse `..` in the text first, so its check does too; elsewhere links come first.
  const absolute = process.platform === 'win32' || !path.isAbsolute(p) ? path.resolve(p) : p;
  let prefix = path.parse(absolute).root;
  const queue = segmentsOf(absolute.slice(prefix.length));
  let existing = prefix;
  let missing = false;
  let hops = 0;
  while (queue.length > 0) {
    const seg = queue.shift()!;
    if (missing) {
      if (seg === '..') throw new Error(`Can't resolve "${p}": it steps back out of a folder that doesn't exist`);
      prefix = path.join(prefix, seg);
      continue;
    }
    if (seg === '..') {
      // The prefix is resolved, so its parent is where `..` really goes.
      prefix = path.dirname(prefix);
      existing = prefix;
      continue;
    }
    const next = path.join(prefix, seg);
    let st: import('fs').Stats;
    try {
      st = await fsp.lstat(next);
    } catch {
      // telemetry-exempt: nothing here yet; the rest of the path is appended as given
      missing = true;
      prefix = next;
      continue;
    }
    if (st.isSymbolicLink()) {
      if (++hops > MAX_LINK_HOPS) throw new Error(`Can't resolve "${p}": too many symbolic links`);
      const target = await fsp.readlink(next);
      // A relative target is taken from the folder the link really is in (the resolved prefix).
      if (path.isAbsolute(target)) prefix = path.parse(target).root;
      queue.unshift(...segmentsOf(path.isAbsolute(target) ? target.slice(path.parse(target).root.length) : target));
      continue;
    }
    prefix = next;
    existing = next;
  }
  // The existing part has no links left in it: its real path only settles how the disk spells it.
  try {
    const canonical = await fsp.realpath(existing);
    return path.join(canonical, path.relative(existing, prefix));
  } catch {
    // telemetry-exempt: it was there a moment ago; the walked path stands
    return prefix;
  }
}

/** Where a path sits: its folder resolved, its own name as given, for an operation on a link itself (delete, rename). */
export async function resolveLocation(p: string): Promise<string> {
  const absolute = path.isAbsolute(p) ? p : path.resolve(p);
  return path.join(await resolveRealPath(path.dirname(absolute)), path.basename(absolute));
}

/**
 * Assert that a filesystem path is within a registered project directory
 * or the app data directory. Throws if the path is outside allowed boundaries.
 * The path is judged where it really leads (resolveRealPath), or for a
 * delete or rename where it sits (`linkItself`), against the roots as
 * registered and where they really are. One that can't be resolved is refused.
 */
export async function assertAllowedPath(targetPath: string, options: { linkItself?: boolean } = {}): Promise<void> {
  const given = await getAllowedRoots();
  const roots = [...given, ...(await Promise.all(given.map((r) => resolveRealPath(r).catch(() => r))))];
  // A delete or a rename acts on a link itself, not on what it points at.
  const realTarget = await (options.linkItself ? resolveLocation(targetPath) : resolveRealPath(targetPath)).catch((): null => null);
  if (realTarget === null || !isPathAllowed(realTarget, roots)) {
    tel.count('clubhouse.file.path_denied');
    const resolved = path.resolve(targetPath);
    appLog('core:file', 'error', 'Path access denied: outside allowed directories', {
      meta: { targetPath, resolved },
    });
    throw new Error(`Access denied: path "${resolved}" is outside allowed project directories`);
  }
}
