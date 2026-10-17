/**
 * Workspace telemetry helpers (spec §4.7–4.9, Phase 5): pure classifiers that
 * turn local failure details into closed `error.type` values. Stderr, paths
 * and messages are matched here, in the process, and never exported.
 *
 * No OpenTelemetry imports: this file is part of the main bundle.
 */
import type { ERROR_TYPES, SpanName } from '../../shared/telemetry/attributes';
import { currentFlow, tel } from './facade';
import type { FlowOptions, SpanHandle } from './types';

type ErrorType = (typeof ERROR_TYPES)[number];

/**
 * A child step only when a root flow is active (e.g. the Phase 4 agent
 * create/delete flows); otherwise just runs `fn`, so no orphan spans appear.
 */
export function stepUnderFlow<T>(name: SpanName, fn: () => T): T {
  return currentFlow() ? tel.step(name, fn) : fn();
}

/**
 * A flow whose thrown errors get a specific `error.type` instead of the
 * generic `unknown`: the error is caught inside the span, classified, and
 * rethrown unchanged once the span has ended.
 */
export async function flowClassifyingThrows<T>(
  name: SpanName,
  opts: FlowOptions,
  fn: (span: SpanHandle) => Promise<T>,
  classifyThrown: (err: unknown) => ErrorType,
): Promise<T> {
  let threw = false;
  let thrown: unknown;
  let errorType: ErrorType | undefined;
  const value = await tel.flow(name, opts, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      threw = true;
      thrown = err;
      errorType = classifyThrown(err);
      return undefined as T;
    }
  }, { classify: () => (errorType ? { error: errorType } : 'ok') });
  if (threw) throw thrown;
  return value;
}

export interface GitFailure {
  errorType: Extract<ErrorType, 'timeout' | 'not_a_repo' | 'validation' | 'nonzero_exit' | 'no_remote' | 'conflict' | 'auth'>;
  exitCode?: number;
  timedOut: boolean;
}

interface ExecErrorLike {
  code?: unknown;
  killed?: unknown;
  signal?: unknown;
  stderr?: unknown;
  message?: unknown;
}

const AUTH_RE = /authentication failed|permission denied \(publickey|could not read (username|password)|terminal prompts disabled|access denied|403 forbidden|invalid credentials/i;
const NO_REMOTE_RE = /no configured push destination|does not appear to be a git repository|no upstream branch|no such remote|no tracking information/i;
const CONFLICT_RE = /\bCONFLICT\b|merge conflict|unmerged|would be overwritten|resolve your current index first|needs merge/i;
const NOT_A_REPO_RE = /not a git repository/i;

/** Classify a failed `execFile('git', …)` from its exit code, signal and stderr. */
export function classifyGitFailure(err: unknown): GitFailure {
  const e = (err ?? {}) as ExecErrorLike;
  const exitCode = typeof e.code === 'number' ? e.code : undefined;
  const timedOut = e.killed === true && (e.signal === 'SIGTERM' || e.signal === 'SIGKILL') || e.code === 'ETIMEDOUT';
  if (timedOut) return { errorType: 'timeout', exitCode, timedOut: true };
  const text = `${typeof e.stderr === 'string' ? e.stderr : ''}\n${typeof e.message === 'string' ? e.message : ''}`;
  if (NOT_A_REPO_RE.test(text)) return { errorType: 'not_a_repo', exitCode, timedOut: false };
  if (AUTH_RE.test(text)) return { errorType: 'auth', exitCode, timedOut: false };
  if (NO_REMOTE_RE.test(text)) return { errorType: 'no_remote', exitCode, timedOut: false };
  if (CONFLICT_RE.test(text)) return { errorType: 'conflict', exitCode, timedOut: false };
  return { errorType: 'nonzero_exit', exitCode, timedOut: false };
}

const ERRNO_TYPES = new Set<ErrorType>(['ENOENT', 'EACCES', 'EISDIR', 'ENOTDIR', 'EEXIST', 'EPERM', 'ENOSPC', 'EMFILE']);

/** A filesystem failure as a closed error type (errno code, sandbox denial or `unknown`). */
export function classifyFsError(err: unknown): ErrorType {
  const code = (err as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && ERRNO_TYPES.has(code as ErrorType)) return code as ErrorType;
  const message = err instanceof Error ? err.message : '';
  if (/^Access denied: path/.test(message)) return 'path_denied';
  return 'unknown';
}

/** The editor family from the configured command, never the command itself. */
export function editorBucket(command: string): 'vscode' | 'cursor' | 'zed' | 'jetbrains' | 'other' {
  const base = command.trim().split(/[\\/]/).pop()?.toLowerCase().replace(/\.(exe|cmd|bat|app)$/, '') ?? '';
  if (base === 'code' || base === 'code-insiders' || base === 'codium' || base.startsWith('visual studio code')) return 'vscode';
  if (base === 'cursor') return 'cursor';
  if (base === 'zed' || base === 'zeditor') return 'zed';
  if (/^(idea|webstorm|pycharm|goland|rider|clion|phpstorm|rubymine|fleet)(64)?$/.test(base)) return 'jetbrains';
  return 'other';
}

/** Search engine failures (§4.9), from the execFile error of ripgrep. */
export function classifySearchError(err: unknown): Extract<ErrorType, 'timeout' | 'max_buffer' | 'bad_regex' | 'rg_failed'> {
  const e = (err ?? {}) as ExecErrorLike;
  if (e.killed === true || e.code === 'ETIMEDOUT') return 'timeout';
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'max_buffer';
  const message = typeof e.message === 'string' ? e.message : '';
  if (/regex parse error|error parsing regex|unclosed|invalid regular expression/i.test(message) || err instanceof SyntaxError) return 'bad_regex';
  return 'rg_failed';
}
