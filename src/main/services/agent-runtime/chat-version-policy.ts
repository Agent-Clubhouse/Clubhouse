/**
 * CLI version policy for chat drivers (docs/structured-chat-research.md §7.1,
 * §8 decision 6): fall back only on a real failure.
 *
 * - Below a driver's minimum version, or on the known-bad list: the agent
 *   opens in the next mode down.
 * - Newer than the newest version a driver was tested with: chat stays on and
 *   the transcript gets a quiet "untested version" note, because these CLIs
 *   release daily.
 * - Unknown version (the CLI didn't report one): no verdict, chat stays on.
 *
 * The known-bad list is the remote kill switch: entries can arrive with the
 * update manifest (`chatCliDenylist`) and are persisted, so a bad CLI release
 * can be routed to the terminal without an app release.
 */

import type { ChatDriverId } from '../../../shared/chat';
import { createSettingsStore } from '../settings-store';

export interface CliVersionRange {
  /** Oldest version the driver works with. Unset when no hard floor is known. */
  minVersion?: string;
  /** Newest version the driver was tested with. Newer versions get a note, not a fallback. */
  testedMax?: string;
}

export interface CliDenylistEntry {
  /** Match one driver; or omit it and match every driver of `provider`. */
  driver?: ChatDriverId;
  provider?: string;
  /** Exact versions. */
  versions?: string[];
  /** Inclusive range, either end optional. */
  range?: { from?: string; to?: string };
  /** Shown to the user. */
  reason: string;
}

/**
 * Versions each driver was built and tested against. Bump `testedMax` with
 * each pinned CLI or SDK bump; set `minVersion` only when a driver needs a
 * protocol feature that older CLIs lack.
 */
export const TESTED_CLI_VERSIONS: Readonly<Partial<Record<ChatDriverId, CliVersionRange>>> = {
  // Agent SDK 0.3.301 ships with (and is tested against) Claude Code 2.1.301.
  claude_agent_sdk: { testedMax: '2.1.301' },
  claude_stream_json: { testedMax: '2.1.301' },
  // Generated bindings are pinned at 0.153.4; the research probed 0.159.3.
  codex_app_server: { testedMax: '0.159.3' },
  copilot_acp: { testedMax: '1.0.92' },
};

/** Known-bad versions shipped with the app. The update manifest can add more. */
export const BUILTIN_CLI_DENYLIST: readonly CliDenylistEntry[] = [];

const PROVIDER_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex',
  'copilot-cli': 'Copilot CLI',
};

export function cliLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** First `x.y.z` (with an optional prerelease tag) in a CLI's version text, e.g. "2.1.300 (Claude Code)". */
export function parseCliVersion(raw: string | undefined): string | undefined {
  return raw ? /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(raw)?.[1] : undefined;
}

/** Numeric x.y.z comparison; a prerelease sorts before its release. */
export function compareCliVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.split('-', 2);
    return { nums: core.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// ── Remote denylist (update manifest kill switch) ──────────────────────────

const remoteStore = createSettingsStore<{ entries: CliDenylistEntry[] }>('chat-cli-denylist.json', { entries: [] });

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

/** Keep only well-formed entries; a malformed manifest must not disable the list. */
export function sanitizeDenylist(raw: unknown): CliDenylistEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CliDenylistEntry[] = [];
  for (const e of raw) {
    if (typeof e !== 'object' || e === null) continue;
    const r = e as Record<string, unknown>;
    if (typeof r.reason !== 'string' || !r.reason) continue;
    if (r.driver !== undefined && typeof r.driver !== 'string') continue;
    if (r.provider !== undefined && typeof r.provider !== 'string') continue;
    if (r.driver === undefined && r.provider === undefined) continue;
    const versions = isStringArray(r.versions) ? r.versions : undefined;
    const rangeRaw = typeof r.range === 'object' && r.range !== null ? r.range as Record<string, unknown> : undefined;
    const range = rangeRaw && (typeof rangeRaw.from === 'string' || typeof rangeRaw.to === 'string')
      ? { ...(typeof rangeRaw.from === 'string' && { from: rangeRaw.from }), ...(typeof rangeRaw.to === 'string' && { to: rangeRaw.to }) }
      : undefined;
    if (!versions?.length && !range) continue;
    out.push({
      ...(r.driver !== undefined && { driver: r.driver as ChatDriverId }),
      ...(r.provider !== undefined && { provider: r.provider as string }),
      ...(versions?.length && { versions }),
      ...(range && { range }),
      reason: r.reason,
    });
  }
  return out;
}

/**
 * Replace the remote denylist with what the latest update manifest carries.
 * A manifest without the field leaves the saved list alone (older manifests).
 */
export async function applyRemoteCliDenylist(raw: unknown): Promise<void> {
  if (raw === undefined) return;
  await remoteStore.save({ entries: sanitizeDenylist(raw) });
}

export function getCliDenylist(): CliDenylistEntry[] {
  return [...BUILTIN_CLI_DENYLIST, ...sanitizeDenylist(remoteStore.get().entries)];
}

// ── Verdict ─────────────────────────────────────────────────────────────────

export type CliVersionStatus = 'ok' | 'untested' | 'below_min' | 'known_bad' | 'unknown';

export interface CliVersionVerdict {
  status: CliVersionStatus;
  version?: string;
  /** User-facing explanation for anything but 'ok' and 'unknown'. */
  message?: string;
}

export interface CliVersionPolicy {
  tested: Readonly<Partial<Record<ChatDriverId, CliVersionRange>>>;
  denylist: readonly CliDenylistEntry[];
}

function denylistMatch(entry: CliDenylistEntry, driver: ChatDriverId, provider: string, version: string): boolean {
  if (entry.driver !== undefined && entry.driver !== driver) return false;
  if (entry.driver === undefined && entry.provider !== provider) return false;
  if (entry.versions?.some((v) => parseCliVersion(v) === version)) return true;
  if (entry.range) {
    const { from, to } = entry.range;
    return (!from || compareCliVersions(version, from) >= 0) && (!to || compareCliVersions(version, to) <= 0);
  }
  return false;
}

export function evaluateCliVersion(
  driver: ChatDriverId,
  provider: string,
  rawVersion: string | undefined,
  policy: CliVersionPolicy = { tested: TESTED_CLI_VERSIONS, denylist: getCliDenylist() },
): CliVersionVerdict {
  const version = parseCliVersion(rawVersion);
  if (!version) return { status: 'unknown' };
  const label = cliLabel(provider);
  const bad = policy.denylist.find((e) => denylistMatch(e, driver, provider, version));
  if (bad) return { status: 'known_bad', version, message: `${label} ${version} is known to break chat: ${bad.reason}` };
  const range = policy.tested[driver] ?? {};
  if (range.minVersion && compareCliVersions(version, range.minVersion) < 0) {
    return { status: 'below_min', version, message: `${label} ${version} is older than chat supports (${range.minVersion} or newer). Update it to use chat.` };
  }
  if (range.testedMax && compareCliVersions(version, range.testedMax) > 0) {
    return { status: 'untested', version, message: `${label} ${version} is newer than the version chat was tested with (${range.testedMax}).` };
  }
  return { status: 'ok', version };
}
