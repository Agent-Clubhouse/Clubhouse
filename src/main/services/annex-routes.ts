/** Desktop-local routes. A private forward belongs to its observer, not to the network. */
import type { AnnexPeer } from '../../shared/types';
import { isAnnexLoopback } from '../../shared/annex-problems';
import {
  isPrivateHost, parseTypedHost, reachCandidates, sharedPortOf,
  type ReachAddress,
} from './annex-reach';

export interface AnnexRoute extends Omit<ReachAddress, 'source'> {
  fingerprint: string;
  source: 'discovered' | 'typed' | 'announced' | 'known';
  /** Only this machine may dial a route it saved for itself. Never sent on the wire. */
  privateTo?: string;
}

export interface DiscoveredPeerRoute extends ReachAddress {
  fingerprint: string;
}

export function routeAllowed(route: AnnexRoute, fingerprint: string, localFingerprint: string): boolean {
  return route.fingerprint === fingerprint && (route.privateTo === undefined || route.privateTo === localFingerprint);
}

/** Discovery, a saved address, announcements, then remembered endpoints; no held routes. */
export function peerRoutes(peer: AnnexPeer, options: {
  localFingerprint: string;
  discovered?: DiscoveredPeerRoute | null;
}): AnnexRoute[] {
  const out: AnnexRoute[] = [];
  const add = (address: ReachAddress, source: AnnexRoute['source'], shared = false): void => {
    const parsed = parseTypedHost(address.host);
    if (!parsed || parsed.port !== undefined || !Number.isInteger(address.port) || address.port < 1 || address.port > 65535) return;
    const host = parsed.host;
    if (shared && isAnnexLoopback(host)) return;
    if (out.some((route) => route.host === host && route.port === address.port)) return;
    const privateRoute = !shared && (isPrivateHost(peer, host, address.port)
      || source === 'typed' && sharedPortOf(peer, host) !== address.port);
    out.push({
      fingerprint: peer.fingerprint, host, port: address.port, source,
      ...(privateRoute && { privateTo: options.localFingerprint }),
    });
  };
  const discovered = options.discovered?.fingerprint === peer.fingerprint ? options.discovered : undefined;
  const typed = !peer.typedHostCert || peer.typedHostCert === peer.tlsCertificateFingerprint ? peer.typedHost : undefined;
  for (const address of reachCandidates({ discovered, typed, ports: peer.hostPorts, port: peer.mainPort })) {
    add(address, address.source === 'discovered' ? 'discovered' : 'typed');
  }
  if (peer.announcedReach?.port) {
    for (const host of peer.announcedReach.hosts) add({ host, port: peer.announcedReach.port }, 'announced', true);
  }
  for (const [host, port] of Object.entries(peer.sharedEndpoints ?? {})) add({ host, port }, 'announced', true);
  for (const address of reachCandidates({ known: peer.knownHosts, ports: peer.hostPorts, port: peer.mainPort })) {
    add(address, 'known');
  }
  return out;
}

export type AnnexRequestRoute =
  | { via: 'direct'; route: AnnexRoute }
  | { via: 'reverse'; fingerprint: string };

/** Choose once, before sending. `direct` is a live connection, `reverse` a negotiated control link. */
export function selectRequestRoute(fingerprint: string, localFingerprint: string, available: {
  direct?: AnnexRoute | null;
  reverse: boolean;
}): AnnexRequestRoute | null {
  if (available.direct && routeAllowed(available.direct, fingerprint, localFingerprint)) return { via: 'direct', route: available.direct };
  return available.reverse ? { via: 'reverse', fingerprint } : null;
}
