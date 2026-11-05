/**
 * Git state per file for the import inventory (#2820), asked of git and never
 * inferred. Only `ls-files --cached` and `check-ignore` run here: neither
 * refreshes or writes the index, which `git status` does (see the test that
 * proves the fixture would catch it).
 *
 * The scanned repository is the user's, so its config isn't trusted to stay
 * read-only either: `core.fsmonitor` can name a program to run, and is turned off.
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
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  for (const name of INHERITED_GIT_ENV) delete env[name];
  return env;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(args: string[], cwd: string, signal: AbortSignal, input?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-c', 'core.fsmonitor=false', ...args],
      { cwd, env: gitEnv(), encoding: 'utf-8', maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS, signal, windowsHide: true },
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
  let ignored = new Set<string>();
  if (untrackedOrIgnored.length > 0) {
    // check-ignore refuses --literal-pathspecs (exit 128). It takes each path whole anyway.
    const result = await runGit(['check-ignore', '-z', '--stdin'], root, signal, `${untrackedOrIgnored.join('\0')}\0`);
    // 0: some are ignored. 1: none are. Anything else is a failure, not an answer.
    if (result.code !== 0 && result.code !== 1) {
      for (const p of gitPaths) states.set(p, tracked.has(comparisonKey(p, platform)) ? 'tracked' : 'unknown');
      return states;
    }
    ignored = new Set(result.stdout.split('\0').filter(Boolean).map((n) => comparisonKey(n, platform)));
  }

  for (const p of gitPaths) {
    const key = comparisonKey(p, platform);
    states.set(p, tracked.has(key) ? 'tracked' : ignored.has(key) ? 'ignored' : 'untracked');
  }
  return states;
}
