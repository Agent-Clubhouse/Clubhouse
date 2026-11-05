/**
 * Checks on what a repository says, such as `worktreePath` in `agents.json` or
 * its `.git/config`, which a clone or an archive can carry. These look at the
 * string only:
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

const ALLOWED_GIT_CONFIG: Record<string, ReadonlySet<string> | undefined> = {
  core: new Set(['repositoryformatversion', 'filemode', 'bare', 'logallrefupdates', 'ignorecase', 'precomposeunicode', 'symlinks', 'autocrlf', 'eol', 'safecrlf', 'longpaths']),
  remote: new Set(['url', 'pushurl', 'fetch', 'push', 'tagopt', 'prune', 'gh-resolved']),
  branch: new Set(['remote', 'merge', 'rebase', 'pushremote', 'description', 'github-pr-owner-number']),
  user: new Set(['name', 'email']),
  pull: new Set(['rebase', 'ff']),
  push: new Set(['default', 'autosetupremote']),
  fetch: new Set(['prune']),
  init: new Set(['defaultbranch']),
  gc: new Set(['auto']),
};

/**
 * Whether a repository's `.git/config` is plainly harmless. An allow-list on
 * purpose, of syntax as well as keys: git has many ways to name a path or a
 * program (`include`, `includeIf`, `core.worktree`, `core.excludesFile`), and a
 * denylist would be only as good as this file's memory of them. Anything not
 * recognized means git isn't asked.
 */
export function isGitConfigAllowed(text: string): boolean {
  let allowed: ReadonlySet<string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = line.match(/^\[([A-Za-z0-9-]+)(?:\s+"[^"\\\n]*")?\]$/);
    if (section) {
      allowed = ALLOWED_GIT_CONFIG[section[1].toLowerCase()];
      if (!allowed) return false;
      continue;
    }
    const entry = line.match(/^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/);
    if (!entry || !allowed?.has(entry[1].toLowerCase())) return false;
    const [, key, value] = entry;
    // A trailing backslash continues the line, and an inline comment or quote can hide more of it.
    if (value.endsWith('\\') || /^["']/.test(value) || isUncPath(value)) return false;
    if (key.toLowerCase() === 'bare' && value.toLowerCase() !== 'false') return false;
    if (key.toLowerCase() === 'repositoryformatversion' && value !== '0' && value !== '1') return false;
  }
  return true;
}
