/**
 * The Dispatcher's usage for Settings › Dispatcher (#3046): conversations and
 * background work, across every provider it ran on.
 *
 * Totals come from its sessions' transcripts, both agents' folders and every
 * session-capable provider, for sessions active in the last
 * USAGE_WINDOW_DAYS days. A provider switch keeps memory and starts a fresh
 * conversation, so older sessions on the previous provider still count.
 *
 * Background work (check-ins and memory upkeep run as hidden Actions, #3040)
 * reports its share through setBackgroundUsageSource. Until a source is set,
 * `background` is null and everything counts as conversations; once it is,
 * conversations are the total less background work.
 */
import { getAllProviders } from '../../orchestrators/registry';
import { isSessionCapable } from '../../orchestrators/types';
import { appLog } from '../log-service';
import { buildSessionSummary, normalizeSessionEvents, SUMMARY_TRANSCRIPT_MAX_BYTES } from '../session-reader';
import { getDispatcherFolders } from './dispatcher-paths';
import {
  EMPTY_USAGE,
  USAGE_WINDOW_DAYS,
  type DispatcherUsage,
  type UsageTotals,
} from '../../../shared/dispatcher-settings-page';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A page open for a while reads again at most this often. */
const CACHE_MS = 60_000;
/** The most sessions read per folder and provider: the newest ones. */
const MAX_SESSIONS = 40;

/** One provider's sessions in one folder. */
export interface UsageSessionStore {
  listSessions(cwd: string): Promise<Array<{ sessionId: string; lastActiveAt: string }>>;
  readTotals(sessionId: string, cwd: string): Promise<Omit<UsageTotals, 'sessions'> | null>;
}

/** Background work's share since `since` (ms). Registered by the upkeep and check-in Actions (#3040). */
export type BackgroundUsageSource = (since: number) => Promise<UsageTotals>;

let backgroundSource: BackgroundUsageSource | null = null;
let cached: DispatcherUsage | null = null;

/** Register how background work's usage is read. Null takes it away (tests). */
export function setBackgroundUsageSource(source: BackgroundUsageSource | null): void {
  backgroundSource = source;
  cached = null;
}

function providerStores(): UsageSessionStore[] {
  const stores: UsageSessionStore[] = [];
  for (const provider of getAllProviders()) {
    if (!isSessionCapable(provider)) continue;
    stores.push({
      listSessions: (cwd) => provider.listSessions(cwd),
      readTotals: async (sessionId, cwd) => {
        const raw = await provider.readSessionTranscript(sessionId, cwd, { maxBytes: SUMMARY_TRANSCRIPT_MAX_BYTES });
        if (!raw) return null;
        const summary = buildSessionSummary(normalizeSessionEvents(raw), provider.id);
        return { inputTokens: summary.totalInputTokens, outputTokens: summary.totalOutputTokens };
      },
    });
  }
  return stores;
}

export interface UsageDeps {
  now?: () => number;
  folders?: () => readonly string[];
  stores?: () => UsageSessionStore[];
  background?: BackgroundUsageSource | null;
}

function add(a: UsageTotals, b: UsageTotals): UsageTotals {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, sessions: a.sessions + b.sessions };
}

function less(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    sessions: Math.max(0, a.sessions - b.sessions),
  };
}

/** Everything the Dispatcher's sessions used since `since`. A store or session that can't be read counts nothing. */
async function totalSince(since: number, folders: readonly string[], stores: UsageSessionStore[]): Promise<UsageTotals> {
  let total = EMPTY_USAGE;
  for (const cwd of folders) {
    for (const store of stores) {
      let sessions: Array<{ sessionId: string; lastActiveAt: string }>;
      try {
        sessions = await store.listSessions(cwd);
      } catch {
        // telemetry-exempt: this provider has nothing to read for this folder.
        continue;
      }
      const recent = sessions
        .map((s) => ({ ...s, at: Date.parse(s.lastActiveAt) }))
        .filter((s) => Number.isFinite(s.at) && s.at >= since)
        .sort((a, b) => b.at - a.at)
        .slice(0, MAX_SESSIONS);
      for (const session of recent) {
        try {
          const totals = await store.readTotals(session.sessionId, cwd);
          if (totals) total = add(total, { ...totals, sessions: 1 });
        } catch (err) {
          // telemetry-exempt: one unreadable transcript leaves the rest; logged.
          appLog('core:dispatcher', 'debug', 'Dispatcher usage: a transcript could not be read', {
            meta: { error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
    }
  }
  return total;
}

/** The Dispatcher's usage, read again at most once a minute. */
export async function readDispatcherUsage(deps: UsageDeps = {}): Promise<DispatcherUsage> {
  const now = (deps.now ?? Date.now)();
  const injected = deps.folders || deps.stores || deps.background !== undefined;
  if (!injected && cached && now - cached.readAt < CACHE_MS) return cached;

  const since = now - USAGE_WINDOW_DAYS * DAY_MS;
  const total = await totalSince(since, (deps.folders ?? getDispatcherFolders)(), (deps.stores ?? providerStores)());
  const source = deps.background === undefined ? backgroundSource : deps.background;
  let background: UsageTotals | null = null;
  if (source) {
    try {
      background = await source(since);
    } catch {
      // telemetry-exempt: shown as conversations only, as before background work reported its share.
      background = null;
    }
  }
  const usage: DispatcherUsage = {
    conversations: background ? less(total, background) : total,
    background,
    readAt: now,
  };
  if (!injected) cached = usage;
  return usage;
}

/** For tests. */
export function _resetDispatcherUsageForTesting(): void {
  backgroundSource = null;
  cached = null;
}
