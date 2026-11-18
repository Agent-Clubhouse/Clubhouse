import { describe, expect, it } from 'vitest';
import type { AnnexPeer } from '../../shared/types';
import { peerRoutes, routeAllowed, selectRequestRoute } from './annex-routes';

const LOCAL = 'local';
const REMOTE = 'remote';
const PIN = 'AA:BB';

function peer(overrides: Partial<AnnexPeer> = {}): AnnexPeer {
  return {
    fingerprint: REMOTE, publicKey: 'key', alias: 'Studio', icon: 'computer', color: 'indigo',
    role: 'member', kind: 'desktop', pairedAt: '2026-01-01', lastSeen: '2026-01-01',
    tlsCertificateFingerprint: PIN, ...overrides,
  };
}

describe('peer-bound desktop routes', () => {
  it('deterministically selects discovery, verified saved, announced and remembered routes with exact ports', () => {
    const routes = peerRoutes(peer({
      typedHost: 'localhost:7555', typedHostCert: PIN,
      announcedReach: { hosts: ['studio.local'], port: 9443 },
      sharedEndpoints: { 'studio.tailnet': 8443 },
      knownHosts: ['studio.local', '10.0.0.4'],
      hostPorts: { 'studio.local': 7443, '10.0.0.4': 9443 },
      mainPort: 9443,
    }), { localFingerprint: LOCAL, discovered: { fingerprint: REMOTE, host: '10.0.0.4', port: 9443 } });
    expect(routes).toEqual([
      { fingerprint: REMOTE, host: '10.0.0.4', port: 9443, source: 'discovered' },
      { fingerprint: REMOTE, host: 'localhost', port: 7555, source: 'typed', privateTo: LOCAL },
      { fingerprint: REMOTE, host: 'studio.local', port: 9443, source: 'announced' },
      { fingerprint: REMOTE, host: 'studio.tailnet', port: 8443, source: 'announced' },
      { fingerprint: REMOTE, host: 'studio.local', port: 7443, source: 'known' },
    ]);
  });

  it('keeps a private port distinct from the same host announced at its shared port', () => {
    const routes = peerRoutes(peer({
      typedHost: 'studio.local:7555', privateHosts: ['studio.local'],
      sharedEndpoints: { 'studio.local': 9443 },
    }), { localFingerprint: LOCAL });
    expect(routes.map((route) => [route.port, route.privateTo])).toEqual([[7555, LOCAL], [9443, undefined]]);
    expect(routes.filter((route) => routeAllowed(route, REMOTE, 'another-observer')).map((route) => route.port)).toEqual([9443]);
  });

  it('never borrows another peer discovery or any held routes', () => {
    expect(peerRoutes(peer({
      heldRoutes: { heldAt: '2026-01-01', typedHost: '127.0.0.1:7555', knownHosts: ['old.local'], hostPorts: { 'old.local': 9443 } },
    }), { localFingerprint: LOCAL, discovered: { fingerprint: 'someone-else', host: '127.0.0.1', port: 7666 } })).toEqual([]);
  });

  it('excludes a saved typed route bound to another pin but retains legacy pinned-handshake routes', () => {
    expect(peerRoutes(peer({ typedHost: 'localhost:7555', typedHostCert: 'OLD' }), { localFingerprint: LOCAL })).toEqual([]);
    expect(peerRoutes(peer({ typedHost: 'localhost:7555' }), { localFingerprint: LOCAL })).toMatchObject([
      { host: 'localhost', port: 7555, privateTo: LOCAL },
    ]);
  });

  it('never treats announced loopback or malformed endpoints as a usable route', () => {
    expect(peerRoutes(peer({
      announcedReach: { hosts: ['127.0.0.1', '::1', 'bad/host'], port: 9443 },
      sharedEndpoints: { 'localhost': 9443, 'valid.local': 65536 },
    }), { localFingerprint: LOCAL })).toEqual([]);
  });

  it('uses a saved IPv6 forward only for its intended peer and observer', () => {
    const [route] = peerRoutes(peer({ typedHost: '[::1]:7555' }), { localFingerprint: LOCAL });
    expect(route).toMatchObject({ host: '::1', port: 7555, privateTo: LOCAL });
    expect(routeAllowed(route, REMOTE, LOCAL)).toBe(true);
    expect(routeAllowed(route, 'someone-else', LOCAL)).toBe(false);
    expect(routeAllowed(route, REMOTE, 'another-observer')).toBe(false);
  });
});

describe('request transport selection', () => {
  const [direct] = peerRoutes(peer({ typedHost: 'localhost:7555' }), { localFingerprint: LOCAL });

  it('prefers the live direct route without selecting two transports', () => {
    expect(selectRequestRoute(REMOTE, LOCAL, { direct, reverse: true })).toEqual({ via: 'direct', route: direct });
  });

  it('uses an already-negotiated reverse connection without inventing a reverse dial', () => {
    expect(selectRequestRoute(REMOTE, LOCAL, { reverse: true })).toEqual({ via: 'reverse', fingerprint: REMOTE });
  });

  it('leaves old peers without the control capability on their existing direct route or offline', () => {
    expect(selectRequestRoute(REMOTE, LOCAL, { direct, reverse: false })).toEqual({ via: 'direct', route: direct });
    expect(selectRequestRoute(REMOTE, LOCAL, { reverse: false })).toBeNull();
  });

  it('rejects another destination or another observers private route', () => {
    expect(selectRequestRoute('someone-else', LOCAL, { direct, reverse: false })).toBeNull();
    expect(selectRequestRoute(REMOTE, 'another-observer', { direct, reverse: false })).toBeNull();
  });
});
