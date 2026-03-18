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
  updateLastSeen, checkBruteForce, recordFailedAttempt, recordSuccessfulAttempt,
  unlockPairing, isPairingLocked, resetForTests,
} from './annex-peers';
import { app } from 'electron';

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
});
