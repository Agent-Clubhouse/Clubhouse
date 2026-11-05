/**
 * Checks on paths that come from a repository, such as `worktreePath` in
 * `agents.json`, which a clone can carry. These look at the string only:
 * touching an arbitrary path isn't safe even to stat it. On Windows a UNC path
 * can send credentials to the host it names, and anywhere a dead mount can hang.
 */
import * as path from 'path';
import type { InventoryExternalReason } from '../../../shared/import-inventory-types';

const MAX_CONFIGURED_PATH_CHARS = 4096;

/**
 * A path as a comparison key: separators, `.` segments and trailing separators
 * don't count, nor does case on Windows.
 */
export function projectPathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  let normal = impl.normalize(p);
  while (normal.length > impl.parse(normal).root.length && normal.endsWith(impl.sep)) normal = normal.slice(0, -1);
  return platform === 'win32' ? normal.toLowerCase() : normal;
}

/** `\\server\share`, `\\?\C:\x`, `//server/share`. Checked on every platform, whatever the slashes. */
export function isUncPath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

export function isOutside(rel: string, impl: path.PlatformPath = path): boolean {
  return rel === '..' || rel.startsWith(`..${impl.sep}`) || impl.isAbsolute(rel);
}

/** What a configured worktree path can be, judged without touching it. */
export function checkConfiguredPath(
  configured: unknown,
  projectRoot: string,
  impl: path.PlatformPath = path,
): 'inside-project' | InventoryExternalReason {
  if (typeof configured !== 'string' || !configured || configured.includes('\0') || configured.length > MAX_CONFIGURED_PATH_CHARS) {
    return 'invalid-path';
  }
  if (isUncPath(configured)) return 'unc-path';
  if (!impl.isAbsolute(configured)) return 'relative-path';
  // Nothing Clubhouse writes has these, even when they'd normalize back inside.
  if (configured.split(/[\\/]/).includes('..')) return 'parent-traversal';
  return isOutside(impl.relative(projectRoot, impl.normalize(configured)), impl) ? 'outside-project' : 'inside-project';
}

/**
 * The worktrees in `git worktree list --porcelain`. One git calls prunable has
 * lost its folder, so anything now at that path isn't what git registered.
 */
export function parseWorktreeList(stdout: string): string[] {
  const worktrees: string[] = [];
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const worktree = lines.find((line) => line.startsWith('worktree '));
    if (worktree && !lines.some((line) => line.startsWith('prunable'))) worktrees.push(worktree.slice('worktree '.length));
  }
  return worktrees;
}
