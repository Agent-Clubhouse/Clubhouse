import { StringDecoder } from 'string_decoder';
import { LogRedactor } from '../../../shared/log-redaction';
import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { killStructuredChild, resolveStructuredSpawn } from '../../orchestrators/adapters/structured-spawn';

export type CopilotLaunchErrorCode = 'spawn_failed' | 'process_exited' | 'rpc_timeout';

export class CopilotLaunchError extends Error {
  constructor(message: string, readonly code: CopilotLaunchErrorCode) {
    super(message);
    this.name = 'CopilotLaunchError';
  }
}

export interface CopilotLaunchOptions {
  binary: string;
  extraArgs?: string[];
  commandPrefix?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  /** Shared with the session: later turns must be scrubbed before tail truncation. */
  logRedactor?: LogRedactor;
  signal?: AbortSignal;
}

export interface CopilotServer {
  /** For RuntimeConnection.forUri. Always loopback: the CLI binds 127.0.0.1. */
  readonly uri: string;
  /** Random per launch. The child gets it through its env, never its command line. */
  readonly connectionToken: string;
  /** Resolves when the process has exited. Never rejects. */
  readonly exited: Promise<void>;
  /** The exit code once it has exited, for the log. */
  exitCode(): number | null;
  /** The end of what it wrote to stderr, for error messages. */
  stderrTail(): string;
  stderrTailForLog?(): string;
  kill(): Promise<void>;
}

const LISTENING_RE = /listening on port (\d+)/i;
const STDERR_TAIL_CHARS = 4_000;

/**
 * Launch the user's `copilot` as a local server. Clubhouse spawns it rather
 * than letting the SDK do it because the SDK always adds `--no-auto-update`,
 * which runs the shim's built-in runtime instead of the version Terminal gets
 * (#2154, docs/copilot-sdk-driver.md "Running the user's CLI").
 */
export function launchCopilotServer(opts: CopilotLaunchOptions): Promise<CopilotServer> {
  const cmd = resolveStructuredSpawn(opts.binary, ['--headless', '--port', '0', ...(opts.extraArgs ?? [])], opts.commandPrefix);
  const connectionToken = randomBytes(32).toString('hex');
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new CopilotLaunchError('Copilot start cancelled', 'spawn_failed'));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(cmd.binary, cmd.args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env, COPILOT_CONNECTION_TOKEN: connectionToken },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: cmd.windowsVerbatimArguments,
      });
    } catch (err) {
      reject(new CopilotLaunchError(`Could not launch ${opts.binary}: ${(err as Error).message}`, 'spawn_failed'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stderrForLog = '';
    const stderrDecoder = new StringDecoder('utf8');
    const logRedactor = (opts.logRedactor ?? new LogRedactor(opts.extraArgs)).startRun();
    const stderrLog = logRedactor.stream();
    const addDiagnostic = (text: string) => { stderrForLog = (stderrForLog + text).slice(-STDERR_TAIL_CHARS); };
    let settled = false;
    const kill = () => killStructuredChild(child, { endStdin: false });
    const exited = new Promise<void>((done) => {
      const end = () => { logRedactor.endRun(); done(); };
      child.once('close', end);
      child.once('error', end);
    });
    const tail = () => stderr.trim();
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const fail = (message: string, code: CopilotLaunchErrorCode) => settle(() => {
      logRedactor.endRun();
      void kill();
      reject(new CopilotLaunchError(message, code));
    });
    const onAbort = () => fail('Copilot start cancelled', 'spawn_failed');
    const timer = setTimeout(() => fail(`Copilot did not start listening within ${opts.timeoutMs}ms`, 'rpc_timeout'), opts.timeoutMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString();
      addDiagnostic(stderrLog.feed(stderrDecoder.write(d)));
      stderr = (stderr + text).slice(-STDERR_TAIL_CHARS);
    });
    const flushDiagnostic = () => {
      addDiagnostic(stderrLog.feed(stderrDecoder.end()));
      addDiagnostic(stderrLog.flush());
    };
    child.stderr?.on('end', flushDiagnostic);
    child.on('close', flushDiagnostic);
    // Keep draining stdout after the port line, so the CLI can never block on a full pipe.
    child.stdout?.on('data', (d: Buffer) => {
      if (settled) return;
      stdout = (stdout + d.toString()).slice(-STDERR_TAIL_CHARS);
      const port = LISTENING_RE.exec(stdout)?.[1];
      if (!port) return;
      settle(() => resolve({ uri: `http://127.0.0.1:${port}`, connectionToken, exited, exitCode: () => child.exitCode, stderrTail: tail, stderrTailForLog: () => stderrForLog.trim(), kill }));
    });
    child.once('error', (err) => fail(`Could not launch ${opts.binary}: ${err.message}`, 'spawn_failed'));
    child.once('close', (code) => fail(`Copilot exited with code ${code} before it was ready${tail() ? `: ${tail()}` : ''}`, 'process_exited'));
  });
}
