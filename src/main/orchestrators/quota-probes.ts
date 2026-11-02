/**
 * Plan limits from each CLI's own protocol (#2671). Every probe spawns the
 * user's CLI, completes the handshake, asks one read-only question and kills the
 * process. None sends a prompt, so none costs tokens.
 *
 * - Claude Code: the stream-json control request `get_usage`, with
 *   `skip_behaviors`. The SDK labels it experimental, so anything unexpected in a
 *   reply reads as "couldn't read" and never as a number.
 * - Codex: app-server's `account/rateLimits/read`.
 *
 * Only the limit fields are read, by name. Everything else in a reply (account
 * ids, plan, spend) is dropped here and never stored or logged.
 */

import type { ChildProcess } from 'child_process';
import { ClaudeStreamTransport } from '../chat/claude/stream-transport';
import { spawnClaude } from '../chat/claude/spawn';
import { killStructuredChild, resolveStructuredSpawn } from './adapters/structured-spawn';
import { CodexAppServerClient } from './adapters/codex-app-server-client';
import type { RateLimitSnapshot } from './adapters/codex-protocol';
import type { PlanQuotaReading, QuotaWindow } from '../../shared/helper-routing';
import { buildCliSpawnEnv } from '../util/shell';
import type { ModelProbeContext } from './model-probes';

/** A reply that isn't the shape we know. The service treats it as a failed read. */
export class QuotaShapeError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const percent = (v: number): number => Math.round(Math.min(100, Math.max(0, v)));

// ── Claude Code ──────────────────────────────────────────────────────────

const CLAUDE_WINDOWS: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'week',
  seven_day_opus: 'week_opus',
  seven_day_sonnet: 'week_sonnet',
};

function epochMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

function claudeWindow(name: string, raw: Record<string, unknown>, asOf: number): QuotaWindow {
  const resetsAt = epochMs(raw.resets_at);
  return {
    name,
    ...(finite(raw.utilization) && { usedPercent: percent(raw.utilization) }),
    ...(resetsAt !== undefined && { resetsAt }),
    asOf,
  };
}

/** Limits from a `get_usage` reply. Throws QuotaShapeError on anything it doesn't recognize. */
export function parseClaudeUsage(reply: unknown, asOf: number): PlanQuotaReading {
  if (!isObj(reply) || typeof reply.rate_limits_available !== 'boolean') throw new QuotaShapeError('get_usage had no rate_limits_available');
  if (!reply.rate_limits_available) return { kind: 'not_applicable' };
  if (!isObj(reply.rate_limits)) throw new QuotaShapeError('get_usage had no rate_limits');
  const windows: QuotaWindow[] = [];
  for (const [key, name] of Object.entries(CLAUDE_WINDOWS)) {
    const raw = reply.rate_limits[key];
    if (raw === null || raw === undefined) continue;
    if (!isObj(raw)) throw new QuotaShapeError(`get_usage ${key} wasn't an object`);
    windows.push(claudeWindow(name, raw, asOf));
  }
  const scoped = reply.rate_limits.model_scoped;
  if (Array.isArray(scoped)) {
    for (const raw of scoped) {
      if (isObj(raw) && typeof raw.display_name === 'string' && raw.display_name) windows.push(claudeWindow(`week:${raw.display_name}`, raw, asOf));
    }
  }
  return { kind: 'windows', windows };
}

export async function probeClaudeQuota(ctx: ModelProbeContext): Promise<PlanQuotaReading> {
  let child: ChildProcess | undefined;
  const transport = new ClaudeStreamTransport(
    { binary: ctx.binary, cwd: ctx.cwd, permissionMode: 'default', includePartialMessages: false, env: ctx.env, signal: ctx.signal, log: ctx.log },
    (opts) => (child = spawnClaude(opts)),
  );
  try {
    // Completes `initialize`, as the model probe does. No user message is written.
    await transport.start();
    return parseClaudeUsage(await transport.planUsage(), Date.now());
  } finally {
    if (child) await killStructuredChild(child);
  }
}

// ── Codex ────────────────────────────────────────────────────────────────

const WEEK_MINUTES = 10_080;
const FIVE_HOUR_MINUTES = 300;

function codexWindowName(minutes: number | null | undefined): string {
  if (minutes === WEEK_MINUTES) return 'week';
  if (minutes === FIVE_HOUR_MINUTES) return '5h';
  return finite(minutes) ? `${minutes}m` : 'window';
}

/**
 * Limits from `account/rateLimits/read`. `primary` isn't always the shorter
 * window (on one login it was the week), so a window is named by its duration.
 */
export function parseCodexRateLimits(snapshot: unknown, asOf: number): PlanQuotaReading {
  if (!isObj(snapshot)) throw new QuotaShapeError('account/rateLimits/read had no rateLimits');
  const { primary, secondary, rateLimitReachedType } = snapshot as unknown as RateLimitSnapshot;
  const raws = [primary, secondary].filter((w) => w !== null && w !== undefined);
  const windows: QuotaWindow[] = raws.map((raw): QuotaWindow => {
    if (!isObj(raw)) throw new QuotaShapeError('account/rateLimits/read window wasn\'t an object');
    return {
      name: codexWindowName(raw.windowDurationMins),
      ...(finite(raw.usedPercent) && { usedPercent: percent(raw.usedPercent) }),
      // Codex reports Unix seconds.
      ...(finite(raw.resetsAt) && { resetsAt: raw.resetsAt * 1000 }),
      asOf,
    };
  });
  if (rateLimitReachedType) {
    // It doesn't say which window is reached, so it goes on the fullest.
    const fullest = [...windows].sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0];
    if (fullest) fullest.limitReached = true;
    else windows.push({ name: 'window', limitReached: true, asOf });
  }
  return { kind: 'windows', windows };
}

/** A login with no ChatGPT plan, such as an API key, has no limits to read. Codex 0.163 says so in this error. */
export function isCodexNoPlanError(err: unknown): boolean {
  return err instanceof Error && /authentication required to read rate limits/i.test(err.message);
}

export async function probeCodexQuota(ctx: ModelProbeContext): Promise<PlanQuotaReading> {
  ctx.signal.throwIfAborted();
  const client = new CodexAppServerClient({
    ...resolveStructuredSpawn(ctx.binary, ['app-server']),
    cwd: ctx.cwd,
    env: buildCliSpawnEnv(ctx.env),
    rpcTimeoutMs: ctx.timeoutMs,
    onLog: ctx.log,
  });
  const onAbort = () => client.kill();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await client.start();
    return parseCodexRateLimits(await client.readRateLimits(), Date.now());
  } catch (err) {
    if (isCodexNoPlanError(err)) return { kind: 'not_applicable' };
    throw err;
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
    client.kill();
  }
}
