/**
 * Defensive parsing of `<root>/scheduler/api.address` (spec §4.3).
 *
 * The daemon writes this file live at readiness and deletes it at clean
 * shutdown, so a read can legitimately catch it empty or partially written.
 * That is a race, not "daemon not running" — retry a few times over ~1s
 * before concluding anything (flapping the UI between states on this race
 * is the specific bug reviewers are told to look for).
 *
 * Scope note: §7.4 step 1 treats an *absent* address file as "not running,
 * done" — no fallback probe. The §4.3 resolution order's `api.listen` /
 * default-port fallback is therefore not used to decide liveness here (that
 * would reintroduce "probing 8080 without the address file", an explicit
 * anti-pattern in §7.4). It's implemented anyway (`resolveConfiguredAddress`)
 * for display/diagnostic use — e.g. showing what address a daemon would use
 * if started — but the liveness probe only ever trusts the address file.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ParsedAddress {
  host: string;
  port: number;
}

export type AddressFileResult =
  | { ok: true; address: ParsedAddress }
  | { ok: false; error: { code: string; message: string } };

const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse `host:port`, bracketed IPv6 (`[::1]:8080`), or a bare `:port`. */
export function parseAddressString(raw: string): ParsedAddress | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let host: string;
  let portStr: string;

  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    if (closeIdx === -1) return null;
    host = trimmed.slice(1, closeIdx);
    const rest = trimmed.slice(closeIdx + 1);
    if (!rest.startsWith(':')) return null;
    portStr = rest.slice(1);
  } else {
    const idx = trimmed.lastIndexOf(':');
    if (idx === -1) return null;
    host = trimmed.slice(0, idx);
    portStr = trimmed.slice(idx + 1);
  }

  if (!/^\d+$/.test(portStr)) return null;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  // Bare `:port` ⇒ wildcard bind, normalized below.
  if (host === '') host = '0.0.0.0';

  return { host, port };
}

/** Normalize a wildcard bind for the *client* — we're connecting, not binding. */
export function normalizeHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::' || host === '[::]') return '::1';
  return host;
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.startsWith('127.');
}

async function statAddressFile(addressPath: string): Promise<boolean> {
  try {
    await fs.promises.stat(addressPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read + parse the address file, retrying empty/partial/transiently-missing
 * reads over ~1s. Returns null if it never becomes readable/parseable.
 */
async function readAddressWithRetry(addressPath: string): Promise<ParsedAddress | null> {
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      const raw = await fs.promises.readFile(addressPath, 'utf-8');
      const parsed = parseAddressString(raw);
      if (parsed) return parsed;
    } catch {
      // Deleted mid-read (daemon shutting down) or transiently unreadable —
      // treat the same as an empty/partial write and keep retrying.
    }
    if (attempt < RETRY_ATTEMPTS - 1) await sleep(RETRY_DELAY_MS);
  }
  return null;
}

/**
 * The liveness-relevant address resolution (§7.4 step 1/2): absent file ⇒
 * not-running (`absent`), present-but-never-parseable after retries ⇒
 * `pending` (still starting up, not a failure), non-loopback parsed host ⇒
 * hard error, otherwise a usable address.
 */
export async function resolveLivenessAddress(root: string): Promise<
  | { status: 'absent' }
  | { status: 'pending' }
  | { status: 'non-loopback'; host: string }
  | { status: 'ok'; address: ParsedAddress }
> {
  const addressPath = path.join(root, 'scheduler', 'api.address');
  const exists = await statAddressFile(addressPath);
  if (!exists) return { status: 'absent' };

  const parsed = await readAddressWithRetry(addressPath);
  if (!parsed) return { status: 'pending' };

  const normalizedHost = normalizeHost(parsed.host);
  if (!isLoopbackHost(normalizedHost)) {
    return { status: 'non-loopback', host: normalizedHost };
  }
  return { status: 'ok', address: { host: normalizedHost, port: parsed.port } };
}

/**
 * Display-only "what address would a daemon here use" resolution (§4.3's
 * full order). Not used by the liveness probe — see the module doc comment.
 */
export async function resolveConfiguredAddress(root: string, instanceYamlListen: string | null): Promise<ParsedAddress> {
  const liveness = await resolveLivenessAddress(root);
  if (liveness.status === 'ok') return liveness.address;

  if (instanceYamlListen) {
    const parsed = parseAddressString(instanceYamlListen);
    if (parsed) return { host: normalizeHost(parsed.host), port: parsed.port };
  }

  return { host: '127.0.0.1', port: 8080 };
}
