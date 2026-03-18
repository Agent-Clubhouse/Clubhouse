import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock electron before importing module
vi.mock('electron', () => {
  let userDataPath = '';
  return {
    app: {
      getPath: (name: string) => {
        if (name === 'userData') return userDataPath;
        return '';
      },
      // Allow tests to set the userData path
      __setUserDataPath: (p: string) => { userDataPath = p; },
    },
  };
});

// Mock log service
vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import { getOrCreateIdentity, getIdentity, getPublicIdentity, computeFingerprint, resetForTests } from './annex-identity';
import { app } from 'electron';

describe('annex-identity', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'annex-identity-test-'));
    (app as any).__setUserDataPath(tmpDir);
    resetForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getOrCreateIdentity', () => {
    it('should generate a new identity on first call', () => {
      const identity = getOrCreateIdentity();

      expect(identity.publicKey).toBeTruthy();
      expect(identity.privateKey).toBeTruthy();
      expect(identity.fingerprint).toBeTruthy();
      expect(identity.createdAt).toBeTruthy();

      // Verify the file was created
      const filePath = path.join(tmpDir, 'annex-identity.json');
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('should return the same identity on subsequent calls (idempotent)', () => {
      const identity1 = getOrCreateIdentity();
      const identity2 = getOrCreateIdentity();

      expect(identity1.publicKey).toBe(identity2.publicKey);
      expect(identity1.privateKey).toBe(identity2.privateKey);
      expect(identity1.fingerprint).toBe(identity2.fingerprint);
    });

    it('should persist and reload identity across cache resets', () => {
      const identity1 = getOrCreateIdentity();
      resetForTests();
      const identity2 = getOrCreateIdentity();

      expect(identity1.publicKey).toBe(identity2.publicKey);
      expect(identity1.fingerprint).toBe(identity2.fingerprint);
    });

    it('should set 0600 permissions on identity file', () => {
      getOrCreateIdentity();
      const filePath = path.join(tmpDir, 'annex-identity.json');
      const stats = fs.statSync(filePath);
      // On macOS/Linux, check permissions. On Windows this may be different.
      if (process.platform !== 'win32') {
        expect(stats.mode & 0o777).toBe(0o600);
      }
    });
  });

  describe('computeFingerprint', () => {
    it('should produce deterministic fingerprints', () => {
      const identity = getOrCreateIdentity();
      const fp1 = computeFingerprint(identity.publicKey);
      const fp2 = computeFingerprint(identity.publicKey);
      expect(fp1).toBe(fp2);
    });

    it('should match the stored fingerprint', () => {
      const identity = getOrCreateIdentity();
      const computed = computeFingerprint(identity.publicKey);
      expect(computed).toBe(identity.fingerprint);
    });

    it('should format as colon-separated hex', () => {
      const identity = getOrCreateIdentity();
      expect(identity.fingerprint).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){15}$/);
    });
  });

  describe('getIdentity', () => {
    it('should return null when no identity exists', () => {
      expect(getIdentity()).toBeNull();
    });

    it('should return identity after creation', () => {
      getOrCreateIdentity();
      resetForTests(); // Clear cache
      const identity = getIdentity();
      expect(identity).not.toBeNull();
      expect(identity!.publicKey).toBeTruthy();
    });
  });

  describe('getPublicIdentity', () => {
    it('should return null when no identity exists', () => {
      expect(getPublicIdentity()).toBeNull();
    });

    it('should return only public key and fingerprint', () => {
      getOrCreateIdentity();
      const pub = getPublicIdentity();
      expect(pub).not.toBeNull();
      expect(pub!.publicKey).toBeTruthy();
      expect(pub!.fingerprint).toBeTruthy();
      // Should NOT contain private key
      expect((pub as any).privateKey).toBeUndefined();
    });
  });

  describe('distinct keypairs', () => {
    it('should generate different keypairs for different userData dirs', () => {
      const identity1 = getOrCreateIdentity();

      // Switch to a new userData dir
      const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'annex-identity-test2-'));
      (app as any).__setUserDataPath(tmpDir2);
      resetForTests();

      const identity2 = getOrCreateIdentity();

      expect(identity1.publicKey).not.toBe(identity2.publicKey);
      expect(identity1.fingerprint).not.toBe(identity2.fingerprint);

      fs.rmSync(tmpDir2, { recursive: true, force: true });
    });
  });
});
