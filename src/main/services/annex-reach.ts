/**
 * Where to reach a paired satellite (#3058). Direct connections only: every
 * address reaches the satellite, over the LAN, a tailnet or a user-managed
 * byte-transparent forward. The pinned certificate decides whether it is really it.
 */
import { isIP } from 'net';
import { isAnnexLoopback } from '../../shared/annex-problems';

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
 * Each known host uses its own port. Direct hosts also try the legacy `port`
 * afterward, in case an older build updated it. Loopback remaps never do.
 * With no port at all they're left out.
 */
export function reachCandidates(options: {
  discovered?: ReachAddress | null;
  typed?: string;
  known?: readonly string[];
  ports?: Readonly<Record<string, number>>;
  port?: number;
}): ReachAddress[] {
  const out: ReachAddress[] = [];
  const knownPort = (host: string): number | undefined =>
    options.ports && Object.prototype.hasOwnProperty.call(options.ports, host) ? options.ports[host] : options.port;
  const add = (host: string | undefined, port: number | undefined, source: ReachAddress['source']): void => {
    if (!host || !port || port <= 0) return;
    const h = host.toLowerCase();
    if (!out.some((a) => a.host === h && a.port === port)) out.push({ host: h, port, source });
  };
  if (options.discovered) add(options.discovered.host, options.discovered.port, 'discovered');
  if (options.typed) {
    const parsed = parseTypedHost(options.typed);
    if (parsed) add(parsed.host, parsed.port ?? knownPort(parsed.host), 'typed');
  }
  for (const host of options.known ?? []) {
    add(host, knownPort(host.toLowerCase()), 'known');
    if (!isAnnexLoopback(host)) add(host, options.port, 'known');
  }
  return out;
}

/** Give legacy hosts their original default before another address or announcement changes it. */
export function hostPortsWithFallback(
  known: readonly string[] | undefined,
  port: number | undefined,
  ports: Readonly<Record<string, number>> | undefined,
): Record<string, number> {
  return Object.fromEntries([
    ...(port ? (known ?? []).map((host) => [host.toLowerCase(), port] as const) : []),
    ...Object.entries(ports ?? {}),
  ]);
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

type RouteProvenance = { privateHosts?: readonly string[]; sharedEndpoints?: Readonly<Record<string, number>> };

/** The port the device itself gave with `host` (#3608), if it gave one. */
export function sharedPortOf(peer: RouteProvenance | undefined, host: string): number | undefined {
  if (isAnnexLoopback(host)) return undefined;
  const ports = peer?.sharedEndpoints;
  const h = host.toLowerCase();
  return ports && Object.prototype.hasOwnProperty.call(ports, h) ? ports[h] : undefined;
}

/**
 * Whether `host` (at `port`, when given) is one this machine saved for itself (#3608),
 * never sent to other members:
 * - loopback, always (only the device's own announcement can vouch for loopback);
 * - one in `privateHosts` (a typed address, or one used to pair without a link or with
 *   an override), unless the device itself gave that host at that port (`sharedEndpoints`).
 *   Without a port, a private host counts as private.
 */
export function isPrivateHost(peer: RouteProvenance | undefined, host: string, port?: number): boolean {
  if (isAnnexLoopback(host)) return true;
  const h = host.toLowerCase();
  if (!peer?.privateHosts?.some((p) => p.toLowerCase() === h)) return false;
  return port === undefined || sharedPortOf(peer, h) !== port;
}

/**
 * What a member record may share for a peer (#3608): each known host at the port it can be
 * shared with, never a route this machine saved for itself. A host the device gave keeps the
 * port it gave, even when this machine also reaches it at a private port.
 */
export function shareableEndpoints(peer: RouteProvenance & {
  knownHosts?: readonly string[]; hostPorts?: Readonly<Record<string, number>>; mainPort?: number;
}): ReachAddress[] {
  const ports = hostPortsWithFallback(peer.knownHosts, peer.mainPort, peer.hostPorts);
  const out: ReachAddress[] = [];
  for (const host of peer.knownHosts ?? []) {
    const h = host.toLowerCase();
    if (isAnnexLoopback(h)) continue;
    const given = sharedPortOf(peer, h);
    const port = given ?? (isPrivateHost(peer, h) ? undefined : ports[h]);
    if (port && !out.some((a) => a.host === h)) out.push({ host: h, port });
  }
  return out;
}

/** `hosts` with `host` added once, lowercase. */
export function withPrivateHost(hosts: readonly string[] | undefined, host: string): string[] {
  const h = host.toLowerCase();
  return (hosts ?? []).some((k) => k.toLowerCase() === h) ? [...(hosts ?? [])] : [...(hosts ?? []), h];
}

/** The loopback endpoints a peer record holds for this machine: its typed address and loopback known hosts. */
export function savedLoopbackRoutes(peer: {
  typedHost?: string; knownHosts?: readonly string[]; hostPorts?: Readonly<Record<string, number>>; mainPort?: number;
}): ReachAddress[] {
  const out: ReachAddress[] = [];
  const typed = peer.typedHost ? parseTypedHost(peer.typedHost) : null;
  const typedPort = typed && (typed.port ?? peer.hostPorts?.[typed.host] ?? peer.mainPort);
  if (typed && typedPort && isAnnexLoopback(typed.host)) out.push({ host: typed.host, port: typedPort, source: 'typed' });
  for (const host of peer.knownHosts ?? []) {
    const port = peer.hostPorts?.[host.toLowerCase()];
    if (port && isAnnexLoopback(host) && !out.some((a) => a.port === port)) out.push({ host: host.toLowerCase(), port, source: 'known' });
  }
  return out;
}

export type RouteCollision =
  | { kind: 'own-listener'; port: number }
  | { kind: 'other-forward'; port: number; alias: string };

/**
 * Whether a loopback route would reach something other than the device it's for
 * (#3608): this machine's own Annex listener, or a forward already saved for
 * another device. Any loopback address counts as the same one, since a forward
 * and a listener on one port usually share it. Read-only: it never touches a listener.
 */
export function routeCollision(
  target: { host: string; port: number },
  own: { mainPort?: number; pairingPort?: number },
  others: ReadonlyArray<{ alias: string; routes: readonly ReachAddress[] }>,
): RouteCollision | null {
  if (!isAnnexLoopback(target.host)) return null;
  if (target.port === own.mainPort || target.port === own.pairingPort) return { kind: 'own-listener', port: target.port };
  for (const other of others) {
    if (other.routes.some((r) => r.port === target.port)) return { kind: 'other-forward', port: target.port, alias: other.alias };
  }
  return null;
}
