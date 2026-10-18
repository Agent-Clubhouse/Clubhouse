/**
 * CLI version policy for chat drivers (docs/structured-chat-research.md §7.1,
 * §8 decision 6): fall back only on a real failure.
 *
 * - Below a driver's minimum version, or on the known-bad list: the agent
 *   opens in the next mode down.
 * - Newer than the newest version a driver was tested with: chat stays on and
 *   the app log records it. These CLIs release daily, so the chat view shows
 *   the note only next to a real problem (unrecognized messages, a fatal error).
 * - Unknown version (the CLI didn't report one): no verdict, chat stays on.
 *
 * The known-bad list is the remote kill switch: entries can arrive with the
 * update manifest (`chatCliDenylist`) and are persisted, so a bad CLI release
 * can be routed to the terminal without an app release.
 *
 * For manifest publishers:
 * - The manifest is trusted at the same level as the update payload it
 *   describes: fetched over HTTPS and unsigned (the payload's sha256 lives in
 *   the same manifest).
 * - Omitting `chatCliDenylist` keeps the saved list; only `[]` clears it.
 *   Anything that isn't an array is ignored.
 * - The stable and preview manifests are read separately; the one the update
 *   check picks (the newer of the two on the preview channel) is applied, so
 *   put an entry in both.
 * - Every `versions[]`, `range.from` and `range.to` must be a plain
 *   `x.y.z[-prerelease]` version. An entry with anything else is dropped
 *   whole, so a typo can't match every version.
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
  // Fixtures exist from 1.0.82, 1.0.92 and 1.0.98. The probe launches exactly
  // like a session (no --no-auto-update, #2154), so probe.cliVersion is the
  // version that actually runs: the user's installed Copilot, the same one
  // Terminal runs. Nothing older is known to break, so there is no floor.
  copilot_acp: { testedMax: '1.0.98' },
  // @github/copilot-sdk 1.0.22 pins Copilot CLI 1.0.98 (and checks its own
  // protocol version on connect).
  copilot_sdk: { testedMax: '1.0.98' },
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

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?/;
const EXACT_VERSION_RE = new RegExp(`^${VERSION_RE.source}$`);

/** Drop leading zeros so "02.1.0" and "2.1.0" match; keep the prerelease; drop build metadata. */
function normalize(m: RegExpExecArray): string {
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}${m[4] ? `-${m[4]}` : ''}`;
}

/**
 * First `x.y.z[-prerelease]` in a CLI's version text, e.g. "2.1.300 (Claude
 * Code)" → "2.1.300". Build metadata (`+…`) is dropped.
 */
export function parseCliVersion(raw: string | undefined): string | undefined {
  const m = raw ? VERSION_RE.exec(raw) : null;
  return m ? normalize(m) : undefined;
}

/** A value that is exactly one version (for denylist entries), normalized; undefined otherwise. */
export function parseExactVersion(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_VERSION_LENGTH) return undefined;
  const m = EXACT_VERSION_RE.exec(raw.trim());
  return m ? normalize(m) : undefined;
}

/** SemVer precedence: numeric core, a prerelease before its release, identifiers numeric where numeric. */
export function compareCliVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, ...rest] = v.split('+', 1)[0].split('-');
    return { nums: core.split('.').map((n) => Number(n) || 0), pre: rest.length ? rest.join('-').split('.') : undefined };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// ── Remote denylist (update manifest kill switch) ──────────────────────────

const remoteStore = createSettingsStore<{ entries: CliDenylistEntry[] }>('chat-cli-denylist.json', { entries: [] });

export const MAX_DENYLIST_ENTRIES = 100;
export const MAX_VERSIONS_PER_ENTRY = 200;
const MAX_VERSION_LENGTH = 64;
const MAX_ID_LENGTH = 64;
const MAX_REASON_LENGTH = 300;

const isShortString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** One entry, or undefined when any part is malformed: a bad entry is dropped whole, never widened. */
function sanitizeEntry(e: unknown): CliDenylistEntry | undefined {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return undefined;
  const r = e as Record<string, unknown>;
  if (!isShortString(r.reason, MAX_REASON_LENGTH)) return undefined;
  if (r.driver !== undefined && !isShortString(r.driver, MAX_ID_LENGTH)) return undefined;
  if (r.provider !== undefined && !isShortString(r.provider, MAX_ID_LENGTH)) return undefined;
  if (r.driver === undefined && r.provider === undefined) return undefined;

  let versions: string[] | undefined;
  if (r.versions !== undefined) {
    if (!Array.isArray(r.versions) || r.versions.length > MAX_VERSIONS_PER_ENTRY) return undefined;
    versions = [];
    for (const v of r.versions) {
      const parsed = parseExactVersion(v);
      if (!parsed) return undefined;
      versions.push(parsed);
    }
  }

  let range: CliDenylistEntry['range'];
  if (r.range !== undefined) {
    if (typeof r.range !== 'object' || r.range === null || Array.isArray(r.range)) return undefined;
    const raw = r.range as Record<string, unknown>;
    const from = raw.from === undefined ? undefined : parseExactVersion(raw.from);
    const to = raw.to === undefined ? undefined : parseExactVersion(raw.to);
    if ((raw.from !== undefined && !from) || (raw.to !== undefined && !to)) return undefined;
    // An open range on both ends would match every version.
    if (!from && !to) return undefined;
    range = { ...(from && { from }), ...(to && { to }) };
  }
  if (!versions?.length && !range) return undefined;

  return {
    ...(r.driver !== undefined && { driver: r.driver as ChatDriverId }),
    ...(r.provider !== undefined && { provider: r.provider as string }),
    ...(versions?.length && { versions }),
    ...(range && { range }),
    reason: r.reason,
  };
}

/** Keep only well-formed entries, up to the caps. Non-arrays yield []. */
export function sanitizeDenylist(raw: unknown): CliDenylistEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: CliDenylistEntry[] = [];
  for (const e of raw.slice(0, MAX_DENYLIST_ENTRIES)) {
    const entry = sanitizeEntry(e);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Replace the remote denylist with what the latest update manifest carries.
 * Only an array replaces it: a missing field, `null` or any other value
 * keeps the saved list, so a manifest without the field (or a broken one)
 * can't lift a block. Nothing is written when the list is unchanged.
 */
export async function applyRemoteCliDenylist(raw: unknown): Promise<void> {
  if (!Array.isArray(raw)) return;
  const entries = sanitizeDenylist(raw);
  if (JSON.stringify(entries) === JSON.stringify(remoteStore.get().entries)) return;
  await remoteStore.save({ entries });
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
  if (entry.versions?.some((v) => parseExactVersion(v) === version)) return true;
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
