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

/** Where names compare without case: macOS and Windows. Linux keeps case. */
const CASELESS = process.platform === 'darwin' || process.platform === 'win32';
const sameCase = (p: string) => (CASELESS ? p.toLowerCase() : p);

/**
 * A path segment as macOS and Windows compare it: one Unicode form, case folded both ways (so the
 * long s and dotless i match their ASCII letters), trailing dots and spaces dropped.
 */
const fold = (segment: string) => segment.normalize('NFC').toUpperCase().toLowerCase().replace(/[. ]+$/, '');

/**
 * A segment that names something other than it looks like: a Windows stream (`name:stream`, `::$DATA`)
 * or a short name (`CLUBHO~1`). Refused rather than guessed at.
 */
const disguised = (segment: string) => segment.includes(':') || (process.platform === 'win32' && /~\d+(\.|$)/.test(segment));

/**
 * Where a path really leads: symlinks followed, a dangling one too (a write creates its target), and
 * for a file that doesn't exist yet, through its nearest existing folder.
 */
async function realPath(p: string, depth = 0): Promise<string> {
  let current = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await fsp.realpath(current), ...[...rest].reverse());
    } catch {
      try {
        const st = await fsp.lstat(current);
        if (st.isSymbolicLink() && depth < 40) {
          const link = await fsp.readlink(current);
          return realPath(path.join(path.resolve(path.dirname(current), link), ...[...rest].reverse()), depth + 1);
        }
      } catch {
        // Nothing here yet: go up a folder.
      }
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** Where a path sits: its folder followed to where it really is, its own name as given (a link itself, not its target). */
async function location(p: string): Promise<string> {
  const resolved = path.resolve(p);
  return path.join(await realPath(path.dirname(resolved)), path.basename(resolved));
}

function segmentsUnder(root: string, target: string): string[] | null {
  const rel = path.relative(sameCase(root), sameCase(target));
  if (rel === '') return [];
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).filter(Boolean);
}

const atLeast = (level: AccessLevel, needed: AccessLevel) => ACCESS_LEVELS.indexOf(level) >= ACCESS_LEVELS.indexOf(needed);

/** Null when the agent behind `callId` may, else why not. */
export async function checkPluginFileChange(pluginId: string, callId: string, filePath: string, op: PluginFileOp): Promise<string | null> {
  const agentId = agentOfPluginCall(callId, pluginId);
  if (!agentId) return CALL_OVER;
  const level = callerRunningAccess(agentId);
  const roots = await Promise.all((await projectStore.peekProjects()).map((p) => realPath(p.path)));
  const own = agentRegistry.get(agentId)?.projectPath;
  const ownRoot = own ? await realPath(own) : undefined;
  const needed: AccessLevel = op === 'exec' ? 'auto' : 'auto_edit';
  const what = op === 'exec' ? 'run a command' : 'change files';
  const levelRefusal = (lvl: AccessLevel) => `The calling agent runs at ${accessLabel(level)}, so a plugin can't ${what} there for it: that acts at ${accessLabel(lvl)}, and no agent acts above its own level, even through a plugin.`;

  /** One place the change reaches, judged on its own. */
  const judge = async (target: string): Promise<string | null> => {
    let project: string | undefined;
    for (const root of roots) {
      if (segmentsUnder(root, target) && (!project || root.length > project.length)) project = root;
    }
    if (!project) return level === 'full_access' ? null : levelRefusal('full_access');
    if (op !== 'exec') {
      const raw = segmentsUnder(project, target) ?? [];
      if (raw.some(disguised)) return 'That path names a file stream or a short name, which a plugin can\'t use for an agent.';
      // Deleting, moving or copying onto a folder that holds another project reaches all of it.
      if (roots.some((r) => r !== project && segmentsUnder(target, r))) return 'That folder holds another project, which a plugin can\'t change for an agent.';
      const segs = raw.map(fold);
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
    if (level !== 'full_access' && (!ownRoot || sameCase(ownRoot) !== sameCase(project))) {
      return `That is in another project than the calling agent's, so a plugin can't ${what} there for it below Full access.`;
    }
    return null;
  };

  // Where it sits (a delete or a move acts on a link itself) and, for a write, where it leads (it follows the
  // link). A command runs in the folder it really is.
  const places = op === 'exec' ? [await realPath(filePath)] : [await location(filePath)];
  if (op === 'write') {
    const leads = await realPath(filePath);
    if (leads !== places[0]) places.push(leads);
  }
  for (const place of places) {
    const refused = await judge(place);
    if (refused) return refused;
  }
  return null;
}
