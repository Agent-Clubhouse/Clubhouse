import { execSync } from 'child_process';

/**
 * The commit to bake into the main bundle as __CLUBHOUSE_BUILD_SHA__ (#2098):
 * CLUBHOUSE_BUILD_SHA if set, else the checkout's HEAD, else GITHUB_SHA, else
 * null. Never throws: a build outside git just reports no commit.
 */
export function resolveBuildSha(env: NodeJS.ProcessEnv = process.env, git: () => string = () => execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()): string | null {
  const fromEnv = env.CLUBHOUSE_BUILD_SHA?.trim();
  if (fromEnv) return fromEnv;
  try {
    const head = git().trim();
    if (head) return head;
  } catch {
    // Not a git checkout (e.g. a source tarball).
  }
  return env.GITHUB_SHA?.trim() || null;
}
