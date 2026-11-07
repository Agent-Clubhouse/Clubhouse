/**
 * What each CLI says about its plan limits (#2671, docs/helper-auto-routing.md).
 * Read-only: a token-free handshake and one question, never a prompt, and only
 * on demand, when Settings > Helpers or a phone's page asks. There is no polling.
 *
 * Per provider, for the one login each CLI has in the local environment: one shared
 * read at a time, kept for {@link QUOTA_CACHE_MS}, with {@link QUOTA_FAILURE_BACKOFF_MS}
 * after a failure. A caller waits at most its budget, and sees `not_read` if the
 * read is still going. Running chat sessions also report limits, which fill in
 * between reads. Check again in Settings skips the cache and the backoff: see
 * {@link forceProviderQuota}.
 *
 * Reading quota says nothing about capacity for sure. `unknown` stays `unknown`.
 */

import {
  classifyQuota,
  QUOTA_STALE_MS,
  type HelperStartWarning,
  type PlanQuotaReading,
  type QuotaSource,
  type QuotaView,
  type QuotaWindow,
} from '../../shared/helper-routing';
import type { UsageLimit } from '../../shared/chat/events';
import { getProvider } from '../orchestrators';
import type { OrchestratorId } from '../orchestrators';
import { helperAutoCooldown, helperQuotaRead } from '../telemetry/feature-events';
import { recordQuotaSample } from '../telemetry/helper-usage';
import { isLoginRequiredError } from './agent-runtime/login-error';
import { AUTO_COOLDOWN_AUTH_MS, AUTO_COOLDOWN_AVAILABILITY_MS, AUTO_COOLDOWN_QUOTA_MS } from './helper-auto-policy';
import { onChatEvent } from './agent-runtime/chat-event-bus';
import { agentRegistry } from './agent-registry';
import { appLog } from './log-service';

/** These are tunable starting proposals, not measured values. */
export const QUOTA_CACHE_MS = 5 * 60_000;
export const QUOTA_FAILURE_BACKOFF_MS = 60_000;
export const QUOTA_READ_BUDGET_MS = 3_000;
/** A person pressed a button and is waiting on the answer. Past a handshake's own 10 second deadline, so it's only a backstop. */
export const QUOTA_FORCED_READ_BUDGET_MS = 12_000;

interface SettledRead {
  /** A cooldown noted after this isn't answered by this read. */
  startedAt: number;
  outcome: PlanQuotaReading['kind'] | 'failed';
}

interface Cooldown {
  until: number;
  /** When it began, for saying how old a warning is. */
  at: number;
}

interface QuotaEntry {
  windows: QuotaWindow[];
  /** The CLI says this login has no plan limits. */
  notApplicable?: boolean;
  source: QuotaSource;
  /** When the last whole read came back. */
  readAt?: number;
  failedAt?: number;
  inFlight?: Promise<SettledRead>;
  /**
   * Auto leaves this provider alone until the last of these ends.
   * Explicit starts aren't affected. By kind, since one can be cleared and the
   * others can't.
   */
  cooldowns: Partial<Record<StartFailureClass, Cooldown>>;
}

const entries = new Map<string, QuotaEntry>();

function entryFor(providerId: string): QuotaEntry {
  let entry = entries.get(providerId);
  if (!entry) {
    entry = { windows: [], source: 'none', cooldowns: {} };
    entries.set(providerId, entry);
  }
  return entry;
}

function startRead(providerId: string, entry: QuotaEntry): Promise<SettledRead> {
  if (entry.inFlight) return entry.inFlight;
  const provider = getProvider(providerId as OrchestratorId);
  const startedAt = Date.now();
  entry.inFlight = Promise.resolve()
    .then(() => provider!.readPlanQuota!())
    .then((reading: PlanQuotaReading): SettledRead => {
      const now = Date.now();
      entry.readAt = now;
      entry.failedAt = undefined;
      entry.source = 'cli_query';
      entry.notApplicable = reading.kind === 'not_applicable';
      entry.windows = reading.kind === 'windows' ? reading.windows : [];
      const view = viewOf(entry, now);
      helperQuotaRead(providerId, view.state, true);
      recordQuotaSample(providerId, view);
      return { startedAt, outcome: reading.kind };
    })
    .catch((err: unknown): SettledRead => {
      // telemetry-exempt: helperQuotaRead below records it. Only the error's type is logged: a CLI's message could hold anything.
      entry.failedAt = Date.now();
      helperQuotaRead(providerId, 'unknown', false);
      appLog('core:orchestrator', 'warn', 'Could not read plan limits', { meta: { provider: providerId, error: err instanceof Error ? err.name : 'unknown' } });
      return { startedAt, outcome: 'failed' };
    })
    .finally(() => { entry.inFlight = undefined; });
  return entry.inFlight;
}

function viewOf(entry: QuotaEntry, now: number, model?: string): QuotaView {
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
  const classified = classifyQuota(entry.windows, now, model ? { model } : {});
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
 * report is `not_supported`.
 * `model` also counts that model's own limit, for a choice of that model.
 */
export async function readProviderQuota(providerId: string, options: { budgetMs?: number; model?: string } = {}): Promise<QuotaView> {
  const provider = getProvider(providerId as OrchestratorId);
  if (!provider?.readPlanQuota) return { state: 'unknown', unknownReason: 'not_supported', source: 'none', asOf: null };
  try {
    const entry = entryFor(providerId);
    const now = Date.now();
    const fresh = entry.readAt !== undefined && now - entry.readAt < QUOTA_CACHE_MS;
    const backingOff = entry.failedAt !== undefined && now - entry.failedAt < QUOTA_FAILURE_BACKOFF_MS;
    if (!fresh && !backingOff) {
      const read = startRead(providerId, entry);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([read, new Promise<void>((resolve) => { timer = setTimeout(resolve, options.budgetMs ?? QUOTA_READ_BUDGET_MS); })]);
      clearTimeout(timer);
    }
    return viewOf(entry, Date.now(), options.model);
  } catch (err) {
    // telemetry-exempt: it reads as unknown, which is what the caller shows; logged.
    appLog('core:orchestrator', 'warn', 'Could not check plan limits', { meta: { provider: providerId, error: err instanceof Error ? err.name : 'unknown' } });
    return { state: 'unknown', unknownReason: 'read_failed', source: 'none', asOf: null };
  }
}

export type ForcedQuotaOutcome = 'ok' | 'failed' | 'timed_out' | 'not_supported';

/**
 * Read now, whatever the cache and the failure backoff say, for a person who has
 * just signed back in. Still one read at a time: one already going is shared.
 * Never throws.
 *
 * Reading limits proves a login, so it ends an auth cooldown older than the read,
 * even if that read outlasts this caller's budget. Only a reading with windows
 * counts: Codex answers `not_applicable` when logged out as well as for an API key.
 * A quota or availability cooldown says nothing about the login, so it stays.
 */
export async function forceProviderQuota(providerId: string, options: { budgetMs?: number } = {}): Promise<{ quota: QuotaView; outcome: ForcedQuotaOutcome }> {
  const provider = getProvider(providerId as OrchestratorId);
  if (!provider?.readPlanQuota) return { quota: { state: 'unknown', unknownReason: 'not_supported', source: 'none', asOf: null }, outcome: 'not_supported' };
  try {
    const entry = entryFor(providerId);
    let outcome: ForcedQuotaOutcome = 'timed_out';
    const read = startRead(providerId, entry).then((settled) => {
      outcome = settled.outcome === 'failed' ? 'failed' : 'ok';
      const auth = entry.cooldowns.auth;
      if (settled.outcome === 'windows' && auth && auth.at <= settled.startedAt) delete entry.cooldowns.auth;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([read, new Promise<void>((resolve) => { timer = setTimeout(resolve, options.budgetMs ?? QUOTA_FORCED_READ_BUDGET_MS); })]);
    clearTimeout(timer);
    return { quota: viewOf(entry, Date.now()), outcome };
  } catch (err) {
    // telemetry-exempt: it reads as unknown, which is what the caller shows; logged.
    appLog('core:orchestrator', 'warn', 'Could not check plan limits', { meta: { provider: providerId, error: err instanceof Error ? err.name : 'unknown' } });
    return { quota: { state: 'unknown', unknownReason: 'read_failed', source: 'none', asOf: null }, outcome: 'failed' };
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

export type StartFailureClass = 'auth' | 'quota' | 'availability';

const COOLDOWN_MS: Record<StartFailureClass, number> = {
  auth: AUTO_COOLDOWN_AUTH_MS,
  quota: AUTO_COOLDOWN_QUOTA_MS,
  availability: AUTO_COOLDOWN_AVAILABILITY_MS,
};

/** What a failed start tells Auto about the provider. A task's own failure isn't a start's. */
export function classifyStartFailure(err: unknown): StartFailureClass {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'auth_required' || code === 'account_issue' || isLoginRequiredError(message)) return 'auth';
  if (code === 'rate_limited' || /rate.?limit|usage limit/i.test(message)) return 'quota';
  return 'availability';
}

/**
 * Auto leaves this provider alone for a fixed while. A quota failure is the
 * provider saying its limit is reached, so the state says so too, until a read
 * says otherwise. Never throws.
 */
export async function noteProviderFailure(providerId: string, kind: StartFailureClass, resetsAt?: number): Promise<void> {
  try {
    const entry = entryFor(providerId);
    const now = Date.now();
    // A limit we already know is reached says when it comes back.
    const knownReset = kind === 'quota'
      ? resetsAt ?? entry.windows.filter((w) => w.limitReached && w.resetsAt !== undefined && w.resetsAt > now).map((w) => w.resetsAt!).sort((a, b) => b - a)[0]
      : undefined;
    const until = knownReset && knownReset > now ? knownReset : now + COOLDOWN_MS[kind];
    entry.cooldowns[kind] = { until: Math.max(entry.cooldowns[kind]?.until ?? 0, until), at: now };
    if (kind === 'quota') {
      entry.windows = [...entry.windows.filter((w) => w.name !== 'window'), { name: 'window', limitReached: true, resetsAt: until, asOf: now }];
      entry.source = 'session_event';
      entry.notApplicable = false;
    }
    helperAutoCooldown(providerId, kind);
  } catch (err) {
    // telemetry-exempt: logged; the worst case is that Auto tries this provider again.
    appLog('core:orchestrator', 'warn', 'Could not note a provider failure', { meta: { provider: providerId, error: err instanceof Error ? err.name : 'unknown' } });
  }
}

function activeCooldowns(entry: QuotaEntry, now: number): Cooldown[] {
  return Object.values(entry.cooldowns).filter((cooldown) => cooldown.until > now);
}

export async function isProviderCoolingDown(providerId: string): Promise<boolean> {
  const entry = entryFor(providerId);
  return activeCooldowns(entry, Date.now()).length > 0;
}

/**
 * A warning for a start that names this provider, from what is already known. An
 * explicit start is never blocked by quota or a cooldown, and this reads nothing
 * from a CLI, so it says nothing until something has. Never throws.
 */
export async function providerStartWarning(providerId: string): Promise<HelperStartWarning | undefined> {
  try {
    const entry = entryFor(providerId);
    const now = Date.now();
    const cooling = activeCooldowns(entry, now);
    if (cooling.length > 0) {
      return {
        code: 'cooling_down',
        asOf: new Date(Math.max(...cooling.map((cooldown) => cooldown.at))).toISOString(),
        message: `${providerId} failed to start or hit its limit recently. The helper is started on it anyway, as asked.`,
      };
    }
    if (entry.windows.length === 0) return undefined;
    const { state, asOf } = classifyQuota(entry.windows, now);
    if (!asOf) return undefined;
    if (state === 'exhausted') return { code: 'quota_exhausted', asOf, message: `${providerId} reports its plan limit reached. The helper is started on it anyway, as asked, and may stop right away.` };
    if (state === 'near_limit') return { code: 'quota_near_limit', asOf, message: `${providerId} is close to its plan limit. The helper is started on it anyway, as asked.` };
    return undefined;
  } catch {
    // telemetry-exempt: only a warning, and the start goes on
    return undefined;
  }
}

const SESSION_ERROR_CLASS: Record<string, StartFailureClass> = {
  auth_required: 'auth',
  account_issue: 'auth',
  rate_limited: 'quota',
};

/**
 * Keep quota current from running chat sessions, and notice a provider a session
 * found out of quota or logged out. That helper isn't moved or retried: this only
 * tells Auto about future starts. Returns the unsubscribe function.
 */
export function watchSessionQuota(): () => void {
  return onChatEvent((event) => {
    if (event.type === 'error') {
      const kind = SESSION_ERROR_CLASS[(event.data as { code?: string }).code ?? ''];
      const running = kind && agentRegistry.get(event.agentId);
      if (running && running.orchestrator) void noteProviderFailure(running.orchestrator, kind);
      return;
    }
    if (event.type !== 'usage') return;
    const limits = (event.data as { limits?: UsageLimit[] }).limits;
    if (!limits?.length) return;
    const registration = agentRegistry.get(event.agentId);
    if (!registration?.orchestrator) return;
    try {
      mergeSessionLimits(entryFor(registration.orchestrator), limits, Date.now());
    } catch (err) {
      // telemetry-exempt: logged; the next read has it anyway.
      appLog('core:orchestrator', 'warn', 'Could not note a session\'s plan limits', { meta: { error: err instanceof Error ? err.name : 'unknown' } });
    }
  });
}

/** For testing. */
export function _resetProviderQuotaForTesting(): void {
  entries.clear();
}
