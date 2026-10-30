import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Test/E2E seam: `CLUBHOUSE_TEST_GITHUB_REFS` names a folder that stands in
 * for GitHub in chat's reference lookups (#2488). Chat E2E points it at a
 * temp folder so a hover never reaches `gh` or the network, and so a spec can
 * check exactly which lookups the app made, and when.
 *
 * - `refs.json` holds the answers: an object keyed `owner/repo#123` (issues
 *   and pull requests) or `owner/repo@sha` (commits), lowercase, whose values
 *   are what `gh api graphql` would print. It's read on every lookup, so a
 *   spec can change it mid-run. A missing key answers as gh failing would.
 * - `requests.jsonl` gets one line per lookup, `{ ref, args }`, before it's
 *   answered: `args` is what would have gone to gh.
 *
 * Honored ONLY in unpackaged builds, like `CLUBHOUSE_TEST_CLI_BINARIES`.
 */
export const GITHUB_REFS_ENV = 'CLUBHOUSE_TEST_GITHUB_REFS';
export const GITHUB_REFS_STUBS_FILE = 'refs.json';
export const GITHUB_REFS_REQUESTS_FILE = 'requests.jsonl';

type Runner = (args: string[]) => Promise<string | null>;

/** The value of a `-f name=value` or `-F name=value` field in gh args. */
function field(args: string[], name: string): string | undefined {
  for (let i = 1; i < args.length; i++) {
    if ((args[i - 1] === '-f' || args[i - 1] === '-F') && args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return undefined;
}

/** The stub key a lookup's gh args stand for. */
export function stubKeyOf(args: string[]): string {
  const repo = `${field(args, 'owner')}/${field(args, 'name')}`.toLowerCase();
  const number = field(args, 'number');
  return number !== undefined ? `${repo}#${number}` : `${repo}@${(field(args, 'expr') ?? '').toLowerCase()}`;
}

/** A gh runner that answers from the seam's folder, or undefined when the seam is off. */
export function testGithubRefRunner(): Runner | undefined {
  const dir = process.env[GITHUB_REFS_ENV];
  if (!dir || app.isPackaged) return undefined;
  return async (args) => {
    const ref = stubKeyOf(args);
    await fs.promises.appendFile(path.join(dir, GITHUB_REFS_REQUESTS_FILE), `${JSON.stringify({ ref, args })}\n`);
    let stubs: Record<string, unknown> = {};
    try {
      stubs = JSON.parse(await fs.promises.readFile(path.join(dir, GITHUB_REFS_STUBS_FILE), 'utf8')) as Record<string, unknown>;
    } catch {
      // telemetry-exempt: test seam; no stubs file means every lookup fails.
    }
    const answer = Object.prototype.hasOwnProperty.call(stubs, ref) ? stubs[ref] : undefined;
    return answer === undefined ? null : JSON.stringify(answer);
  };
}
