/**
 * The commit this build was made from (#2098), baked in by webpack's
 * DefinePlugin (webpack.main.config.ts). Null when it couldn't be read at
 * build time or isn't a commit hash, e.g. in tests, which run unbundled.
 */
declare const __CLUBHOUSE_BUILD_SHA__: string | null | undefined;

const SHA = /^[a-f0-9]{7,40}$/;

/** The build commit, lower-case hex of 7 to 40 characters, or null. */
export function buildSha(raw: unknown = typeof __CLUBHOUSE_BUILD_SHA__ === 'undefined' ? null : __CLUBHOUSE_BUILD_SHA__): string | null {
  if (typeof raw !== 'string') return null;
  const sha = raw.trim().toLowerCase();
  return SHA.test(sha) ? sha : null;
}
