/**
 * What a terminal (TUI) run used, read from the CLI's own session file
 * (docs/usage-attribution.md). Deterministic parsing only: no model call, no
 * prompt, and nothing but ids, times, model, effort and token counts is kept
 * from a line.
 *
 * - Claude Code: `assistant` lines' `message.usage`, once per message id (it
 *   repeats a message's usage on each content block; the last record wins).
 * - Codex: `token_usage_record` lines' own `usage`, once per response id;
 *   model and effort from the run's latest `turn_context`.
 * - Other CLIs (Copilot, Antigravity): not read; the run is logged as `not_supported`.
 *
 * Only lines stamped within the run count, so a resumed session's earlier runs
 * in the same file are left out. The file is read backwards from its end and
 * reading stops at the first counted kind of line older than the run, so a
 * long session costs only its latest run. A run bigger than
 * TERMINAL_USAGE_MAX_SCAN_BYTES is read only that far back and marked partial.
 */
import * as fsp from 'fs/promises';
import type { TokenUsage } from '../../shared/chat';
import type { OrchestratorProvider } from '../orchestrators/types';
import { isSessionCapable } from '../orchestrators/types';
import { appLog } from './log-service';
import { logTerminalRunUsage, type RunUsage } from './agent-runtime/usage-attribution-log';

export const TERMINAL_USAGE_MAX_SCAN_BYTES = 256 * 1024 * 1024;
/** Clock slack between Clubhouse's run bounds and the CLI's line stamps. */
export const TERMINAL_USAGE_SLACK_MS = 5_000;
const CHUNK = 1024 * 1024;
/** A line longer than this (no usage line is) is dropped as it's read, so one huge line can't hold the whole scan in memory. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** Sessions whose last counted run is remembered, and ids remembered per session. */
const MAX_REMEMBERED_SESSIONS = 256;
const MAX_REMEMBERED_IDS = 5_000;

export type TerminalUsageFormat = 'claude' | 'codex';

/** The format of a CLI whose session files are read, by provider id; undefined for one that isn't. */
export function terminalUsageFormat(providerId: string): TerminalUsageFormat | undefined {
  return providerId === 'claude-code' ? 'claude' : providerId === 'codex-cli' ? 'codex' : undefined;
}

export interface TerminalRunUsage extends RunUsage {
  model?: string;
  effort?: string;
  /** Usage records counted. */
  records: number;
  /** Reading stopped at the byte limit before the run's start. */
  partial: boolean;
  /** Where this run stopped counting, so the session's next run starts after it (see SessionMark). */
  mark: SessionMark;
}

/**
 * The last line a session's previous run counted: its time, and the message or
 * response ids counted. The next run of the same session counts nothing at or
 * before that time that was already counted, so two runs closer together than
 * the clock slack can't both count the same lines.
 */
export interface SessionMark {
  lastAt: number;
  ids: ReadonlySet<string>;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** A file's complete lines, last first, at most `maxBytes` back from the end. `state.exhausted`: the top of the file was read. */
async function* linesFromEnd(file: string, maxBytes: number, state: { exhausted: boolean }): AsyncGenerator<string> {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const floor = Math.max(0, size - maxBytes);
    let pos = size;
    let rest = Buffer.alloc(0);
    while (pos > floor) {
      const len = Math.min(CHUNK, pos - floor);
      pos -= len;
      const chunk = Buffer.alloc(len);
      await handle.read(chunk, 0, len, pos);
      const buf = Buffer.concat([chunk, rest]);
      let end = buf.length;
      // Everything before the first newline may be part of an earlier line: keep it for the next chunk.
      for (let i = buf.lastIndexOf(10, end - 1); i !== -1; i = buf.lastIndexOf(10, end - 1)) {
        if (end - i > 1) yield buf.toString('utf-8', i + 1, end);
        end = i;
        if (i === 0) break;
      }
      // The rest of a line too long to be a usage line: dropped. What's left of it reads as a fragment, which isn't JSON.
      rest = end > MAX_LINE_BYTES ? Buffer.alloc(0) : Buffer.from(buf.subarray(0, end));
    }
    state.exhausted = floor === 0;
    if (floor === 0 && rest.length > 0) yield rest.toString('utf-8');
  } finally {
    await handle.close();
  }
}

function claudeUsage(u: unknown): TokenUsage | undefined {
  if (!isRec(u)) return undefined;
  const base = count(u.input_tokens);
  const read = count(u.cache_read_input_tokens);
  const write = count(u.cache_creation_input_tokens);
  const out: TokenUsage = {};
  if (base !== undefined || read !== undefined || write !== undefined) out.input = (base ?? 0) + (read ?? 0) + (write ?? 0);
  if (read !== undefined) out.cachedInput = read;
  if (write !== undefined) out.cacheWrite = write;
  const output = count(u.output_tokens);
  if (output !== undefined) out.output = output;
  return Object.keys(out).length > 0 ? out : undefined;
}

function codexUsage(u: unknown): TokenUsage | undefined {
  if (!isRec(u)) return undefined;
  const out: TokenUsage = {};
  const pairs: Array<[keyof TokenUsage, unknown]> = [
    ['input', u.input_tokens], ['cachedInput', u.cached_input_tokens], ['cacheWrite', u.cache_write_input_tokens],
    ['output', u.output_tokens], ['reasoning', u.reasoning_output_tokens],
  ];
  for (const [k, v] of pairs) {
    const n = count(v);
    if (n !== undefined) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function add(a: TokenUsage, b: TokenUsage): TokenUsage {
  const out: TokenUsage = {};
  for (const k of ['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'] as const) {
    if (a[k] !== undefined || b[k] !== undefined) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  }
  return out;
}

/**
 * Sum the usage a session file recorded between `startedAt` and `endedAt`
 * (epoch ms). Undefined when the run recorded none.
 */
export async function readTerminalRunUsage(
  file: string,
  format: TerminalUsageFormat,
  run: { startedAt: number; endedAt: number },
  maxBytes = TERMINAL_USAGE_MAX_SCAN_BYTES,
  previous?: SessionMark,
): Promise<TerminalRunUsage | undefined> {
  // Never before what the session's previous run already counted.
  const from = Math.max(run.startedAt - TERMINAL_USAGE_SLACK_MS, previous?.lastAt ?? -Infinity);
  const to = run.endedAt + TERMINAL_USAGE_SLACK_MS;
  const marker = format === 'claude' ? '"usage"' : '"token_usage_record"';
  const seen = new Set<string>();
  const counted = new Set<string>();
  let lastAt = -Infinity;
  let tokens: TokenUsage = {};
  let records = 0;
  let model: string | undefined;
  let effort: string | undefined;
  let reachedStart = false;
  const scan = { exhausted: false };
  // Leaving the loop early closes the file (the generator's finally).
  for await (const line of linesFromEnd(file, maxBytes, scan)) {
    const context = format === 'codex' && line.includes('"turn_context"');
    if (!context && !line.includes(marker)) continue;
    let o: Rec;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRec(parsed)) continue;
      o = parsed;
    } catch {
      // telemetry-exempt: a line the CLI was still writing, or not JSON; it holds no usage we can read
      continue;
    }
    const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (Number.isNaN(at)) continue;
    if (at > to) continue;
    if (at < from) {
      reachedStart = true;
      break;
    }
    if (format === 'claude') {
      const message = isRec(o.message) ? o.message : undefined;
      if (o.type !== 'assistant' || !message) continue;
      const usage = claudeUsage(message.usage);
      if (!usage) continue;
      // Last first: the first record of a message id met here is its final one.
      const id = typeof message.id === 'string' && message.id ? message.id : undefined;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (previous?.ids.has(id)) continue;
        counted.add(id);
      }
      lastAt = Math.max(lastAt, at);
      model ??= typeof message.model === 'string' ? message.model : undefined;
      effort ??= typeof o.effort === 'string' ? o.effort : undefined;
      tokens = add(tokens, usage);
      records++;
      continue;
    }
    const payload = isRec(o.payload) ? o.payload : undefined;
    if (!payload) continue;
    if (o.type === 'turn_context') {
      model ??= typeof payload.model === 'string' ? payload.model : undefined;
      effort ??= typeof payload.effort === 'string' ? payload.effort : undefined;
      continue;
    }
    if (o.type !== 'token_usage_record') continue;
    const usage = codexUsage(payload.usage);
    if (!usage) continue;
    const id = typeof payload.response_id === 'string' && payload.response_id ? payload.response_id : undefined;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (previous?.ids.has(id)) continue;
      counted.add(id);
    }
    lastAt = Math.max(lastAt, at);
    tokens = add(tokens, usage);
    records++;
  }
  // Read to the top of the file without meeting an older line: the whole run was read.
  if (!reachedStart) reachedStart = scan.exhausted;
  if (records === 0) return undefined;
  return {
    tokens,
    source: 'summed_calls',
    dedup: format === 'claude' ? 'message_id' : 'response_id',
    ...(model && { model }),
    ...(effort && { effort }),
    records,
    partial: !reachedStart,
    mark: { lastAt, ids: new Set([...counted].slice(-MAX_REMEMBERED_IDS)) },
  };
}

/** Each session's last counted run, by provider and native session id; the oldest is forgotten past the limit. */
const sessionMarks = new Map<string, SessionMark>();

function remember(key: string, mark: SessionMark): void {
  sessionMarks.delete(key);
  sessionMarks.set(key, mark);
  if (sessionMarks.size > MAX_REMEMBERED_SESSIONS) sessionMarks.delete(sessionMarks.keys().next().value!);
}

export function _resetTerminalUsageForTesting(): void {
  sessionMarks.clear();
}

/**
 * Log the usage of a terminal run that just ended. Never throws and never
 * blocks the exit: the caller doesn't wait on it.
 *
 * `captureSource` is how the run's session id was found. An id scraped from
 * the terminal's output is the weakest capture (it can be text the
 * conversation printed), so its file isn't read: the line says
 * `scraped_session_id`.
 */
export async function recordTerminalRunUsage(run: {
  agentId: string;
  provider: OrchestratorProvider;
  cwd: string;
  nativeSessionId: string | undefined;
  captureSource?: string;
  startedAt: number;
  endedAt: number;
  exitCode: number;
}): Promise<void> {
  const base = {
    agentId: run.agentId,
    startedAt: run.startedAt,
    provider: run.provider.id,
    ...(run.nativeSessionId && { nativeSessionId: run.nativeSessionId }),
    outcome: run.exitCode === 0 ? 'exited' : 'exited_with_error',
    durationMs: run.endedAt - run.startedAt,
  };
  const format = terminalUsageFormat(run.provider.id);
  if (!format) {
    logTerminalRunUsage({ ...base, usage: undefined, coverage: 'not_supported' });
    return;
  }
  if (run.nativeSessionId && run.captureSource === 'output_scrape') {
    logTerminalRunUsage({ ...base, usage: undefined, coverage: 'scraped_session_id' });
    return;
  }
  try {
    const file = run.nativeSessionId && isSessionCapable(run.provider) && run.provider.transcriptPath
      ? await run.provider.transcriptPath(run.nativeSessionId, run.cwd)
      : null;
    if (!file) {
      logTerminalRunUsage({ ...base, usage: undefined, coverage: 'no_session' });
      return;
    }
    const key = `${run.provider.id}\u0000${run.nativeSessionId}`;
    const usage = await readTerminalRunUsage(file, format, run, undefined, sessionMarks.get(key));
    if (usage) remember(key, usage.mark);
    logTerminalRunUsage({
      ...base,
      ...(usage?.model && { model: usage.model }),
      ...(usage?.effort && { effort: usage.effort }),
      usage: usage && { tokens: usage.tokens, source: usage.source, dedup: usage.dedup },
      ...(usage?.partial && { partial: true }),
      // The file was read, but the run recorded nothing in it.
      ...(!usage && { coverage: 'no_usage' }),
    });
  } catch (err) {
    // telemetry-exempt: logged as a warning and as a read_failed usage line
    appLog('core:usage', 'warn', 'Could not read a terminal run\'s usage', {
      // The code only: an error message can name the file, and usage lines carry no paths.
      meta: { agentId: run.agentId, provider: run.provider.id, code: (err as NodeJS.ErrnoException)?.code ?? 'error' },
    });
    logTerminalRunUsage({ ...base, usage: undefined, coverage: 'read_failed' });
  }
}
