/**
 * Test helpers for driving protocol clients against the fake CLI
 * (scripts/chat-fixtures/fake-cli.mjs), which replays a recorded or hand-made
 * fixture over stdio. Nothing here spends tokens or needs a real CLI.
 *
 * Test-only: production code must not import this module.
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

/** The replayer script. Run it with `process.execPath`. */
export const FAKE_CLI_SCRIPT = path.join(REPO_ROOT, 'scripts', 'chat-fixtures', 'fake-cli.mjs');

/** Committed fixtures, one folder per CLI. */
export const CHAT_FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'chat-fixtures');

export type ChatFixtureCli = 'claude' | 'codex' | 'copilot';

export function chatFixturePath(cli: ChatFixtureCli, name: string): string {
  return path.join(CHAT_FIXTURES_DIR, cli, `${name}.jsonl`);
}

/** Progress report the fake CLI rewrites after every replayed line. */
export interface FakeCliReport {
  fixture: string;
  protocol: 'claude-stream-json' | 'codex-app-server' | 'acp';
  /** Arguments the fake was launched with, minus its own `--fake-*` options. */
  argv: string[];
  total: number;
  consumed: number;
  /** Every fixture line was replayed or matched. */
  complete: boolean;
  stdinClosed: boolean;
  mismatch: { line: number; reason: string; actual: unknown } | null;
  /** Client messages skipped in lenient mode, or sent after the fixture ended. */
  unexpected: unknown[];
  exitCode: number | null;
}

export interface FakeCliOptions {
  /** Timing multiplier for recorded gaps. 0 (default) replays instantly. */
  speed?: number;
  /** Skip client messages that don't match instead of exiting with code 3. */
  lenient?: boolean;
  /** Extra arguments, as the real CLI would receive them (`app-server`, `--acp`, …). */
  cliArgs?: string[];
}

export interface FakeCli {
  /** Spawn target: the current Node binary. */
  binary: string;
  /** Script path, fake-cli options, then `cliArgs`. */
  args: string[];
  reportPath: string;
  /** The latest report, retrying until it exists and parses. */
  readReport(timeoutMs?: number): Promise<FakeCliReport>;
  /** Poll the report until `predicate` holds (default: fixture complete). */
  waitForReport(predicate?: (report: FakeCliReport) => boolean, timeoutMs?: number): Promise<FakeCliReport>;
  dispose(): Promise<void>;
}

/** Prepare a fake CLI invocation for `fixture`. Pass `binary`/`args` to a protocol client. */
export async function createFakeCli(fixture: string, opts: FakeCliOptions = {}): Promise<FakeCli> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clubhouse-fake-cli-'));
  const reportPath = path.join(dir, 'report.json');
  const args = [FAKE_CLI_SCRIPT, '--fake-fixture', fixture, '--fake-report', reportPath];
  if (opts.speed !== undefined) args.push('--fake-speed', String(opts.speed));
  if (opts.lenient) args.push('--fake-lenient');
  args.push(...(opts.cliArgs ?? []));

  const parseReport = async (): Promise<FakeCliReport> =>
    JSON.parse(await fs.promises.readFile(reportPath, 'utf8')) as FakeCliReport;

  /** Poll until the report parses and `predicate` holds, or the deadline passes. */
  const pollReport = async (predicate: (r: FakeCliReport) => boolean, timeoutMs: number): Promise<FakeCliReport> => {
    const deadline = Date.now() + timeoutMs;
    let last: FakeCliReport | undefined;
    let lastError: unknown;
    for (;;) {
      try {
        last = await parseReport();
        if (predicate(last)) return last;
      } catch (err) {
        // Not written yet. Writes are atomic, but stay tolerant of a torn read.
        lastError = err;
      }
      if (Date.now() > deadline) {
        throw new Error(`fake CLI report did not reach the expected state: ${last ? JSON.stringify(last) : String(lastError)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  };

  return {
    binary: process.execPath,
    args,
    reportPath,
    readReport: (timeoutMs = 15_000) => pollReport(() => true, timeoutMs),
    waitForReport: (predicate = (r) => r.complete, timeoutMs = 15_000) => pollReport(predicate, timeoutMs),
    async dispose() {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

/**
 * Write executables named after real CLIs (`claude`, `codex`, `copilot`) into
 * `dir`, each replaying its fixture. Put `dir` first on PATH to make an app
 * or SDK spawn the fake instead of the real CLI. Windows gets `.cmd` shims,
 * which also exercises the batch-shim spawn path real npm installs take.
 * Returns the shim path per name.
 */
export async function writeFakeCliShims(
  dir: string,
  shims: Record<string, { fixture: string; report?: string }>,
): Promise<Record<string, string>> {
  await fs.promises.mkdir(dir, { recursive: true });
  const out: Record<string, string> = {};
  for (const [name, { fixture, report }] of Object.entries(shims)) {
    const fakeArgs = [FAKE_CLI_SCRIPT, '--fake-fixture', fixture, ...(report ? ['--fake-report', report] : [])];
    if (process.platform === 'win32') {
      const shimPath = path.join(dir, `${name}.cmd`);
      const quoted = [process.execPath, ...fakeArgs].map((a) => `"${a}"`).join(' ');
      await fs.promises.writeFile(shimPath, `@echo off\r\n${quoted} %*\r\n`);
      out[name] = shimPath;
    } else {
      const shimPath = path.join(dir, name);
      const quoted = [process.execPath, ...fakeArgs].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
      await fs.promises.writeFile(shimPath, `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o755 });
      out[name] = shimPath;
    }
  }
  return out;
}

/** True when every field of `expected` is present and equal in `actual`. */
export function containsSubset(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (expected === null || typeof expected !== 'object') return false;
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((item, i) => containsSubset(item, actual[i]));
  }
  const actualRecord = actual as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>)
    .every(([key, value]) => containsSubset(value, actualRecord[key]));
}

/**
 * An append-only log with awaitable matches. Each `waitFor` resumes after
 * the previous match, so repeated waits walk forward through a stream (turn
 * one's completion, then turn two's).
 */
export class EventLog<T> {
  readonly items: T[] = [];
  private cursor = 0;
  private waiters = new Set<() => void>();

  push = (item: T): void => {
    this.items.push(item);
    for (const wake of this.waiters) wake();
  };

  /** Set once a log filled by `fromAsyncIterable` has drained its source. */
  ended = false;
  /** Set if that source threw. */
  error: unknown;

  /**
   * Collect an async stream (a ChatDriverSession's `events`, say) in the
   * background, so a test can `waitFor` drafts while it drives the session.
   */
  static fromAsyncIterable<U>(source: AsyncIterable<U>): EventLog<U> {
    const log = new EventLog<U>();
    void (async () => {
      try {
        for await (const item of source) log.push(item);
      } catch (err) {
        log.error = err;
      } finally {
        log.ended = true;
        for (const wake of log.waiters) wake();
      }
    })();
    return log;
  }

  /** The `type` of every item so far, for asserting a stream's shape. */
  types(this: EventLog<{ type: string }>): string[] {
    return this.items.map((item) => item.type);
  }

  async waitFor(match: ((item: T) => boolean) | Partial<T>, timeoutMs = 5000): Promise<T> {
    const predicate = typeof match === 'function'
      ? match as (item: T) => boolean
      : (item: T) => containsSubset(match, item);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = this.cursor; i < this.items.length; i++) {
        if (predicate(this.items[i])) {
          this.cursor = i + 1;
          return this.items[i];
        }
      }
      const remaining = deadline - Date.now();
      const what = typeof match === 'function' ? 'predicate' : JSON.stringify(match);
      if (this.ended) {
        throw new Error(`stream ended without ${what}${this.error ? `: ${String(this.error)}` : ''}`);
      }
      if (remaining <= 0) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, remaining);
        const waiters = this.waiters;
        function done() {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        }
        this.waiters.add(done);
      });
    }
  }
}

/**
 * Minimal NDJSON stdio peer for protocols without a Clubhouse client yet
 * (Claude stream-json and its control protocol). Every parsed stdout line
 * lands in `messages`; non-JSON lines land in `rawLines`.
 */
export class NdjsonPeer {
  readonly messages = new EventLog<Record<string, unknown>>();
  readonly rawLines: string[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private stderrChunks: string[] = [];
  private buffer = '';

  private constructor(private readonly proc: ChildProcess) {
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      const parts = (this.buffer + chunk).split('\n');
      this.buffer = parts.pop() ?? '';
      for (const raw of parts) {
        const line = raw.trim();
        if (!line) continue;
        try {
          this.messages.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          this.rawLines.push(line);
        }
      }
    });
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => this.stderrChunks.push(chunk));
    this.exited = new Promise((resolve) => {
      proc.on('exit', (code, signal) => resolve({ code, signal }));
    });
  }

  static start(binary: string, args: string[], opts: { windowsVerbatimArguments?: boolean } = {}): NdjsonPeer {
    return new NdjsonPeer(spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.windowsVerbatimArguments && { windowsVerbatimArguments: true }),
    }));
  }

  get stderr(): string {
    return this.stderrChunks.join('');
  }

  send(msg: unknown): void {
    this.proc.stdin?.write(JSON.stringify(msg) + '\n');
  }

  waitFor(match: ((msg: Record<string, unknown>) => boolean) | Record<string, unknown>, timeoutMs?: number) {
    return this.messages.waitFor(match, timeoutMs);
  }

  /** Close stdin, as a driver does when it is done with the CLI. */
  closeStdin(): void {
    this.proc.stdin?.end();
  }

  kill(): void {
    this.proc.kill();
  }
}
