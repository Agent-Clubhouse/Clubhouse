import { execFile } from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { appLog } from './log-service';

/**
 * Blueprints were removed (the Builder replaces them). The app saved exported
 * blueprints and bundles into `<project>/.clubhouse/blueprints/`; nothing reads
 * that folder any more, so it is deleted once at startup.
 *
 * Only that exact folder is touched, never a pattern. Files a person saved
 * somewhere else through the save dialog are theirs and are left alone.
 *
 * The folder sits inside the person's repository. If git tracks any file in
 * it, it's left in place and logged (the release notes tell people to delete
 * it themselves); deleting it would leave unexpected changes in their repo.
 * It is deleted when nothing in it is tracked, or the project isn't a git repo.
 * Canvases saved with deferred blueprint wires drop that field when the canvas
 * loads, so there's nothing for this module to do there.
 */

export interface RemovedBlueprintsCleanupOptions {
  /** Every known project. */
  projects: readonly { path: string }[];
  /** Written after a run with no failures, so later startups skip the work. */
  markerFile: string;
  /** Injected in tests. */
  isTracked?: GitTrackedCheck;
}

export interface RemovedBlueprintsCleanupResult {
  /** False when the marker was already there. */
  ran: boolean;
  removed: string[];
  /** Folders left in place because git tracks a file in them. */
  keptTracked: string[];
  failed: string[];
}

export type GitTrackedCheck = (projectPath: string, relativeDir: string) => Promise<'tracked' | 'untracked' | 'not-a-repo'>;

interface GitRun { ok: boolean; stdout: string; stderr: string; error?: Error }

function runGit(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr), error: error ?? undefined });
    });
  });
}

/**
 * Whether git tracks any file under `relativeDir`. `ls-files` lists only
 * tracked files, so untracked and ignored files count as untracked. Throws
 * when git can't answer (not installed, a broken repo), so the caller keeps
 * the folder and tries again next startup.
 */
export const gitTrackedCheck: GitTrackedCheck = async (projectPath, relativeDir) => {
  const inside = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok) {
    if (/not a git repository/i.test(inside.stderr)) return 'not-a-repo';
    throw new Error(`git rev-parse failed: ${inside.stderr.trim() || inside.error?.message}`);
  }
  if (inside.stdout.trim() !== 'true') return 'not-a-repo';
  const listed = await runGit(projectPath, ['ls-files', '-z', '--', relativeDir]);
  if (!listed.ok) throw new Error(`git ls-files failed: ${listed.stderr.trim() || listed.error?.message}`);
  return listed.stdout.length > 0 ? 'tracked' : 'untracked';
};

async function lstatOrNull(p: string) {
  try {
    return await fsp.lstat(p);
  } catch { // telemetry-exempt: a missing path is the answer, not a failure
    return null;
  }
}

/** The folder this cleanup deletes for a project. */
export function blueprintsDirFor(projectPath: string): string {
  return path.join(projectPath, '.clubhouse', 'blueprints');
}

/**
 * Delete each project's `.clubhouse/blueprints/` folder unless git tracks a
 * file in it. A symlink there is
 * unlinked, never followed. Best-effort: failures are logged and never thrown,
 * and the marker is only written when every removal worked, so a failure is
 * retried on the next startup.
 */
export async function cleanupRemovedBlueprintData(opts: RemovedBlueprintsCleanupOptions): Promise<RemovedBlueprintsCleanupResult> {
  const result: RemovedBlueprintsCleanupResult = { ran: false, removed: [], keptTracked: [], failed: [] };
  const isTracked = opts.isTracked ?? gitTrackedCheck;
  try {
    if (await lstatOrNull(opts.markerFile)) return result;
    result.ran = true;

    for (const project of opts.projects) {
      const dir = blueprintsDirFor(project.path);
      try {
        const stat = await lstatOrNull(dir);
        if (!stat) continue;
        if (await isTracked(project.path, '.clubhouse/blueprints') === 'tracked') {
          result.keptTracked.push(dir);
          continue;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) await fsp.unlink(dir);
        else await fsp.rm(dir, { recursive: true, force: true });
        result.removed.push(dir);
      } catch (err) {
        result.failed.push(dir);
        appLog('core:startup', 'warn', 'Could not delete saved blueprints', {
          meta: { path: dir, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    if (result.removed.length > 0) {
      appLog('core:startup', 'info', 'Deleted saved blueprints (blueprints were removed)', {
        meta: { removed: result.removed },
      });
    }
    if (result.keptTracked.length > 0) {
      appLog('core:startup', 'info', 'Left saved blueprints in place because git tracks them; delete the folder yourself', {
        meta: { kept: result.keptTracked },
      });
    }
    if (result.failed.length === 0) {
      await fsp.mkdir(path.dirname(opts.markerFile), { recursive: true });
      await fsp.writeFile(opts.markerFile, JSON.stringify({ completedAt: new Date().toISOString(), removed: result.removed, keptTracked: result.keptTracked }), 'utf-8');
    }
  } catch (err) {
    appLog('core:startup', 'warn', 'Blueprint data cleanup failed', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }
  return result;
}
