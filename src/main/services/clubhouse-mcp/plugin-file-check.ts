/**
 * A file a plugin changes, or a command it runs, while it answers an agent's
 * tool call (D126, #3174): judged against the agent behind the call, as the
 * agent's own CLI and Clubhouse permissions would allow. Decided here, in
 * main, so a symlink is followed and the project is the one the file is
 * really in, whatever folder the plugin was pointed at.
 *
 * In a project (or an agent's worktree under `.clubhouse/agents/<name>`):
 * - Clubhouse's own records (anything else under `.clubhouse`: agent
 *   settings, Access, connections) are refused: only Clubhouse and the
 *   person change them.
 * - The project or worktree folder itself (a delete, or a copy onto it) is
 *   refused: it is all of the project.
 * - What agents read as configuration (`.claude`, `.codex`, `.agents`,
 *   `.mcp.json`, `.github`, `.git`, `CLAUDE.md`, `AGENTS.md`) needs
 *   `project.configure` there, as the plugin API's agentConfig does.
 * - Anything else is an edit: the caller at Auto-accept edits, in its own
 *   project. At Full access, anywhere, as its own CLI could.
 * Outside every project: Full access only. A command (its working folder):
 * the caller at Auto, in its own project, or at Full access.
 *
 * Names compare without case and without trailing dots or spaces, as macOS
 * and Windows do.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { ACCESS_LEVELS, accessLabel, type AccessLevel } from '../../../shared/agent-access';
import * as projectStore from '../project-store';
import { agentRegistry } from '../agent-registry';
import { callerRunningAccess } from './access-ceiling';
import { agentOfPluginCall } from './plugin-tool-registry';
import { CALL_OVER, checkPluginCaller } from './plugin-caller-check';

export type PluginFileOp = 'write' | 'delete' | 'exec';

const CONFIG_ENTRIES = new Set(['.claude', '.codex', '.agents', '.mcp.json', '.github', '.git', 'claude.md', 'agents.md']);

/** A path segment as macOS and Windows compare it. */
const fold = (segment: string) => segment.toLowerCase().replace(/[. ]+$/, '');

/** The real path: symlinks followed, for a file that may not exist yet through its nearest existing folder. */
async function realPath(p: string): Promise<string> {
  let current = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await fsp.realpath(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function segmentsUnder(root: string, target: string): string[] | null {
  const rel = path.relative(root, target);
  if (rel === '') return [];
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).filter(Boolean);
}

/** The registered project a real path is in, compared without case. */
async function projectOf(target: string): Promise<string | undefined> {
  let best: string | undefined;
  for (const p of await projectStore.peekProjects()) {
    const root = await realPath(p.path);
    const segs = segmentsUnder(root.toLowerCase(), target.toLowerCase());
    if (segs && (!best || root.length > best.length)) best = root;
  }
  return best;
}

const atLeast = (level: AccessLevel, needed: AccessLevel) => ACCESS_LEVELS.indexOf(level) >= ACCESS_LEVELS.indexOf(needed);

/** Null when the agent behind `callId` may, else why not. */
export async function checkPluginFileChange(pluginId: string, callId: string, filePath: string, op: PluginFileOp): Promise<string | null> {
  const agentId = agentOfPluginCall(callId, pluginId);
  if (!agentId) return CALL_OVER;
  const level = callerRunningAccess(agentId);
  const target = await realPath(filePath);
  const project = await projectOf(target);
  const needed: AccessLevel = op === 'exec' ? 'auto' : 'auto_edit';
  const what = op === 'exec' ? 'run a command' : 'change files';
  const levelRefusal = (lvl: AccessLevel) => `The calling agent runs at ${accessLabel(level)}, so a plugin can't ${what} there for it: that acts at ${accessLabel(lvl)}, and no agent acts above its own level, even through a plugin.`;

  if (!project) {
    return level === 'full_access' ? null : levelRefusal('full_access');
  }
  if (op !== 'exec') {
    const segs = (segmentsUnder(project.toLowerCase(), target.toLowerCase()) ?? []).map(fold);
    let rest = segs;
    if (segs[0] === '.clubhouse') {
      // An agent's worktree is project code; the rest of .clubhouse is Clubhouse's records.
      if (segs[1] === 'agents' && segs.length >= 3) rest = segs.slice(3);
      else return 'That is Clubhouse\'s own record of the project\'s agents, which only Clubhouse and the person change.';
    }
    if (rest.length === 0) return 'That is the whole project or an agent\'s whole worktree, which a plugin can\'t change for an agent.';
    if (CONFIG_ENTRIES.has(rest[0])) {
      return checkPluginCaller(pluginId, callId, { action: 'project.configure', projectPath: project });
    }
  }
  if (!atLeast(level, needed)) return levelRefusal(needed);
  // Below Full access, an agent's own CLI works in its own project.
  if (level !== 'full_access') {
    const own = agentRegistry.get(agentId)?.projectPath;
    const ownReal = own ? (await realPath(own)).toLowerCase() : undefined;
    if (!ownReal || ownReal !== project.toLowerCase()) {
      return `That is in another project than the calling agent's, so a plugin can't ${what} there for it below Full access.`;
    }
  }
  return null;
}
