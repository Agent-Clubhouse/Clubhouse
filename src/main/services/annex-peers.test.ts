import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { syncBuiltinESMExports } from 'module';
import * as path from 'path';
import * as os from 'os';
import type { AnnexPeer } from '../../shared/types';

vi.mock('electron', () => {
  let userDataPath = '';
  return {
    app: {
      getPath: (name: string) => {
        if (name === 'userData') return userDataPath;
        return '';
      },
      __setUserDataPath: (p: string) => { userDataPath = p; },
    },
  };
});

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import {
  listPeers, getPeer, peekPeerAlias, isPairedPeer, addPeer, removePeer, removeAllPeers,
  updateLastSeen, checkBruteForce, recordFailedAttempt, recordSuccessfulAttempt, forgiveFailedAttempt,
  unlockPairing, isPairingLocked, resetForTests, peerNeedsPairing, listPeersForDisplay,
  noteReached, setTypedHost, recordLastSeen, controlsThisMachine,
  trustOf, commitVerifiedRoute, withSavedRoutes,
} from './annex-peers';
import { app } from 'electron';
import { isPrivateHost, reachCandidates } from './annex-reach';

it('does not authorize an introduced desktop for control until reciprocal membership is confirmed', () => {
  expect(controlsThisMachine({ role: 'member', networkPending: true })).toBe(false);
  expect(controlsThisMachine({ role: 'member' })).toBe(true);
});

function makePeer(fingerprint: string, alias = 'Test'): AnnexPeer {
  return {
    fingerprint,
    publicKey: `pubkey-${fingerprint}`,
    alias,
    icon: 'computer',
    color: 'indigo',
    pairedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };
}

describe('annex-peers', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'annex-peers-test-'));
    (app as any).__setUserDataPath(tmpDir);
    resetForTests();
  });
  it('peeks aliases without loading credentials and retains only unambiguous cached metadata', () => {
    const file = path.join(tmpDir, 'annex-peers.json'); fs.writeFileSync(file, JSON.stringify([makePeer('aa:bb', 'Retained alias')]));
    const original = fs.readFileSync; const reads = vi.fn(original);
    fs.readFileSync = reads as typeof fs.readFileSync; syncBuiltinESMExports();
    try {
      expect.soft(peekPeerAlias('aa:bb')).toBeUndefined(); expect.soft(reads).not.toHaveBeenCalled();
      expect(getPeer('aa:bb')?.alias).toBe('Retained alias'); expect(reads).toHaveBeenCalledTimes(1); reads.mockClear();
      fs.writeFileSync(file, 'broken current credentials');
      expect(peekPeerAlias('AA:BB')).toBe('Retained alias'); expect.soft(reads).not.toHaveBeenCalled(); expect(fs.readFileSync(file, 'utf8')).toBe('broken current credentials');
      resetForTests(); reads.mockClear(); expect.soft(peekPeerAlias('aa:bb')).toBeUndefined(); expect.soft(reads).not.toHaveBeenCalled();
      fs.writeFileSync(file, JSON.stringify([makePeer('aa:bb', 'First'), makePeer('AA:BB', 'Other')])); getPeer('aa:bb');
      expect(peekPeerAlias('aa:bb')).toBeUndefined();
    } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
  });


  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('CRUD', () => {
    it('should start with empty peer list', () => {
      expect(listPeers()).toEqual([]);
    });

    it('should add and retrieve a peer', () => {
      const peer = makePeer('aa:bb:cc');
      addPeer(peer);
      expect(listPeers()).toHaveLength(1);
      expect(getPeer('aa:bb:cc')).toEqual(peer);
      expect(isPairedPeer('aa:bb:cc')).toBe(true);
    });

    it('should update existing peer on add', () => {
      addPeer(makePeer('aa:bb:cc', 'First'));
      addPeer(makePeer('aa:bb:cc', 'Updated'));
      expect(listPeers()).toHaveLength(1);
      expect(getPeer('aa:bb:cc')!.alias).toBe('Updated');
    });

    it('should remove a peer', () => {
      addPeer(makePeer('aa:bb:cc'));
      expect(removePeer('aa:bb:cc')).toBe(true);
      expect(listPeers()).toHaveLength(0);
      expect(removePeer('aa:bb:cc')).toBe(false);
    });

    it('should remove all peers', () => {
      addPeer(makePeer('aa:bb:cc'));
      addPeer(makePeer('dd:ee:ff'));
      removeAllPeers();
      expect(listPeers()).toHaveLength(0);
    });

    it('should update lastSeen', () => {
      const peer = makePeer('aa:bb:cc');
      addPeer(peer);
      const before = getPeer('aa:bb:cc')!.lastSeen;
      // Wait a tiny bit for timestamp to change
      updateLastSeen('aa:bb:cc');
      const after = getPeer('aa:bb:cc')!.lastSeen;
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    });

    it('records a confirmed contact time only when it is newer, matching the fingerprint case-insensitively (#3349)', () => {
      addPeer({ ...makePeer('AA:BB:CC'), lastSeen: '2026-11-13T10:00:00.000Z' });
      recordLastSeen('aa:bb:cc', new Date('2026-11-13T11:30:00.000Z'));
      expect(getPeer('AA:BB:CC')!.lastSeen).toBe('2026-11-13T11:30:00.000Z');
      recordLastSeen('AA:BB:CC', new Date('2026-11-13T09:00:00.000Z'));
      expect(getPeer('AA:BB:CC')!.lastSeen).toBe('2026-11-13T11:30:00.000Z');
      resetForTests();
      expect(getPeer('AA:BB:CC')!.lastSeen).toBe('2026-11-13T11:30:00.000Z');
    });

    it('should persist to disk and survive cache reset', () => {
      addPeer(makePeer('aa:bb:cc'));
      resetForTests();
      expect(listPeers()).toHaveLength(1);
      expect(getPeer('aa:bb:cc')).toBeTruthy();
    });
  });

  describe('saved routes (#3608)', () => {
    const member = (overrides: Partial<AnnexPeer> = {}): AnnexPeer => ({
      ...makePeer('aa:bb:cc', 'Studio'), role: 'member', kind: 'desktop', pairingId: 'pairing-1',
      tlsCertificateFingerprint: 'CERT-1', tlsCertificatePem: 'PEM-1', knownHosts: ['192.168.1.5'], mainPort: 9443, ...overrides,
    });

    it('saves a checked route only when identity, pin and pairing are unchanged', () => {
      addPeer(member({ typedHost: '127.0.0.1:7443', typedHostCert: 'CERT-1' }));
      const trust = trustOf(getPeer('aa:bb:cc')!);
      // The pin changed between the check and the save: nothing is written, the old route stays.
      addPeer({ ...getPeer('aa:bb:cc')!, tlsCertificateFingerprint: 'CERT-2', tlsCertificatePem: 'PEM-2' });
      expect(commitVerifiedRoute('aa:bb:cc', trust, '127.0.0.1:7555', '127.0.0.1')).toBe(false);
      expect(getPeer('aa:bb:cc')).toMatchObject({ typedHost: '127.0.0.1:7443', typedHostCert: 'CERT-1' });
    });

    it('rejects a stale save after pairing again, being removed, or a pending join', () => {
      addPeer(member());
      const trust = trustOf(getPeer('aa:bb:cc')!);
      addPeer({ ...getPeer('aa:bb:cc')!, pairingId: 'pairing-2' });
      expect(commitVerifiedRoute('aa:bb:cc', trust, 'studio.ts.net', 'studio.ts.net')).toBe(false);
      addPeer(member({ networkPending: true }));
      expect(commitVerifiedRoute('aa:bb:cc', trust, 'studio.ts.net', 'studio.ts.net')).toBe(false);
      removePeer('aa:bb:cc');
      expect(commitVerifiedRoute('aa:bb:cc', trust, 'studio.ts.net', 'studio.ts.net')).toBe(false);
    });

    it('saves a current check, records the certificate it was checked against, and keeps the host private', () => {
      addPeer(member());
      expect(commitVerifiedRoute('aa:bb:cc', trustOf(getPeer('aa:bb:cc')!), '10.20.0.5:7443', '10.20.0.5')).toBe(true);
      resetForTests();
      expect(getPeer('aa:bb:cc')).toMatchObject({ typedHost: '10.20.0.5:7443', typedHostCert: 'CERT-1', privateHosts: ['10.20.0.5'] });
      // Cleared, the address is forgotten but stays private: it was never the device's own.
      setTypedHost('aa:bb:cc', undefined);
      expect(getPeer('aa:bb:cc')!.typedHost).toBeUndefined();
      expect(getPeer('aa:bb:cc')!.privateHosts).toEqual(['10.20.0.5']);
    });

    it('treats a typed host saved by an older build as private', () => {
      fs.writeFileSync(path.join(tmpDir, 'annex-peers.json'), JSON.stringify([member({ typedHost: 'Studio.ts.net:7000' })]));
      expect(getPeer('aa:bb:cc')!.privateHosts).toEqual(['studio.ts.net']);
    });

    it.each(['member', 'satellite'] as const)('migrates an existing %s route without repair, then forgets it durably', (role) => {
      const legacy = member({
        role, pairedAt: '2026-11-01T09:00:00.000Z', lastSeen: '2026-11-02T09:00:00.000Z',
        typedHost: 'Studio.ts.net:7555', knownHosts: ['192.168.1.5'],
      });
      const target = path.join(tmpDir, 'annex-peers.json');
      const original = JSON.stringify([legacy]);
      fs.writeFileSync(target, original);
      const loaded = getPeer(legacy.fingerprint)!;
      expect(trustOf(loaded)).toEqual(trustOf(legacy));
      expect(peerNeedsPairing(loaded)).toBe(false);
      expect(loaded.typedHostCert).toBeUndefined(); // Migration does not fabricate verification.
      expect(loaded.heldRoutes).toBeUndefined();
      expect(loaded.privateHosts).toEqual(['studio.ts.net']);
      expect(reachCandidates({ typed: loaded.typedHost, known: loaded.knownHosts, ports: loaded.hostPorts, port: loaded.mainPort }))
        .toContainEqual({ host: 'studio.ts.net', port: 7555, source: 'typed' });
      expect(fs.readFileSync(target, 'utf8')).toBe(original); // An offline read writes nothing.

      // An ordinary later save persists provenance without replacing the pairing or the old route.
      recordLastSeen(legacy.fingerprint, new Date('2026-11-03T09:00:00.000Z'));
      resetForTests();
      expect(getPeer(legacy.fingerprint)).toMatchObject({
        ...legacy, lastSeen: '2026-11-03T09:00:00.000Z', privateHosts: ['studio.ts.net'],
        hostPorts: { '192.168.1.5': 9443 },
      });
      expect(trustOf(getPeer(legacy.fingerprint)!)).toEqual(trustOf(legacy));

      const checkedBeforeForget = trustOf(loaded);
      expect(removePeer(legacy.fingerprint)).toBe(true);
      expect(commitVerifiedRoute(legacy.fingerprint, checkedBeforeForget, '127.0.0.1:7555', '127.0.0.1')).toBe(false);
      resetForTests();
      expect(listPeers()).toEqual([]);
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual([]);
    });

    it('does not turn an unpinned legacy route into a trusted pairing during migration', () => {
      const legacy = member({ tlsCertificateFingerprint: undefined, typedHost: '127.0.0.1:7555' });
      fs.writeFileSync(path.join(tmpDir, 'annex-peers.json'), JSON.stringify([legacy]));
      expect(getPeer(legacy.fingerprint)).toMatchObject({ typedHost: legacy.typedHost, pairingId: legacy.pairingId });
      expect(peerNeedsPairing(getPeer(legacy.fingerprint)!)).toBe(true);
      expect(commitVerifiedRoute(legacy.fingerprint, trustOf(legacy), 'other.local:9443', 'other.local')).toBe(false);
    });

    it('a host the device itself announced stays shared even if it was also typed', () => {
      addPeer(member({ privateHosts: ['192.168.1.9'] }));
      expect(isPrivateHost(getPeer('aa:bb:cc'), '192.168.1.9')).toBe(true);
      noteReached('aa:bb:cc', '192.168.1.9', 9443, 'discovered');
      expect(isPrivateHost(getPeer('aa:bb:cc'), '192.168.1.9', 9443)).toBe(false);
      // Loopback is never shared this way.
      noteReached('aa:bb:cc', '127.0.0.1', 7443, 'discovered');
      expect(getPeer('aa:bb:cc')!.sharedEndpoints).toEqual({ '192.168.1.9': 9443 });
      // Reached at another port on that host, through this machine's own route: still private there.
      expect(isPrivateHost(getPeer('aa:bb:cc'), '192.168.1.9', 7443)).toBe(true);
    });

    it('a continuity re-pair through a private remapped port keeps the link endpoint shared at its own port, across a restart', () => {
      const linked = member({
        knownHosts: ['10.20.0.5'], hostPorts: { '10.20.0.5': 9443 }, mainPort: 9443, sharedEndpoints: { '10.20.0.5': 9443 },
      });
      // Paired again with the same certificate, no link, at 10.20.0.5:7443 (a forward): that address is private.
      const again: AnnexPeer = {
        ...makePeer('aa:bb:cc', 'Studio'), role: 'member', kind: 'desktop', pairingId: 'pairing-1', tlsCertificateFingerprint: 'CERT-1',
        knownHosts: ['10.20.0.5'], hostPorts: { '10.20.0.5': 7443 }, mainPort: 9443, privateHosts: ['10.20.0.5'],
      };
      addPeer(withSavedRoutes(linked, again, true));
      resetForTests();
      const saved = getPeer('aa:bb:cc')!;
      expect(saved).toMatchObject({ hostPorts: { '10.20.0.5': 7443 }, sharedEndpoints: { '10.20.0.5': 9443 }, privateHosts: ['10.20.0.5'] });
      expect(isPrivateHost(saved, '10.20.0.5', 7443)).toBe(true);
      expect(isPrivateHost(saved, '10.20.0.5', 9443)).toBe(false);
    });

    it('a private route never becomes the shared default port', () => {
      addPeer(member({ privateHosts: ['10.20.0.5'] }));
      noteReached('aa:bb:cc', '10.20.0.5', 7443);
      expect(getPeer('aa:bb:cc')).toMatchObject({ mainPort: 9443, hostPorts: expect.objectContaining({ '10.20.0.5': 7443 }) });
    });

    describe('pairing again', () => {
      const next = (overrides: Partial<AnnexPeer> = {}): AnnexPeer => ({
        ...makePeer('aa:bb:cc', 'Studio'), role: 'member', kind: 'desktop', pairingId: 'pairing-1',
        tlsCertificateFingerprint: 'CERT-1', knownHosts: ['192.168.1.5'], hostPorts: { '192.168.1.5': 9443 }, mainPort: 9443, ...overrides,
      });
      const previous = member({
        typedHost: '127.0.0.1:7555', typedHostCert: 'CERT-1', privateHosts: ['10.20.0.5'],
        knownHosts: ['127.0.0.1', '10.20.0.5', '192.168.1.5'], hostPorts: { '127.0.0.1': 7443, '10.20.0.5': 7000, '192.168.1.5': 9443 },
      });

      it('keeps every saved route for the same verified peer', () => {
        const out = withSavedRoutes(previous, next(), true);
        expect(out).toMatchObject({ typedHost: '127.0.0.1:7555', typedHostCert: 'CERT-1', privateHosts: ['10.20.0.5'] });
        expect(out.knownHosts).toEqual(['192.168.1.5', '127.0.0.1', '10.20.0.5']);
        expect(out.hostPorts).toEqual({ '127.0.0.1': 7443, '10.20.0.5': 7000, '192.168.1.5': 9443 });
        expect(out.heldRoutes).toBeUndefined();
      });

      it('keeps a bare typed route dialable after a server-side continuity re-pair and restart without discovery', () => {
        const previous = member({
          pairedAt: '2026-11-01T09:00:00.000Z', lastSeen: '2026-11-02T09:00:00.000Z',
          typedHost: 'studio.local', knownHosts: [], hostPorts: {}, mainPort: 7555,
        });
        // The server's pairedPeer contains identity/pairing metadata but no route or port fields.
        const pairedPeer = next({ tlsCertificatePem: 'PEM-1', knownHosts: undefined, hostPorts: undefined, mainPort: undefined });
        addPeer(withSavedRoutes(previous, pairedPeer, true));
        resetForTests();
        const reloaded = getPeer(previous.fingerprint)!;
        expect(peerNeedsPairing(reloaded)).toBe(false);
        expect(reloaded.typedHost).toBe('studio.local');
        expect(reachCandidates({ typed: reloaded.typedHost, known: reloaded.knownHosts, ports: reloaded.hostPorts, port: reloaded.mainPort }))
          .toEqual([{ host: 'studio.local', port: 7555, source: 'typed' }]);
        expect(reloaded.heldRoutes).toBeUndefined();
      });

      it('keeps a new pairing port authoritative and never activates the legacy port without continuity', () => {
        const previous = member({ typedHost: 'studio.local', knownHosts: [], hostPorts: {}, mainPort: 7555 });
        expect(withSavedRoutes(previous, next({ mainPort: 8443 }), true).mainPort).toBe(8443);
        const changedPin = withSavedRoutes(previous, next({ mainPort: undefined, tlsCertificateFingerprint: 'CERT-2' }), false);
        expect(changedPin.mainPort).toBeUndefined();
        expect(changedPin.typedHost).toBeUndefined();
        const changedIdentity = withSavedRoutes(previous, next({ mainPort: undefined, publicKey: 'someone-else' }), true);
        expect(changedIdentity.mainPort).toBeUndefined();
        expect(changedIdentity.typedHost).toBeUndefined();
      });

      it('holds, never drops or retargets, saved routes when the certificate is not shown to be the same', () => {
        const out = withSavedRoutes(previous, next({ tlsCertificateFingerprint: 'CERT-ROGUE' }), false);
        expect(out.typedHost).toBeUndefined();
        expect(out.knownHosts).toEqual(['192.168.1.5']);
        expect(out.heldRoutes).toMatchObject({
          certFingerprint: 'CERT-1', typedHost: '127.0.0.1:7555',
          knownHosts: ['127.0.0.1', '10.20.0.5', '192.168.1.5'], hostPorts: { '127.0.0.1': 7443, '10.20.0.5': 7000, '192.168.1.5': 9443 },
        });
        // Still private: holding only ever narrows what's shared.
        expect(out.privateHosts).toEqual(['10.20.0.5']);
        // A second hold keeps the first one's values.
        const again = withSavedRoutes({ ...out, typedHost: '127.0.0.1:7999' }, next({ tlsCertificateFingerprint: 'CERT-3' }), false);
        expect(again.heldRoutes).toMatchObject({ typedHost: '127.0.0.1:7999', knownHosts: expect.arrayContaining(['10.20.0.5', '127.0.0.1']) });
      });

      it.each([
        ['studio.local', {}, 9443, 'studio.local:9443'],
        ['studio.local', { 'studio.local': 7555 }, 9443, 'studio.local:7555'],
        ['2001:db8::5', {}, 9443, '[2001:db8::5]:9443'],
      ])('preserves the effective endpoint of held %s across restart without activating it', (typedHost, hostPorts, mainPort, expected) => {
        const old = member({ typedHost, knownHosts: [], hostPorts, mainPort });
        const replacement = next({
          tlsCertificateFingerprint: 'CERT-UNPROVED', knownHosts: undefined, hostPorts: undefined, mainPort: undefined,
        });
        addPeer(withSavedRoutes(old, replacement, false));
        resetForTests();
        const saved = getPeer(old.fingerprint)!;
        expect(saved.heldRoutes).toMatchObject({ typedHost: expected, certFingerprint: 'CERT-1' });
        expect(saved.typedHost).toBeUndefined();
        expect(saved.typedHostCert).toBeUndefined();
        expect(saved.mainPort).toBeUndefined();
        expect(reachCandidates({ typed: saved.typedHost, known: saved.knownHosts, ports: saved.hostPorts, port: saved.mainPort })).toEqual([]);
        // This is retained evidence of the old endpoint, not a verified active route for the new pin.
        expect(saved.tlsCertificateFingerprint).toBe('CERT-UNPROVED');
      });

      it('never carries routes to a different identity', () => {
        const out = withSavedRoutes(previous, { ...next(), publicKey: 'someone-else' }, true);
        expect(out.typedHost).toBeUndefined();
        expect(out.heldRoutes?.typedHost).toBe('127.0.0.1:7555');
      });

      it('keeps held routes, the new local fields, and unknown fields across a restart', () => {
        addPeer(withSavedRoutes(previous, next({ tlsCertificateFingerprint: 'CERT-2' }), false));
        resetForTests();
        const reloaded = getPeer('aa:bb:cc')!;
        expect(reloaded.heldRoutes?.typedHost).toBe('127.0.0.1:7555');
        expect(reloaded.privateHosts).toEqual(['10.20.0.5']);
        const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'annex-peers.json'), 'utf8')) as AnnexPeer[];
        expect(raw[0]).toMatchObject({ heldRoutes: expect.any(Object), privateHosts: ['10.20.0.5'], mainPort: 9443 });
      });
    });
  });

  describe('where a satellite is reached (#3058)', () => {
    it('remembers the host it was reached at first, and its port, across a restart', () => {
      addPeer({ ...makePeer('aa:bb:cc'), role: 'satellite', knownHosts: ['10.0.0.4', 'studio.local'], mainPort: 9000 });
      noteReached('aa:bb:cc', 'Studio.local', 9443);
      resetForTests();
      expect(getPeer('aa:bb:cc')).toMatchObject({
        knownHosts: ['studio.local', '10.0.0.4'], mainPort: 9443,
        hostPorts: { 'studio.local': 9443, '10.0.0.4': 9000 },
      });
    });

    it('migrates legacy and mixed records without losing peers, fields or downgrade compatibility', () => {
      const legacy = { ...makePeer('legacy'), role: 'satellite', knownHosts: ['192.168.1.5', 'Studio.local'], mainPort: 9443, extra: { kept: true } };
      const mixed = { ...makePeer('mixed'), knownHosts: ['127.0.0.1', '192.168.1.6', '::1'], mainPort: 9443,
        hostPorts: { '127.0.0.1': 7443, '::1': 8443 } };
      const noAddress = makePeer('no-address');
      fs.writeFileSync(path.join(tmpDir, 'annex-peers.json'), JSON.stringify([legacy, mixed, noAddress]));
      expect(listPeers()).toHaveLength(3);
      expect(getPeer('legacy')).toEqual({ ...legacy, hostPorts: { '192.168.1.5': 9443, 'studio.local': 9443 } });
      expect(getPeer('mixed')).toEqual({ ...mixed, hostPorts: { ...mixed.hostPorts, '192.168.1.6': 9443 } });

      noteReached('legacy', '127.0.0.1', 7443);
      noteReached('legacy', '192.168.1.5', 9443);
      noteReached('mixed', '192.168.1.6', 9000);
      resetForTests();
      const peer = getPeer('legacy')!;
      expect(peer).toMatchObject({ ...legacy, lastSeen: expect.any(String), knownHosts: ['192.168.1.5', '127.0.0.1', 'Studio.local'] });
      expect(reachCandidates({ known: peer.knownHosts, ports: peer.hostPorts, port: peer.mainPort }).map(({ host, port }) => [host, port])).toEqual([
        ['192.168.1.5', 9443], ['127.0.0.1', 7443], ['studio.local', 9443],
      ]);
      expect(getPeer('mixed')?.hostPorts).toEqual({ '127.0.0.1': 7443, '::1': 8443, '192.168.1.6': 9000 });
      const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, 'annex-peers.json'), 'utf8')) as AnnexPeer[];
      expect(saved).toHaveLength(3);
      // Older builds ignore hostPorts and can still use the original direct hosts and default.
      expect(saved[0]).toMatchObject({ mainPort: 9443, extra: legacy.extra });
      expect(reachCandidates({ known: saved[0].knownHosts, port: saved[0].mainPort })).toContainEqual({
        host: '192.168.1.5', port: 9443, source: 'known',
      });
      expect(saved[0].knownHosts).toContain('Studio.local');
      expect(getPeer('no-address')).toEqual(noAddress);
    });

    it('ignores an unknown peer or an address with no port', () => {
      addPeer(makePeer('aa:bb:cc'));
      noteReached('nope', '10.0.0.4', 9443);
      noteReached('aa:bb:cc', '10.0.0.4', 0);
      expect(getPeer('aa:bb:cc')!.knownHosts).toBeUndefined();
    });

    it.each(['127.0.0.1', '0x7f000001', '0x7f.0.0.1'])('keeps the direct default after reaching loopback host %s', (host) => {
      addPeer({ ...makePeer('aa:bb:cc'), role: 'satellite', knownHosts: ['10.0.0.4'], mainPort: 9443 });
      noteReached('aa:bb:cc', host, 7443);
      resetForTests();
      expect(getPeer('aa:bb:cc')).toMatchObject({
        mainPort: 9443, knownHosts: [host, '10.0.0.4'], hostPorts: { [host]: 7443, '10.0.0.4': 9443 },
      });
    });

    it('reaches and heals a direct port changed by an older build without changing the saved forward', () => {
      addPeer({
        ...makePeer('aa:bb:cc'), role: 'satellite', knownHosts: ['192.168.1.5', '127.0.0.1'],
        mainPort: 9443, hostPorts: { '192.168.1.5': 9443, '127.0.0.1': 7443 },
      });
      const file = path.join(tmpDir, 'annex-peers.json');
      const oldBuildPeers = JSON.parse(fs.readFileSync(file, 'utf8')) as AnnexPeer[];
      // Older builds update only the shared port when they reach an existing host.
      oldBuildPeers[0].mainPort = 9000;
      fs.writeFileSync(file, JSON.stringify(oldBuildPeers));
      resetForTests();
      const peer = getPeer('aa:bb:cc')!;
      expect(reachCandidates({ known: peer.knownHosts, ports: peer.hostPorts, port: peer.mainPort })).toEqual([
        { host: '192.168.1.5', port: 9443, source: 'known' },
        { host: '192.168.1.5', port: 9000, source: 'known' },
        { host: '127.0.0.1', port: 7443, source: 'known' },
      ]);
      noteReached('aa:bb:cc', '192.168.1.5', 9000);
      resetForTests();
      expect(getPeer('aa:bb:cc')?.hostPorts).toEqual({ '192.168.1.5': 9000, '127.0.0.1': 7443 });
    });

    it('sets and clears a typed host', () => {
      addPeer(makePeer('aa:bb:cc'));
      expect(setTypedHost('aa:bb:cc', 'studio.tail1234.ts.net')).toBe(true);
      expect(getPeer('aa:bb:cc')!.typedHost).toBe('studio.tail1234.ts.net');
      setTypedHost('aa:bb:cc', undefined);
      expect(getPeer('aa:bb:cc')).not.toHaveProperty('typedHost');
      expect(setTypedHost('nope', 'x')).toBe(false);
    });
  });

  describe('brute-force protection', () => {
    it('should allow first 3 attempts freely', () => {
      expect(checkBruteForce('192.168.1.1').allowed).toBe(true);
      recordFailedAttempt('192.168.1.1');
      expect(checkBruteForce('192.168.1.1').allowed).toBe(true);
      recordFailedAttempt('192.168.1.1');
      expect(checkBruteForce('192.168.1.1').allowed).toBe(true);
    });

    it('should delay after 3 failed attempts', () => {
      for (let i = 0; i < 3; i++) recordFailedAttempt('192.168.1.1');
      const check = checkBruteForce('192.168.1.1');
      // Should require a delay
      expect(check.allowed).toBe(false);
      expect(check.delayMs).toBeGreaterThan(0);
    });

    it('should lock out after 6 failed attempts', () => {
      for (let i = 0; i < 6; i++) recordFailedAttempt('192.168.1.1');
      const check = checkBruteForce('192.168.1.1');
      expect(check.locked).toBe(true);
      expect(check.allowed).toBe(false);
      expect(isPairingLocked()).toBe(true);
    });

    it('should reset on successful attempt', () => {
      for (let i = 0; i < 3; i++) recordFailedAttempt('192.168.1.1');
      recordSuccessfulAttempt('192.168.1.1');
      const check = checkBruteForce('192.168.1.1');
      expect(check.allowed).toBe(true);
      expect(check.attemptsRemaining).toBe(3);
    });

    it('takes back one attempt that was not a guess, lifting a lockout it caused', () => {
      for (let i = 0; i < 6; i++) recordFailedAttempt('192.168.1.1');
      expect(checkBruteForce('192.168.1.1').locked).toBe(true);
      forgiveFailedAttempt('192.168.1.1');
      expect(checkBruteForce('192.168.1.1').locked).toBe(false);
      expect(isPairingLocked()).toBe(false);
      for (let i = 0; i < 5; i++) forgiveFailedAttempt('192.168.1.1');
      expect(checkBruteForce('192.168.1.1')).toMatchObject({ allowed: true, attemptsRemaining: 3 });
      // Nothing to take back: still a no-op.
      forgiveFailedAttempt('192.168.1.1');
      expect(checkBruteForce('192.168.1.1').attemptsRemaining).toBe(3);
    });

    it('a recorded and forgiven attempt leaves earlier failures counted', () => {
      for (let i = 0; i < 2; i++) recordFailedAttempt('192.168.1.1');
      recordFailedAttempt('192.168.1.1');
      forgiveFailedAttempt('192.168.1.1');
      expect(checkBruteForce('192.168.1.1')).toMatchObject({ allowed: true, attemptsRemaining: 1 });
    });

    it('should unlock manually', () => {
      for (let i = 0; i < 6; i++) recordFailedAttempt('192.168.1.1');
      expect(isPairingLocked()).toBe(true);
      unlockPairing();
      expect(isPairingLocked()).toBe(false);
      expect(checkBruteForce('192.168.1.1').allowed).toBe(true);
    });

    it('should track sources independently', () => {
      for (let i = 0; i < 6; i++) recordFailedAttempt('192.168.1.1');
      expect(checkBruteForce('192.168.1.1').locked).toBe(true);
      expect(checkBruteForce('192.168.1.2').allowed).toBe(true);
    });
  });

  describe('pairings from before pinning', () => {
    it('loads an older file as it is, keeps every entry, and marks the ones that need pairing again', () => {
      // An older file: a bare array, entries with no role and no certificate pin.
      fs.writeFileSync(path.join(tmpDir, 'annex-peers.json'), JSON.stringify([
        { fingerprint: 'aa:bb', publicKey: 'pk', alias: 'Legacy desktop', icon: 'computer', color: 'indigo', pairedAt: '2025-01-01T00:00:00.000Z', lastSeen: '2025-01-01T00:00:00.000Z' },
        { ...makePeer('cc:dd'), role: 'controller' },
        { ...makePeer('ee:ff'), role: 'controller', tlsCertificateFingerprint: 'AB:CD' },
        { ...makePeer('11:22'), role: 'satellite', tlsCertificateFingerprint: 'AB:CD' },
        { ...makePeer('33:44'), role: 'satellite', tlsCertificateFingerprint: 'AB:CD', tlsCertificatePem: 'PEM' },
      ]));
      expect(listPeers()).toHaveLength(5);
      expect(listPeersForDisplay().map((p) => [p.fingerprint, p.needsPairing])).toEqual([
        ['aa:bb', true], ['cc:dd', true], ['ee:ff', false], ['11:22', true], ['33:44', false],
      ]);
      expect(peerNeedsPairing({ ...makePeer('x'), role: undefined, tlsCertificateFingerprint: 'AB' })).toBe(true);
    });

    it('treats a file that is not a list as empty rather than failing', () => {
      fs.writeFileSync(path.join(tmpDir, 'annex-peers.json'), JSON.stringify({ peers: [] }));
      expect(listPeers()).toEqual([]);
    });

    it('re-pairing an entry replaces it in place with the pinned one', () => {
      addPeer(makePeer('aa:bb', 'Old'));
      addPeer({ ...makePeer('aa:bb', 'New'), role: 'controller', tlsCertificateFingerprint: 'AB:CD' });
      expect(listPeersForDisplay()).toEqual([expect.objectContaining({ alias: 'New', needsPairing: false })]);
    });

    it('writes the peer file readable by this user only', () => {
      addPeer(makePeer('aa:bb'));
      if (process.platform !== 'win32') {
        expect(fs.statSync(path.join(tmpDir, 'annex-peers.json')).mode & 0o777).toBe(0o600);
      }
    });
  });
});
