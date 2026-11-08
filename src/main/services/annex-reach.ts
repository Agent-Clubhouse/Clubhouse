/**
 * Where to reach a paired satellite (#3058). Direct connections only: every
 * address here is the satellite itself, over the LAN or a tailnet. Nothing is
 * relayed, and the pinned certificate decides whether an address is really it.
 */
import { isIP } from 'net';

export interface ReachAddress {
  host: string;
  port: number;
  /** Where it came from: announced by discovery, typed by the person, or remembered. */
  source?: 'discovered' | 'typed' | 'known';
}

/** How many reached or linked addresses a satellite's entry keeps. */
export const KNOWN_HOSTS_MAX = 6;

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;

/** A DNS name: dot-separated labels (a trailing dot is allowed), 253 characters at most. */
function isHostName(value: string): boolean {
  const name = value.endsWith('.') ? value.slice(0, -1) : value;
  if (!name || name.length > 253) return false;
  const labels = name.split('.');
  // All digits is an attempt at an IPv4 address (`192.168.1`, `999.1.1.1`): only a real one will do.
  if (labels.every((label) => /^\d+$/.test(label))) return false;
  return labels.every((label) => HOST_LABEL.test(label));
}

/**
 * Reads a host a person typed: a name (`studio`, `studio.local`,
 * `studio.tail1234.ts.net`), an IPv4 address, or an IPv6 address (bare or in
 * brackets), each with an optional port. Null for anything else, such as a URL.
 */
export function parseTypedHost(input: string): { host: string; port?: number } | null {
  const value = input.trim();
  // No URL parts, and no IPv6 zone (`%en0`), which a URL can't carry.
  if (!value || /[\s/@?#%]/.test(value)) return null;

  let host = value;
  let portText: string | undefined;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketed) {
    host = bracketed[1];
    portText = bracketed[2];
    if (isIP(host) !== 6) return null;
  } else if (isIP(value) === 6) {
    host = value;
  } else {
    const colon = value.lastIndexOf(':');
    if (colon !== -1) {
      host = value.slice(0, colon);
      portText = value.slice(colon + 1);
      if (!/^\d+$/.test(portText)) return null;
    }
    if (isIP(host) !== 4 && !isHostName(host)) return null;
  }

  if (portText === undefined) return { host: host.toLowerCase() };
  const port = Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: host.toLowerCase(), port };
}

/** The host as one line, as a person would type it back. */
export function formatAddress(address: ReachAddress): string {
  return `${isIP(address.host) === 6 ? `[${address.host}]` : address.host}:${address.port}`;
}

/** Lower is better; null for an address that can't reach another machine. */
function addressRank(address: string): number | null {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254)) return null;
    if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return 0;
    if (a === 100 && b >= 64 && b <= 127) return 1; // Tailscale / CGNAT
    return 2;
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    // Loopback, unspecified, multicast; and link-local, which needs an interface we don't get from mDNS.
    if (lower === '::1' || lower === '::' || lower.startsWith('ff') || /^fe[89ab]/.test(lower)) return null;
    if (/^f[cd]/.test(lower)) return 3; // unique local
    return 4; // global
  }
  return null;
}

/**
 * The addresses a Bonjour announcement gave, best first: private IPv4, then
 * tailnet, other IPv4, unique-local IPv6, then global IPv6. Loopback and
 * link-local are left out.
 */
export function rankAddresses(addresses: readonly string[]): string[] {
  const ranked: Array<{ address: string; rank: number; order: number }> = [];
  addresses.forEach((address, order) => {
    const rank = addressRank(address);
    if (rank !== null && !ranked.some((r) => r.address === address)) ranked.push({ address, rank, order });
  });
  return ranked.sort((x, y) => x.rank - y.rank || x.order - y.order).map((r) => r.address);
}

/**
 * Every address to try for a satellite, in order, with no repeats:
 * 1. what discovery announced just now (it's on this network now);
 * 2. what the person typed;
 * 3. where it was reached before, most recent first, and the hosts in its pairing link.
 * Entries without a port use `port`; with no port at all they're left out.
 */
export function reachCandidates(options: {
  discovered?: ReachAddress | null;
  typed?: string;
  known?: readonly string[];
  port?: number;
}): ReachAddress[] {
  const out: ReachAddress[] = [];
  const add = (host: string | undefined, port: number | undefined, source: ReachAddress['source']): void => {
    if (!host || !port || port <= 0) return;
    const h = host.toLowerCase();
    if (!out.some((a) => a.host === h && a.port === port)) out.push({ host: h, port, source });
  };
  if (options.discovered) add(options.discovered.host, options.discovered.port, 'discovered');
  if (options.typed) {
    const parsed = parseTypedHost(options.typed);
    if (parsed) add(parsed.host, parsed.port ?? options.port, 'typed');
  }
  for (const host of options.known ?? []) add(host, options.port, 'known');
  return out;
}

/**
 * This machine's hosts for its pairing link and phone routes, with the name the
 * person says it's also reachable as (such as its tailnet name) last. Left out
 * when the server is bound to one address, since it only answers there.
 */
export function withReachableAs(hosts: readonly string[], boundHost: string, reachableAs: string | undefined): string[] {
  const out = [...hosts];
  if (boundHost && boundHost !== '0.0.0.0') return out;
  const typed = parseTypedHost(reachableAs ?? '');
  if (typed && !out.includes(typed.host)) out.push(typed.host);
  return out;
}

/** `known` with `host` moved to the front, capped at KNOWN_HOSTS_MAX. */
export function rememberHost(known: readonly string[] | undefined, host: string): string[] {
  const h = host.toLowerCase();
  return [h, ...(known ?? []).filter((k) => k.toLowerCase() !== h)].slice(0, KNOWN_HOSTS_MAX);
}
