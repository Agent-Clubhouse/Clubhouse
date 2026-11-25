/**
 * Settings › Usage (shared/usage-summary.ts). Reads only the `core:usage`
 * lines of the local log folder, through the same aggregator as
 * scripts/usage-rollup.mjs, and each provider's plan limits through
 * provider-quota.ts (token-free, cached; nothing is read for a provider
 * whose limits can't be). Nothing here is exported or sent anywhere.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { PROVIDER_DESCRIPTORS } from '../../shared/providers/descriptors';
import { rollupUsage } from '../../shared/usage-rollup.mjs';
import type { UsageSummary, UsageSummaryDays, UsageSummaryProvider } from '../../shared/usage-summary';
import { getLogDir } from '../telemetry/local-control';
import { appLog } from './log-service';
import * as logSettings from './log-settings';
import { readProviderQuota } from './provider-quota';

const DAY_MS = 24 * 60 * 60_000;

/**
 * The parsed `core:usage` lines of the local log files; an unreadable line is
 * `null` (counted as malformed). With `since` (a UTC day), a file last written
 * before it is skipped unread, and a line stamped before it isn't parsed, so
 * the work follows the period asked for, not the size of the log folder.
 */
export async function readUsageRecords(dir: string, since?: string): Promise<unknown[]> {
  let names: string[];
  try {
    names = (await fs.promises.readdir(dir)).filter((n) => /^telemetry-.*\.jsonl$/.test(n)).sort();
  } catch (err) {
    // telemetry-exempt: no log folder yet is no usage lines
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') appLog('core:usage', 'warn', 'Could not list the log folder', { meta: { code: (err as NodeJS.ErrnoException).code ?? 'error' } });
    return [];
  }
  const sinceMs = since ? Date.parse(`${since}T00:00:00.000Z`) : NaN;
  const out: unknown[] = [];
  for (const name of names) {
    if (!Number.isNaN(sinceMs)) {
      try {
        if ((await fs.promises.stat(path.join(dir, name))).mtimeMs < sinceMs) continue;
      } catch {
        // telemetry-exempt: a file retention just removed; nothing to read
        continue;
      }
    }
    const lines = createInterface({ input: fs.createReadStream(path.join(dir, name), 'utf-8'), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes('"core:usage"')) continue;
        // The recorder writes `ts` first: a line from before the period isn't parsed at all.
        const day = /"ts":"(\d{4}-\d{2}-\d{2})/.exec(line)?.[1];
        if (since && day && day < since) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // telemetry-exempt: counted by the rollup as malformed
          out.push(null);
        }
      }
    } catch (err) {
      // telemetry-exempt: a file retention removed while it was read; the others still count
      appLog('core:usage', 'warn', 'Could not read a log file for usage', { meta: { code: (err as NodeJS.ErrnoException).code ?? 'error' } });
    }
  }
  return out;
}

export async function readUsageSummary(days: UsageSummaryDays, deps: { dir?: string; now?: number; readQuota?: typeof readProviderQuota; linesRecorded?: boolean } = {}): Promise<UsageSummary> {
  const now = deps.now ?? Date.now();
  const since = new Date(now - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const records = await readUsageRecords(deps.dir ?? getLogDir(), since);
  // One pass: by provider, and by role from the same pass.
  const byProvider = rollupUsage(records, { groupBy: ['provider'], alsoGroupBy: [['role']], since });
  const roleRows = byProvider.also[0] ?? [];
  const readQuota = deps.readQuota ?? readProviderQuota;
  const known = new Set<string>();
  const providers: UsageSummaryProvider[] = await Promise.all(Object.values(PROVIDER_DESCRIPTORS).map(async (d) => {
    known.add(d.id);
    const row = byProvider.rows.find((r) => r.provider === d.id);
    const quotaKind = d.helperRouting.quota;
    const quota = quotaKind === 'reader' ? await readQuota(d.id).catch((): undefined => undefined) : undefined;
    const { provider: _p, ...usage } = row ?? {};
    return { id: d.id, name: d.displayName, quotaKind, ...(quota && { quota }), ...(row && { usage: usage as UsageSummaryProvider['usage'] }) };
  }));
  const otherProviders = byProvider.rows.filter((r) => !known.has(r.provider ?? '')).map(({ provider, ...t }) => ({ provider: provider ?? 'unknown', ...t }));
  const roles = roleRows.map(({ role, ...t }) => ({ role: role ?? 'unknown', ...t }));
  let linesRecorded = deps.linesRecorded;
  if (linesRecorded === undefined) {
    try {
      const settings = logSettings.getSettings();
      linesRecorded = settings.enabled !== false && settings.namespaces?.['core:usage'] !== false && (!settings.minLogLevel || settings.minLogLevel === 'debug' || settings.minLogLevel === 'info');
    } catch {
      // telemetry-exempt: the page then says only that no lines were found
      linesRecorded = true;
    }
  }
  return { days, since, providers, roles, otherProviders, noLines: byProvider.noLines, linesRecorded };
}
