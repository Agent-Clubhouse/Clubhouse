import { execFile } from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { appLog } from './log-service';

const EXCLUDE_HEADER = '# Clubhouse agent manager';
const MAX_EXCLUDE_BYTES = 1024 * 1024;

/**
 * Clubhouse's local artifacts: agent worktrees, agent records, local settings, and
 * the settings backups (.bak) and recovery copies (.unreadable, .unreadable.N) that
 * can hold a project's settings or corrupt bytes. `git add -A` must not pick them up.
 * New projects get these in `.gitignore`; every project gets them in the repository's
 * own `.git/info/exclude`, which is never tracked and so never dirties a checkout (#3623).
 */
export const CLUBHOUSE_LOCAL_PATTERNS = [
  '.clubhouse/agents/',
  '.clubhouse/.local/',
  '.clubhouse/agents.json',
  '.clubhouse/agents.json.bak',
  '.clubhouse/settings.local.json',
  '.clubhouse/settings.json.bak',
  '.clubhouse/settings.json.unreadable*',
];

const GIT_TIMEOUT_MS = 10_000;

/** The environment without the variables that would point git at a repository other than the project's. */
function projectGitEnv(): NodeJS.ProcessEnv {
  const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, GIT_COMMON_DIR: _common, ...env } = process.env;
  return env;
}

/** Escape what a gitignore pattern would read as syntax, so a folder name matches only itself. */
function escapePatternText(text: string): string {
  return text.replace(/[\\[\]*?#!]/g, '\\$&');
}

function gitOutput(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf-8', env: projectGitEnv(), timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * The exclude file shared by every worktree of the project's repository, and the
 * project's folder inside the work tree ('' at its root, 'packages/app/' in a monorepo),
 * which exclude patterns with a slash must carry. The common git directory is the main
 * repository's for a linked worktree and `.git/modules/<name>` for a submodule.
 * Undefined when the folder is no Git work tree.
 */
async function excludeTarget(projectPath: string): Promise<{ file: string; prefix: string } | undefined> {
  const lines = (await gitOutput(['rev-parse', '--git-common-dir', '--show-prefix'], projectPath)).split(/\r?\n/);
  // Two lines (plus the final break). A folder name with a line break would add more: not a prefix to trust.
  if (lines.length > 3 || (lines.length === 3 && lines[2] !== '')) return undefined;
  const [commonDir = '', prefix = ''] = lines;
  if (!commonDir.trim()) return undefined;
  return { file: path.join(path.resolve(projectPath, commonDir.trim()), 'info', 'exclude'), prefix: escapePatternText(prefix.trim()) };
}

type ExcludeOutcome = 'written' | 'present' | 'skipped';

/**
 * Make sure the repository's `.git/info/exclude` lists Clubhouse's local patterns.
 * Append-only and idempotent: a line already there (whole-line match) is not added
 * again and nothing is ever removed or reordered. Never touches a tracked file. Soft
 * on failure: a folder that is no Git repository, or an exclude file that cannot be
 * written, is logged and left as it is ('skipped'). 'present' means it was already complete.
 */
async function installLocalExcludes(projectPath: string): Promise<ExcludeOutcome> {
  try {
    const target = await excludeTarget(projectPath);
    if (!target) return 'skipped';
    const { file, prefix } = target;
    let content = '';
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile() || stat.size > MAX_EXCLUDE_BYTES) {
        appLog('core:local-excludes', 'warn', 'Exclude file is not a bounded regular file; left unchanged', { meta: { projectPath } });
        return 'skipped';
      }
      content = await fsp.readFile(file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
    const present = new Set(content.split(/\r?\n/).map((line) => line.trim()));
    const missing = CLUBHOUSE_LOCAL_PATTERNS.map((pattern) => `${prefix}${pattern}`).filter((line) => !present.has(line));
    if (missing.length === 0) return 'present';
    const lead = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    const header = present.has(EXCLUDE_HEADER) ? [] : [EXCLUDE_HEADER];
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, `${lead}${[...header, ...missing].join('\n')}\n`);
    return 'written';
  } catch (err) {
    // telemetry-exempt: a non-Git folder or unwritable exclude file leaves the checkout untouched; logged, never thrown.
    appLog('core:local-excludes', 'info', 'Could not update the repository exclude file; left unchanged', {
      meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
    });
    return 'skipped';
  }
}

/** True when the exclude file was written. */
export async function ensureLocalExcludes(projectPath: string): Promise<boolean> {
  return (await installLocalExcludes(projectPath)) === 'written';
}

const ensured = new Map<string, Promise<ExcludeOutcome>>();

/**
 * `ensureLocalExcludes` at most once per project per app run, for writers that run often.
 * Concurrent callers wait for the same work, so none goes on to write a backup before the
 * exclude is in place. A run that did not finish the job (not a repository yet, an
 * unwritable file) is forgotten, and the next call tries again.
 */
export async function ensureLocalExcludesOnce(projectPath: string): Promise<void> {
  const key = path.resolve(projectPath);
  let pending = ensured.get(key);
  if (!pending) {
    pending = installLocalExcludes(projectPath);
    ensured.set(key, pending);
  }
  const mine = pending;
  let outcome: ExcludeOutcome;
  try {
    outcome = await mine;
  } catch {
    // telemetry-exempt: installLocalExcludes logs and never throws; this only forgets the run.
    outcome = 'skipped';
  }
  if (outcome === 'skipped' && ensured.get(key) === mine) ensured.delete(key);
}

export function resetLocalExcludesForTests(): void {
  ensured.clear();
}
