/**
 * What each CLI says about its plan limits (#2671, docs/helper-auto-routing.md).
 * Read-only: a token-free handshake and one question, never a prompt, and only
 * on demand, when Settings > Helpers or a phone's page asks. There is no polling.
 *
 * Per provider and profile, since a profile can be a different login: one shared
 * read at a time, kept for {@link QUOTA_CACHE_MS}, with {@link QUOTA_FAILURE_BACKOFF_MS}
 * after a failure. A caller waits at most its budget, and sees `not_read` if the
 * read is still going. Running chat sessions also report limits, which fill in
 * between reads.
 *
 * Reading quota says nothing about capacity for sure. `unknown` stays `unknown`.
 */

import {
  classifyQuota,
  QUOTA_STALE_MS,
  type PlanQuotaReading,
  type QuotaSource,
  type QuotaView,
  type QuotaWindow,
} from '../../shared/helper-routing';
import type { UsageLimit } from '../../shared/chat/events';
import { getProvider } from '../orchestrators';
import type { OrchestratorId } from '../orchestrators';
import { helperQuotaRead } from '../telemetry/feature-events';
import { onChatEvent } from './agent-runtime/chat-event-bus';
import { agentRegistry } from './agent-registry';
import { resolveProfileEnv } from './agent-system';
import { appLog } from './log-service';

/** These are tunable starting proposals, not measured values. */
export const QUOTA_CACHE_MS = 5 * 60_000;
export const QUOTA_FAILURE_BACKOFF_MS = 60_000;
export const QUOTA_READ_BUDGET_MS = 3_000;

interface QuotaEntry {
  windows: QuotaWindow[];
  /** The CLI says this login has no plan limits. */
  notApplicable?: boolean;
  source: QuotaSource;
  /** When the last whole read came back. */
  readAt?: number;
  failedAt?: number;
  inFlight?: Promise<void>;
}

const entries = new Map<string, QuotaEntry>();

async function entryFor(providerId: string, projectPath: string | undefined): Promise<{ entry: QuotaEntry; env?: Record<string, string> }> {
  const env = projectPath ? await resolveProfileEnv(projectPath, providerId) : undefined;
  const key = JSON.stringify([providerId, Object.entries(env ?? {}).sort()]);
  let entry = entries.get(key);
  if (!entry) {
    entry = { windows: [], source: 'none' };
    entries.set(key, entry);
  }
  return { entry, ...(env && { env }) };
}

function startRead(providerId: string, entry: QuotaEntry, env: Record<string, string> | undefined): Promise<void> {
  const provider = getProvider(providerId as OrchestratorId);
  entry.inFlight ??= Promise.resolve()
    .then(() => provider!.readPlanQuota!({ ...(env && { env }) }))
    .then((reading: PlanQuotaReading) => {
      const now = Date.now();
      entry.readAt = now;
      entry.failedAt = undefined;
      entry.source = 'cli_query';
      entry.notApplicable = reading.kind === 'not_applicable';
      entry.windows = reading.kind === 'windows' ? reading.windows : [];
      helperQuotaRead(providerId, viewOf(entry, now).state, true);
    })
    .catch((err: unknown) => {
      // telemetry-exempt: helperQuotaRead below records it. Only the error's type is logged: a CLI's message could hold anything.
      entry.failedAt = Date.now();
      helperQuotaRead(providerId, 'unknown', false);
      appLog('core:orchestrator', 'warn', 'Could not read plan limits', { meta: { provider: providerId, error: err instanceof Error ? err.name : 'unknown' } });
    })
    .finally(() => { entry.inFlight = undefined; });
  return entry.inFlight;
}

function viewOf(entry: QuotaEntry, now: number): QuotaView {
  const refreshAfter = entry.failedAt !== undefined
    ? entry.failedAt + QUOTA_FAILURE_BACKOFF_MS - now
    : entry.readAt !== undefined ? entry.readAt + QUOTA_CACHE_MS - now : 0;
  const refreshAfterSeconds = Math.max(0, Math.ceil(refreshAfter / 1000));
  if (entry.notApplicable) {
    return { state: 'unknown', unknownReason: 'not_applicable', source: entry.source, asOf: entry.readAt ? new Date(entry.readAt).toISOString() : null, refreshAfterSeconds };
  }
  if (entry.windows.length === 0 && entry.readAt === undefined) {
    return {
      state: 'unknown', unknownReason: entry.failedAt !== undefined ? 'read_failed' : 'not_read', source: 'none', asOf: null,
      // A read still going will be done soon.
      refreshAfterSeconds: entry.inFlight ? Math.ceil(QUOTA_READ_BUDGET_MS / 1000) : refreshAfterSeconds,
    };
  }
  const classified = classifyQuota(entry.windows, now);
  // A failed read isn't what made an old reading stale, but it is why there is no newer one.
  const stale = entry.windows.length > 0 && entry.windows.every((w) => now - w.asOf > QUOTA_STALE_MS);
  return {
    ...classified,
    ...(classified.state === 'unknown' && { unknownReason: stale ? 'stale' as const : entry.failedAt !== undefined ? 'read_failed' as const : classified.unknownReason }),
    source: entry.source,
    refreshAfterSeconds,
  };
}

/**
 * What a provider's limits look like now. Never throws. A provider that can't
 * report is `not_supported`. Reads under `projectPath`'s profile when given.
 */
export async function readProviderQuota(providerId: string, projectPath?: string, options: { budgetMs?: number } = {}): Promise<QuotaView> {
  const provider = getProvider(providerId as OrchestratorId);
  if (!provider?.readPlanQuota) return { state: 'unknown', unknownReason: 'not_supported', source: 'none', asOf: null };
  try {
    const { entry, env } = await entryFor(providerId, projectPath);
    const now = Date.now();
    const fresh = entry.readAt !== undefined && now - entry.readAt < QUOTA_CACHE_MS;
    const backingOff = entry.failedAt !== undefined && now - entry.failedAt < QUOTA_FAILURE_BACKOFF_MS;
    if (!fresh && !backingOff) {
      const read = startRead(providerId, entry, env);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([read, new Promise<void>((resolve) => { timer = setTimeout(resolve, options.budgetMs ?? QUOTA_READ_BUDGET_MS); })]);
      clearTimeout(timer);
    }
    return viewOf(entry, Date.now());
  } catch (err) {
    // telemetry-exempt: it reads as unknown, which is what the caller shows; logged.
    appLog('core:orchestrator', 'warn', 'Could not check plan limits', { meta: { provider: providerId, error: err instanceof Error ? err.name : 'unknown' } });
    return { state: 'unknown', unknownReason: 'read_failed', source: 'none', asOf: null };
  }
}

/** A session reports these too, but they aren't limits on work: credits past the plan, and other apps' share. */
const SESSION_WINDOWS_LEFT_OUT = new Set(['overage', 'week_oauth_apps', 'week_overage_included']);

/** Windows a running session reported. They update what's known, by window, without touching the rest. */
function mergeSessionLimits(entry: QuotaEntry, limits: readonly UsageLimit[], now: number): void {
  const counted = limits.filter((limit) => !SESSION_WINDOWS_LEFT_OUT.has(limit.window));
  if (counted.length === 0) return;
  for (const limit of counted) {
    const known = entry.windows.find((w) => w.name === limit.window);
    const next: QuotaWindow = {
      name: limit.window,
      ...(limit.utilization !== undefined ? { usedPercent: Math.round(limit.utilization * 100) } : known?.usedPercent !== undefined ? { usedPercent: known.usedPercent } : {}),
      ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : known?.resetsAt !== undefined ? { resetsAt: known.resetsAt } : {}),
      // Only the provider's own word: `ok` clears an earlier one, and silence keeps it.
      ...(limit.status === 'exceeded' || (limit.status === undefined && known?.limitReached) ? { limitReached: true } : {}),
      asOf: now,
    };
    entry.windows = [...entry.windows.filter((w) => w.name !== limit.window), next];
  }
  entry.notApplicable = false;
  entry.source = 'session_event';
}

/** Keep quota current from running chat sessions. Returns the unsubscribe function. */
export function watchSessionQuota(): () => void {
  return onChatEvent((event) => {
    if (event.type !== 'usage') return;
    const limits = (event.data as { limits?: UsageLimit[] }).limits;
    if (!limits?.length) return;
    const registration = agentRegistry.get(event.agentId);
    if (!registration?.orchestrator) return;
    entryFor(registration.orchestrator, registration.projectPath)
      .then(({ entry }) => mergeSessionLimits(entry, limits, Date.now()))
      .catch((err: unknown) => {
        // telemetry-exempt: logged; the next read has it anyway.
        appLog('core:orchestrator', 'warn', 'Could not note a session\'s plan limits', { meta: { error: err instanceof Error ? err.name : 'unknown' } });
      });
  });
}

/** For testing. */
export function _resetProviderQuotaForTesting(): void {
  entries.clear();
}
