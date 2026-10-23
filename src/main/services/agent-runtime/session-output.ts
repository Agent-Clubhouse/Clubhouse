/**
 * An agent's own session-output folder (rich chat content, #2422): where its
 * CLI writes files for this session, such as screenshots under Copilot's
 * `<session-state>/<sessionId>/`. Chat may read images from it as it does
 * from the project.
 *
 * The folder comes from the native session id Clubhouse tracks for the live
 * runtime and the env it launched with, never from agent text. It is always
 * one session's own folder: a session id that isn't a plain token (or is a
 * Windows device name), or a
 * folder that is a symlink or holds the home folder, gives none.
 */

import * as path from 'path';
import { copilotSessionStateDir } from '../../orchestrators/adapters/copilot-acp';
import { getAgentRuntime } from './index';
import { isPlainSessionId, sessionFolderIn, verifySessionOutputDir } from './session-output-dir';

export { verifySessionOutputDir };

/**
 * The session-output folder for a provider's native session, by name only
 * (nothing is checked on disk). Undefined for providers without one.
 */
export function sessionOutputDir(provider: string, nativeSessionId: string | undefined, env: Record<string, string | undefined>): string | undefined {
  if (provider === 'copilot-cli') return sessionFolderIn(copilotSessionStateDir(env), nativeSessionId);
  return undefined;
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
    if (isPlainSessionId(id) && rest.length > 0) return true;
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
