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

function gitOutput(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf-8' }, (error, stdout) => {
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
  const [commonDir = '', prefix = ''] = (await gitOutput(['rev-parse', '--git-common-dir', '--show-prefix'], projectPath)).split(/\r?\n/);
  if (!commonDir.trim()) return undefined;
  return { file: path.join(path.resolve(projectPath, commonDir.trim()), 'info', 'exclude'), prefix: prefix.trim() };
}

/**
 * Make sure the repository's `.git/info/exclude` lists Clubhouse's local patterns.
 * Append-only and idempotent: a line already there (whole-line match) is not added
 * again and nothing is ever removed or reordered. Never touches a tracked file. Soft
 * on failure: a folder that is no Git repository, or an exclude file that cannot be
 * written, is logged and left as it is. True when the file was written.
 */
export async function ensureLocalExcludes(projectPath: string): Promise<boolean> {
  try {
    const target = await excludeTarget(projectPath);
    if (!target) return false;
    const { file, prefix } = target;
    let content = '';
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile() || stat.size > MAX_EXCLUDE_BYTES) {
        appLog('core:local-excludes', 'warn', 'Exclude file is not a bounded regular file; left unchanged', { meta: { projectPath } });
        return false;
      }
      content = await fsp.readFile(file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
    const present = new Set(content.split(/\r?\n/).map((line) => line.trim()));
    const missing = CLUBHOUSE_LOCAL_PATTERNS.map((pattern) => `${prefix}${pattern}`).filter((line) => !present.has(line));
    if (missing.length === 0) return false;
    const lead = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    const header = present.has(EXCLUDE_HEADER) ? [] : [EXCLUDE_HEADER];
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, `${lead}${[...header, ...missing].join('\n')}\n`);
    return true;
  } catch (err) {
    // telemetry-exempt: a non-Git folder or unwritable exclude file leaves the checkout untouched; logged, never thrown.
    appLog('core:local-excludes', 'info', 'Could not update the repository exclude file; left unchanged', {
      meta: { projectPath, error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}

const ensured = new Set<string>();

/** `ensureLocalExcludes` at most once per project per app run, for writers that run often. */
export async function ensureLocalExcludesOnce(projectPath: string): Promise<void> {
  const key = path.resolve(projectPath);
  if (ensured.has(key)) return;
  ensured.add(key);
  await ensureLocalExcludes(projectPath);
}

export function resetLocalExcludesForTests(): void {
  ensured.clear();
}
