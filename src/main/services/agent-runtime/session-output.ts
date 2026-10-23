/**
 * An agent's own session-output folder (rich chat content, #2422): where its
 * CLI writes files for this session, such as screenshots under Copilot's
 * `<session-state>/<sessionId>/`. Chat may read images from it as it does
 * from the project.
 *
 * The folder comes from the native session id Clubhouse tracks for the live
 * runtime and the env it launched with, never from agent text. It is always
 * one session's own folder: a session id that isn't a plain token, or a
 * folder that is a symlink or holds the home folder, gives none.
 */

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { copilotSessionStateDir } from '../../orchestrators/adapters/copilot-acp';
import { getAgentRuntime } from './index';

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The session-output folder for a provider's native session, by name only
 * (nothing is checked on disk). Undefined for providers without one.
 */
export function sessionOutputDir(provider: string, nativeSessionId: string | undefined, env: Record<string, string | undefined>): string | undefined {
  if (!nativeSessionId || !SESSION_ID_RE.test(nativeSessionId)) return undefined;
  if (provider === 'copilot-cli') return path.join(copilotSessionStateDir(env), nativeSessionId);
  return undefined;
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

/**
 * True when `absolutePath` is, by name, inside some session's output folder
 * of the kind the agent's CLI keeps (its live one's siblings, or Copilot's
 * default session-state), so a denial can say the session ended rather than
 * that the file is outside the project. Wording only: it grants nothing, and
 * the filesystem isn't asked.
 */
export function inSessionOutputArea(agentId: string, absolutePath: string): boolean {
  if (!path.isAbsolute(absolutePath)) return false;
  const live = getAgentRuntime(agentId)?.getSessionOutputDir?.();
  const parents = new Set([copilotSessionStateDir(process.env), ...(live ? [path.dirname(path.resolve(live))] : [])]);
  const target = path.resolve(absolutePath);
  for (const parent of parents) {
    const rel = path.relative(parent, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    // `<session-state>/<id>/...`: a file in one session's folder, not the folder list itself.
    const [id, ...rest] = rel.split(path.sep);
    if (SESSION_ID_RE.test(id) && rest.length > 0) return true;
  }
  return false;
}

/**
 * The live agent's session-output folder, checked, as a root list (empty
 * when it has none: no chat runtime, no session yet, or a provider without
 * one). Sleeping agents have none: their env isn't known. The folder keeps
 * the name it was found by, so paths the agent writes the same way match it
 * by name; resolveAllowedPath resolves it again on every check.
 */
export async function agentSessionOutputRoots(agentId: string): Promise<string[]> {
  const dir = getAgentRuntime(agentId)?.getSessionOutputDir?.();
  return dir && await verifySessionOutputDir(dir) ? [path.resolve(dir)] : [];
}
