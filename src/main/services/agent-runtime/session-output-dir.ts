/**
 * Session-folder validation shared by everything in main that reads from a
 * CLI's per-session folder (#2421, #2422): chat's session-output root and the
 * Copilot binary-asset journal reader. No app imports, so orchestrator
 * adapters can use it without a cycle.
 */

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Names Windows treats as devices, whatever the extension (CON, NUL.txt, com1...). */
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * True when `id` can be a CLI's session id and so a folder name: a plain
 * token, never a path part or a Windows device name.
 */
export function isPlainSessionId(id: string | null | undefined): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id) && !WINDOWS_DEVICE_RE.test(id);
}

/** `<stateDir>/<sessionId>` by name, or undefined when the id isn't a plain token. */
export function sessionFolderIn(stateDir: string, sessionId: string | null | undefined): string | undefined {
  return isPlainSessionId(sessionId) ? path.join(stateDir, sessionId) : undefined;
}

/** True when `target` is `root` or inside it. Both resolved. */
function isInside(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * `dir`'s real path when it is safe to read from: an existing directory that
 * isn't a symlink, sits in a real parent under its own name, and is neither
 * the filesystem root nor the home folder or one of its parents.
 */
export async function verifySessionOutputDir(dir: string): Promise<string | undefined> {
  if (!path.isAbsolute(dir)) return undefined;
  const resolved = path.resolve(dir);
  const st = await fsp.lstat(resolved).catch((): null => null);
  if (!st?.isDirectory()) return undefined;
  const [real, realParent] = await Promise.all([
    fsp.realpath(resolved).catch((): null => null),
    fsp.realpath(path.dirname(resolved)).catch((): null => null),
  ]);
  if (!real || !realParent || real !== path.join(realParent, path.basename(resolved))) return undefined;
  if (path.parse(real).root === real) return undefined;
  const home = await fsp.realpath(os.homedir()).catch(() => path.resolve(os.homedir()));
  if (isInside(home, real)) return undefined;
  return real;
}
