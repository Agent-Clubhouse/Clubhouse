/**
 * Registering a folder as a project, for both the app's Add project (renderer
 * IPC) and the Dispatcher's add_project tool (#3239). One path, so a folder
 * that's already a project is returned the same way from either (#3236).
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import type { Project } from '../../shared/types';
import * as projectStore from './project-store';
import { ensureGitignore } from './agent-config';
import { getDefaultBranch, getOriginUrl, isInsideGitRepo } from './git-service';
import { getBaseDirPath } from './base-dir';
import { appLog } from './log-service';
import { tel } from '../telemetry/facade';

/** What happened to the project's .gitignore: Clubhouse's lines added, already there, or the write failed. */
export type GitignoreOutcome = 'updated' | 'unchanged' | 'failed';

export interface RegisterProjectResult {
  project: Project;
  /** False when the folder was already a project, which is returned unchanged. */
  created: boolean;
  /** Left out when nothing was tried (an existing project's .gitignore is left alone). */
  gitignore?: GitignoreOutcome;
}

export interface ImportRegistrationGuard {
  beforeGitignore: () => Promise<void>;
  assertSafe: () => void;
}

/**
 * Register a folder, or return the project it already is. A new project gets
 * Clubhouse's lines in its .gitignore, as Add project always did; a folder
 * that's already a project is not touched.
 */
export function registerProjectFolder(dirPath: string, guard?: ImportRegistrationGuard): Promise<RegisterProjectResult> {
  return tel.flow('clubhouse.project.add', {}, async () => {
    const { project, created } = await projectStore.addProject(dirPath);
    if (!created) return { project, created };
    let gitignore: GitignoreOutcome;
    try {
      if (guard) await guard.beforeGitignore();
      gitignore = (await tel.step('clubhouse.project.add.ensure_gitignore', () => guard ? ensureGitignore(dirPath, guard.assertSafe) : ensureGitignore(dirPath))) ? 'updated' : 'unchanged';
    } catch (err) {
      // telemetry-exempt: logged, and reported to the caller as gitignore: failed
      gitignore = 'failed';
      appLog('core:project', 'warn', 'ensureGitignore failed (non-fatal)', {
        meta: { dirPath, error: err instanceof Error ? err.message : String(err) },
      });
    }
    return { project, created, gitignore };
  });
}

/** Why a folder can't be added by an agent. */
export type FolderRefusal = 'not_absolute' | 'not_found' | 'not_directory' | 'clubhouse_internal' | 'agent_worktree';

export type FolderCheck =
  | { ok: true; path: string; canonicalPath: string }
  | { ok: false; reason: FolderRefusal; message: string };

/** Clubhouse's own folders: the app's data folder (both builds' names) and every project's `.clubhouse`. */
const INTERNAL_DIR_NAMES = new Set(['.clubhouse', '.clubhouse-dev']);

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
}

/**
 * Check a folder an agent asks to add (#3239): an absolute path to a folder
 * that exists, outside Clubhouse's own folders and agent worktrees (which
 * live in `<project>/.clubhouse/agents/`).
 */
export async function checkProjectFolder(input: string): Promise<FolderCheck> {
  if (!path.isAbsolute(input)) {
    return { ok: false, reason: 'not_absolute', message: 'Give the folder\'s absolute path.' };
  }
  const resolved = path.resolve(input);
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    // telemetry-exempt: returned to the caller as not_found
    return { ok: false, reason: 'not_found', message: 'No folder exists at that path.' };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: 'not_directory', message: 'That path is a file, not a folder.' };
  }
  const canonicalPath = await projectStore.canonicalProjectPath(resolved);
  const baseDir = await projectStore.canonicalProjectPath(getBaseDirPath());
  for (const candidate of [resolved, canonicalPath]) {
    const parts = segments(candidate);
    const agentsAt = parts.findIndex((s, i) => s === '.clubhouse' && parts[i + 1] === 'agents');
    if (agentsAt >= 0 && parts.length > agentsAt + 2) {
      return { ok: false, reason: 'agent_worktree', message: 'That folder is an agent\'s worktree, which belongs to its project.' };
    }
    if (isInside(candidate, baseDir) || isInside(candidate, getBaseDirPath()) || parts.some((s) => INTERNAL_DIR_NAMES.has(s))) {
      return { ok: false, reason: 'clubhouse_internal', message: 'That folder is one of Clubhouse\'s own and can\'t be a project.' };
    }
    // A project keeps its files in its own `.clubhouse`, which for the home folder of the
    // installed app is Clubhouse's data folder: the two would share one folder.
    const dataDir = projectStore.projectPathKey(path.join(candidate, '.clubhouse'));
    if (dataDir === projectStore.projectPathKey(baseDir) || dataDir === projectStore.projectPathKey(getBaseDirPath())) {
      return { ok: false, reason: 'clubhouse_internal', message: 'That folder holds Clubhouse\'s own data folder, so it can\'t be a project.' };
    }
  }
  return { ok: true, path: resolved, canonicalPath };
}

export interface FolderGitFacts {
  git: boolean;
  defaultBranch: string | null;
  origin: string | null;
}

/** Whether the folder is in a git repository, its default branch and its origin, when there are any. */
export async function describeFolderGit(dirPath: string): Promise<FolderGitFacts> {
  if (!await isInsideGitRepo(dirPath)) return { git: false, defaultBranch: null, origin: null };
  const [defaultBranch, origin] = await Promise.all([getDefaultBranch(dirPath), getOriginUrl(dirPath)]);
  return { git: true, defaultBranch, origin };
}
