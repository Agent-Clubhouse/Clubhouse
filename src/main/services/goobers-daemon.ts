/**
 * Daemon lifecycle control — `goobers up`/`goobers down` (spec §7.5).
 *
 * Spawned with `execFile`-style argv and the login-shell environment
 * (`getShellEnvironment()`, §2.7) — never a shell command string. A daemon
 * started with Electron's inherited PATH fails `local-ci` stages in subtle
 * ways; routing through the existing helper is also what makes this
 * unit-testable (assert the exact argv + env passed to `spawn`).
 *
 * Start has no useful exit code (a detached spawn tells us nothing, and a
 * daemon that dies on bad config dies silently) — success is defined by
 * observation: `api.address` appears AND `/readyz` 200 AND the identity
 * check passes, bounded at 60s. Stop's exit 0 does NOT mean stopped — the
 * drain is unbounded; this module only issues the stop-request, the caller
 * (GoobersService) keeps polling liveness until it actually clears.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { getShellEnvironment } from '../util/shell';
import { probeLiveness } from './goobers-liveness';

const MAX_BUFFER_BYTES = 64 * 1024;
const START_TIMEOUT_MS = 60_000;
const START_POLL_INTERVAL_MS = 750;
const STDIO_CAPTURE_WINDOW_MS = 5000;

export type LifecycleOp = 'starting' | 'stopping' | null;

let currentOp: LifecycleOp = null;

export function isLifecycleBusy(): boolean {
  return currentOp !== null;
}

/** Test-only escape hatch — reset the module-level lifecycle lock. */
export function _resetLifecycleStateForTests(): void {
  currentOp = null;
}

export interface StartResult {
  ok: boolean;
  error?: string;
  /** Present when a lock-contention exit was treated as success-adjacent. */
  holderKind?: 'daemon' | 'manual';
  stderr?: string;
  logPathHint?: string;
}

export interface StopResult {
  ok: boolean;
  error?: string;
  /** True when `goobers down` exited 1 — no daemon was holding the lock. */
  alreadyStopped?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BufferedSpawn {
  child: ChildProcess;
  getBuffer: () => string;
}

function bufferedSpawn(binaryPath: string, args: string[], env: Record<string, string>): BufferedSpawn {
  const child = spawn(binaryPath, args, {
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buffer = '';
  let bufferBytes = 0;
  let capturing = true;

  const onData = (chunk: Buffer) => {
    if (!capturing) return;
    buffer += chunk.toString('utf-8');
    bufferBytes += chunk.length;
    if (bufferBytes >= MAX_BUFFER_BYTES) {
      buffer = buffer.slice(0, MAX_BUFFER_BYTES);
      capturing = false;
      child.stdout?.removeListener('data', onData);
      child.stderr?.removeListener('data', onData);
    }
  };

  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const stopCapturing = setTimeout(() => {
    capturing = false;
    child.stdout?.removeAllListeners('data');
    child.stderr?.removeAllListeners('data');
    child.unref();
  }, STDIO_CAPTURE_WINDOW_MS);
  stopCapturing.unref?.();

  return { child, getBuffer: () => buffer };
}

async function readHolderKind(root: string): Promise<'daemon' | 'manual'> {
  try {
    const raw = await fs.promises.readFile(path.join(root, 'scheduler', 'up.lock'), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.holderKind === 'manual' ? 'manual' : 'daemon';
  } catch {
    return 'daemon';
  }
}

function isLockContentionMessage(text: string): boolean {
  return /already holds the lock/i.test(text);
}

/**
 * `goobers up <root>`. Never pre-checks for an existing lock — attempts the
 * spawn and interprets the result, since a pre-check is not atomic with the
 * spawn (§7.5).
 */
export async function startDaemon(root: string, resolvedBinaryPath: string): Promise<StartResult> {
  if (currentOp) return { ok: false, error: 'lifecycle-busy' };
  currentOp = 'starting';

  try {
    const env = getShellEnvironment();
    const { child, getBuffer } = bufferedSpawn(resolvedBinaryPath, ['up', root], env);

    let exited = false;
    let exitCode: number | null = null;
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
    });
    child.on('error', () => {
      exited = true;
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) {
        const stderrText = getBuffer();
        if (exitCode === 1 && isLockContentionMessage(stderrText)) {
          const holderKind = await readHolderKind(root);
          return { ok: true, holderKind };
        }
        return {
          ok: false,
          error: 'daemon exited before becoming ready',
          stderr: stderrText,
          logPathHint: path.join(root, 'scheduler'),
        };
      }

      const liveness = await probeLiveness(root);
      if (liveness.daemon.state === 'running' && !liveness.error) {
        return { ok: true };
      }

      await sleep(START_POLL_INTERVAL_MS);
    }

    return {
      ok: false,
      error: 'timed out waiting for the daemon to become ready (60s)',
      stderr: getBuffer(),
      logPathHint: path.join(root, 'scheduler'),
    };
  } finally {
    currentOp = null;
  }
}

/**
 * `goobers down <root>`. Writes the stop-request; the daemon drains on its
 * own schedule (30-40 min is normal for an in-flight agentic stage). Exit 0
 * only means the request was accepted, never that the daemon has stopped —
 * callers must keep polling liveness (§7.5).
 */
export async function stopDaemon(root: string, resolvedBinaryPath: string): Promise<StopResult> {
  if (currentOp) return { ok: false, error: 'lifecycle-busy' };
  currentOp = 'stopping';

  try {
    const env = getShellEnvironment();
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn(resolvedBinaryPath, ['down', root], {
        env,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('exit', (code) => resolve(code));
      child.on('error', () => resolve(null));
      child.unref();
    });

    if (exitCode === 1) {
      return { ok: true, alreadyStopped: true };
    }
    if (exitCode !== 0) {
      return { ok: false, error: `goobers down exited with code ${String(exitCode)}` };
    }
    return { ok: true };
  } finally {
    currentOp = null;
  }
}
