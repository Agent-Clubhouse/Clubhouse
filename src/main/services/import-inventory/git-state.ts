/**
 * Git state per file for the import inventory (#2820), asked of git and never
 * inferred. Only `ls-files --cached` and `check-ignore` run here: neither
 * refreshes or writes the index, which `git status` does (see the test that
 * proves the fixture would catch it).
 *
 * The scanned repository's contents and config aren't trusted, since a clone can
 * carry anything. What could run or fetch something on these two commands:
 *   - `core.fsmonitor` names a program git runs on any index read: turned off.
 *   - On Windows, libuv looks for `git.exe` in the spawn's cwd before PATH, so a
 *     repo holding one would run it: git gets the repo through `-C`, never as cwd.
 *   - A partial clone can fetch a skip-worktree `.gitignore`: GIT_NO_LAZY_FETCH.
 * Hooks, filters, pagers and the like don't run here; import-inventory.test.ts
 * sets them all to prove it.
 */
import { execFile } from 'child_process';
import * as path from 'path';
import type { InventoryGitState } from '../../../shared/import-inventory-types';

const MAX_BUFFER = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
/** Stays under Windows' 32K command line. */
const MAX_ARGS_CHARS = 20_000;

/** A worktree's own variables would point git at another repository. */
const INHERITED_GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX'];

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C' };
  for (const name of INHERITED_GIT_ENV) delete env[name];
  return env;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(args: string[], root: string, signal: AbortSignal, input?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-C', root, '-c', 'core.fsmonitor=false', ...args],
      { env: gitEnv(), encoding: 'utf-8', maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS, signal, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input ?? '');
  });
}

/** `file` relative to `root` with git's `/` separators. */
export function toGitPath(root: string, file: string, impl: path.PlatformPath = path): string {
  return impl.relative(root, file).split(impl.sep).join('/');
}

/** macOS and Windows may hand back another spelling of the same path than the index holds. */
function comparisonKey(gitPath: string, platform: NodeJS.Platform): string {
  const nfc = gitPath.normalize('NFC');
  return platform === 'win32' || platform === 'darwin' ? nfc.toLowerCase() : nfc;
}

/**
 * Fills `ignored` from check-ignore. One path can fail a whole batch (`is beyond
 * a symbolic link` exits 128), so a failed batch splits until only the bad paths
 * are left, and those alone go in `failed`.
 */
async function checkIgnored(
  root: string,
  paths: readonly string[],
  signal: AbortSignal,
  ignored: Set<string>,
  failed: Set<string>,
): Promise<void> {
  const result = await runGit(['check-ignore', '-z', '--stdin'], root, signal, `${paths.join('\0')}\0`);
  // 0: some are ignored. 1: none are. Anything else is a failure, not an answer.
  if (result.code === 0 || result.code === 1) {
    for (const name of result.stdout.split('\0')) {
      if (name) ignored.add(name);
    }
  } else if (paths.length === 1 || signal.aborted) {
    for (const p of paths) failed.add(p);
  } else {
    const middle = Math.floor(paths.length / 2);
    await checkIgnored(root, paths.slice(0, middle), signal, ignored, failed);
    await checkIgnored(root, paths.slice(middle), signal, ignored, failed);
  }
}

function chunkPaths(paths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const p of paths) {
    if (current.length > 0 && chars + p.length > MAX_ARGS_CHARS) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(p);
    chars += p.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * The state of each of `gitPaths` (relative to `root`, `/` separated). A tracked
 * file stays tracked when an ignore rule also matches it, as git treats it.
 */
export async function readGitStates(
  root: string,
  gitPaths: readonly string[],
  signal: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<Map<string, InventoryGitState>> {
  const states = new Map<string, InventoryGitState>();
  const fill = (state: InventoryGitState) => {
    for (const p of gitPaths) states.set(p, state);
    return states;
  };
  if (gitPaths.length === 0) return states;

  const tracked = new Set<string>();
  for (const chunk of chunkPaths(gitPaths)) {
    const result = await runGit(['--literal-pathspecs', 'ls-files', '-z', '--cached', '--', ...chunk], root, signal);
    if (result.code !== 0) return fill(/not a git repository/i.test(result.stderr) ? 'not-a-repo' : 'unknown');
    for (const name of result.stdout.split('\0')) {
      if (name) tracked.add(comparisonKey(name, platform));
    }
  }

  const untrackedOrIgnored = gitPaths.filter((p) => !tracked.has(comparisonKey(p, platform)));
  const ignoredNames = new Set<string>();
  const failed = new Set<string>();
  if (untrackedOrIgnored.length > 0) {
    // check-ignore refuses --literal-pathspecs (exit 128). It takes each path whole anyway.
    await checkIgnored(root, untrackedOrIgnored, signal, ignoredNames, failed);
  }
  const ignored = new Set([...ignoredNames].map((n) => comparisonKey(n, platform)));

  for (const p of gitPaths) {
    const key = comparisonKey(p, platform);
    states.set(p, tracked.has(key) ? 'tracked' : failed.has(p) ? 'unknown' : ignored.has(key) ? 'ignored' : 'untracked');
  }
  return states;
}
