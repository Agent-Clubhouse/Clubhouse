import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
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
  listPeers, getPeer, isPairedPeer, addPeer, removePeer, removeAllPeers,
  updateLastSeen, checkBruteForce, recordFailedAttempt, recordSuccessfulAttempt, forgiveFailedAttempt,
  unlockPairing, isPairingLocked, resetForTests, peerNeedsPairing, listPeersForDisplay,
  noteReached, setTypedHost,
} from './annex-peers';
import { app } from 'electron';
import { reachCandidates } from './annex-reach';

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

    it('should persist to disk and survive cache reset', () => {
      addPeer(makePeer('aa:bb:cc'));
      resetForTests();
      expect(listPeers()).toHaveLength(1);
      expect(getPeer('aa:bb:cc')).toBeTruthy();
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
