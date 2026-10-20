import * as fs from 'fs';
import * as os from 'os';
import { killStructuredChild } from '../../orchestrators/adapters/structured-spawn';
import { buildClaudeEnv, spawnClaude } from './spawn';

/** How long `claude --version` may take before the lookup gives up. */
export const CLI_VERSION_TIMEOUT_MS = 10_000;
/** Version output is one short line; stop reading past this. */
const MAX_OUTPUT = 4096;
/** How long to wait for stdout to close after `claude` exits; a lingering grandchild may hold the pipe. */
const CLOSE_GRACE_MS = 500;
const VERSION_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

/**
 * The version in `claude --version` output, e.g. "2.1.300 (Claude Code)" →
 * "2.1.300". A command prefix shares stdout and may print versions of its own
 * first ("Now using node v20.19.0"), so prefer the line naming Claude Code,
 * then the last line, which is `claude`'s. The version policy normalizes it.
 */
export function parseClaudeVersionOutput(out: string): string | undefined {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /claude code/i.test(l)) ?? lines[lines.length - 1];
  return line ? VERSION_RE.exec(line)?.[0] : undefined;
}

export interface ClaudeVersionLookupOptions {
  env?: Record<string, string>;
  commandPrefix?: string;
}

/** Version of the `claude` at `binary` (e.g. "2.1.300"), or undefined when it can't be determined. */
export type ClaudeVersionLookup = (binary: string, opts?: ClaudeVersionLookupOptions) => Promise<string | undefined>;

const cache = new Map<string, { mtimeMs: number; version: Promise<string | undefined> }>();

async function binaryMtime(binary: string): Promise<number | undefined> {
  try {
    return (await fs.promises.stat(binary)).mtimeMs;
  } catch { // telemetry-exempt: an unstat-able binary just isn't cached; the lookup reports no version
    return undefined;
  }
}

/** Run `claude --version` once, bounded, and parse the first version in its output. */
function runVersion(binary: string, opts: ClaudeVersionLookupOptions, spawnFn: typeof spawnClaude, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (version: string | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(version);
    };
    let child: ReturnType<typeof spawnClaude>;
    try {
      child = spawnFn({ binary, args: ['--version'], cwd: os.homedir(), env: buildClaudeEnv(opts.env), commandPrefix: opts.commandPrefix });
    } catch { // telemetry-exempt: no version is the reported outcome; the caller treats it as unknown
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      void killStructuredChild(child);
      finish(undefined);
    }, timeoutMs);
    child.stdin?.end();
    child.stderr?.resume();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (out.length < MAX_OUTPUT) out += chunk;
    });
    child.on('error', () => finish(undefined));
    child.on('exit', (code) => {
      if (code !== 0) finish(undefined);
      else setTimeout(() => finish(parseClaudeVersionOutput(out)), CLOSE_GRACE_MS).unref();
    });
    child.on('close', (code) => finish(code === 0 ? parseClaudeVersionOutput(out) : undefined));
  });
}

/**
 * `claude --version` for the preflight when the initialize response omits
 * `claude_code_version` (#2275). Asynchronous, bounded by a timeout, and
 * launched the way sessions are (profile env, command prefix, Windows shims).
 * Cached per binary, command prefix and profile env while the binary's mtime
 * is unchanged, so it spawns once per install rather than once per start.
 * Failures aren't cached.
 */
export async function lookupClaudeCliVersion(
  binary: string,
  opts: ClaudeVersionLookupOptions = {},
  deps: { spawn?: typeof spawnClaude; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const envKey = opts.env && Object.keys(opts.env).length ? JSON.stringify(Object.entries(opts.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : '';
  const key = `${binary}\0${opts.commandPrefix ?? ''}\0${envKey}`;
  const mtimeMs = await binaryMtime(binary);
  const cached = cache.get(key);
  if (cached && mtimeMs !== undefined && cached.mtimeMs === mtimeMs) return cached.version;

  const version = runVersion(binary, opts, deps.spawn ?? spawnClaude, deps.timeoutMs ?? CLI_VERSION_TIMEOUT_MS);
  if (mtimeMs === undefined) return version;
  const entry = { mtimeMs, version };
  cache.set(key, entry);
  void version.then((v) => {
    if (v === undefined && cache.get(key) === entry) cache.delete(key);
  });
  return version;
}

/** For tests. */
export function clearClaudeCliVersionCache(): void {
  cache.clear();
}
