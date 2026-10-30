/**
 * An agent's own session-output folder (rich chat content, #2422): where its
 * CLI writes files for this session, such as screenshots under Copilot's
 * `<session-state>/<sessionId>/`. Annex lists it among an agent's folders
 * (`contentRoots`) so phones link paths in it.
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
import { sessionFolderIn, verifySessionOutputDir } from './session-output-dir';

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
 * The live agent's session-output folder, checked, as a root list (empty
 * when it has none: no chat runtime, no session yet, or a provider without
 * one). Sleeping agents have none: their env isn't known.
 */
export async function agentSessionOutputRoots(agentId: string): Promise<string[]> {
  const dir = getAgentRuntime(agentId)?.getSessionOutputDir?.();
  return dir && await verifySessionOutputDir(dir) ? [path.resolve(dir)] : [];
}
