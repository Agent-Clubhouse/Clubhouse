import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

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

import { getOrCreateCert, createTlsServerOptions, createTlsClientOptions, resetForTests } from './annex-tls';
import type { AnnexIdentity } from './annex-identity';
import { app } from 'electron';

function makeTestIdentity(): AnnexIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const pubBase64 = publicKey.toString('base64');
  const hash = crypto.createHash('sha256').update(publicKey).digest('hex');
  const fingerprint = hash.slice(0, 32).match(/.{2}/g)!.join(':');

  return {
    publicKey: pubBase64,
    privateKey: privateKey.toString('base64'),
    fingerprint,
    createdAt: new Date().toISOString(),
  };
}

describe('annex-tls', () => {
  let tmpDir: string;
  let identity: AnnexIdentity;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'annex-tls-test-'));
    (app as any).__setUserDataPath(tmpDir);
    resetForTests();
    identity = makeTestIdentity();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getOrCreateCert', () => {
    it('should generate a valid PEM certificate', () => {
      const cert = getOrCreateCert(identity);
      expect(cert.certPem).toContain('-----BEGIN CERTIFICATE-----');
      expect(cert.certPem).toContain('-----END CERTIFICATE-----');
      expect(cert.keyPem).toContain('PRIVATE KEY-----');
      expect(cert.keyPem).toContain('-----END');
    });

    it('should persist and reload across cache resets', () => {
      const cert1 = getOrCreateCert(identity);
      resetForTests();
      const cert2 = getOrCreateCert(identity);
      expect(cert1.certPem).toBe(cert2.certPem);
      expect(cert1.keyPem).toBe(cert2.keyPem);
    });

    it('should return same cert on repeated calls', () => {
      const cert1 = getOrCreateCert(identity);
      const cert2 = getOrCreateCert(identity);
      expect(cert1.certPem).toBe(cert2.certPem);
    });

    it('should parse as valid X.509', () => {
      const cert = getOrCreateCert(identity);
      // Node.js can parse the cert
      const x509 = new crypto.X509Certificate(cert.certPem);
      expect(x509.subject).toContain(identity.fingerprint);
    });

    it('should set CN to the fingerprint', () => {
      const cert = getOrCreateCert(identity);
      const x509 = new crypto.X509Certificate(cert.certPem);
      expect(x509.subject).toContain(`CN=${identity.fingerprint}`);
    });

    it('should produce valid certs across 5 generations with different fingerprints', { timeout: 15_000 }, () => {
      // Regression test: hand-rolled ASN.1 was flaky due to encoding edge cases.
      // Generate multiple certs to ensure node-forge produces consistently valid output.
      for (let i = 0; i < 5; i++) {
        resetForTests();
        const id = makeTestIdentity();
        (app as any).__setUserDataPath(fs.mkdtempSync(path.join(tmpDir, `iter-${i}-`)));
        const cert = getOrCreateCert(id);
        const x509 = new crypto.X509Certificate(cert.certPem);
        expect(x509.subject).toContain(`CN=${id.fingerprint}`);
      }
    });
  });

  describe('createTlsServerOptions', () => {
    it('should return valid TLS options', () => {
      const opts = createTlsServerOptions(identity);
      expect(opts.cert).toBeTruthy();
      expect(opts.key).toBeTruthy();
      expect(opts.requestCert).toBe(true);
      expect(opts.rejectUnauthorized).toBe(false);
    });
  });

  describe('createTlsClientOptions', () => {
    it('should return valid client TLS options', () => {
      const opts = createTlsClientOptions(identity);
      expect(opts.cert).toBeTruthy();
      expect(opts.key).toBeTruthy();
      expect(opts.rejectUnauthorized).toBe(false);
    });
  });
});
