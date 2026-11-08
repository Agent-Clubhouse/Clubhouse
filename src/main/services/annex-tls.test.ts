import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, chmodSync: vi.fn(actual.chmodSync) };
});

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

import * as https from 'https';
import * as tls from 'tls';
import forge from 'node-forge';
import {
  getOrCreateCert, createTlsServerOptions, createPinnedTlsClientOptions, resetForTests, signCertBinding, verifyCertBinding,
  certificateFingerprint, sameCertificateFingerprint, probePeerCertificate, PIN_MISMATCH_CODE,
  randomCertificateSerial,
} from './annex-tls';
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

    it('should create the certificate file with 0600 permissions before chmod', () => {
      vi.mocked(fs.chmodSync).mockImplementation(() => undefined);
      getOrCreateCert(identity);
      const filePath = path.join(tmpDir, 'annex-tls-cert.json');
      const stats = fs.statSync(filePath);
      if (process.platform !== 'win32') {
        expect(stats.mode & 0o777).toBe(0o600);
      }
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

    /** A saved certificate built with the given serial, using a native RSA key for speed. */
    function savedCertWithSerial(serialHex: string): { certPem: string; keyPem: string; generatedAt: string } {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const cert = forge.pki.createCertificate();
      cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }) as string);
      cert.serialNumber = serialHex;
      cert.validity.notBefore = new Date(Date.now() - 60_000);
      cert.validity.notAfter = new Date(Date.now() + 86_400_000);
      cert.setSubject([{ name: 'commonName', value: identity.fingerprint }]);
      cert.setIssuer(cert.subject.attributes);
      const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
      cert.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create());
      return { certPem: forge.pki.certificateToPem(cert), keyPem, generatedAt: new Date().toISOString() };
    }

    it('replaces a saved certificate that TLS cannot load (#2992)', () => {
      // forge drops one leading zero byte, so 00 00 43 is written as 00 43: not
      // minimal, which OpenSSL refuses as "illegal padding".
      const bad = savedCertWithSerial('0000' + '43' + 'ab'.repeat(13));
      expect(() => tls.createSecureContext({ cert: bad.certPem, key: bad.keyPem })).toThrow();
      const filePath = path.join(tmpDir, 'annex-tls-cert.json');
      fs.writeFileSync(filePath, JSON.stringify(bad));

      const cert = getOrCreateCert(identity);

      expect(cert.certPem).not.toBe(bad.certPem);
      expect(() => tls.createSecureContext({ cert: cert.certPem, key: cert.keyPem })).not.toThrow();
      expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).certPem).toBe(cert.certPem);
    });

    it('keeps a saved certificate that TLS can load', () => {
      const good = savedCertWithSerial(randomCertificateSerial());
      fs.writeFileSync(path.join(tmpDir, 'annex-tls-cert.json'), JSON.stringify(good));
      expect(getOrCreateCert(identity).certPem).toBe(good.certPem);
    });
  });

  describe('randomCertificateSerial', () => {
    it('is 16 bytes with a first byte from 0x01 to 0x7f', () => {
      for (let i = 0; i < 4096; i++) {
        const serial = randomCertificateSerial();
        expect(serial).toMatch(/^[0-9a-f]{32}$/);
        const first = parseInt(serial.slice(0, 2), 16);
        expect(first).toBeGreaterThanOrEqual(0x01);
        expect(first).toBeLessThanOrEqual(0x7f);
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

  describe('pinned client connections', () => {
    type Credentials = { cert: string; key: string };

    /** A self-signed certificate (native RSA key, signed with forge) with a chosen name and dates. */
    function certificateFor(cn: string, validity: { notBefore?: Date; notAfter?: Date } = {}): Credentials {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const cert = forge.pki.createCertificate();
      cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }) as string);
      cert.serialNumber = randomCertificateSerial();
      cert.validity.notBefore = validity.notBefore ?? new Date(Date.now() - 60_000);
      cert.validity.notAfter = validity.notAfter ?? new Date(Date.now() + 86_400_000);
      cert.setSubject([{ name: 'commonName', value: cn }]);
      cert.setIssuer(cert.subject.attributes);
      const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
      cert.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create());
      return { cert: forge.pki.certificateToPem(cert), key: keyPem };
    }

    /** A loopback HTTPS server that counts every request it receives. */
    async function serve(credentials: Credentials): Promise<{ port: number; requests: string[]; close: () => Promise<void> }> {
      const requests: string[] = [];
      const server = https.createServer({ ...credentials, requestCert: true, rejectUnauthorized: false }, (req, res) => {
        requests.push(`${req.method} ${req.url}`);
        req.resume();
        res.end('{}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      return { port: (server.address() as { port: number }).port, requests, close: () => new Promise((r) => server.close(() => r())) };
    }

    function get(port: number, options: tls.ConnectionOptions): Promise<{ status?: number; code?: string }> {
      return new Promise((resolve) => {
        const req = https.request({ host: '127.0.0.1', port, path: '/api/v1/status', method: 'POST', agent: false, ...options,
          headers: { Authorization: 'Bearer must-not-arrive' } }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
        req.on('error', (err: NodeJS.ErrnoException) => resolve({ code: err.code }));
        req.end('request body');
      });
    }

    it('reaches the satellite showing the pinned certificate', async () => {
      const satellite = getOrCreateCert(makeTestIdentity());
      resetForTests();
      const server = await serve({ cert: satellite.certPem, key: satellite.keyPem });
      try {
        const options = createPinnedTlsClientOptions(identity, { certPem: satellite.certPem, fingerprint: certificateFingerprint(satellite.certPem) });
        expect(await get(server.port, options)).toEqual({ status: 200 });
        expect(server.requests).toEqual(['POST /api/v1/status']);
      } finally { await server.close(); }
    }, 30_000);

    it('refuses a server with the same name but another certificate before anything is sent', async () => {
      const satelliteIdentity = makeTestIdentity();
      const satellite = getOrCreateCert(satelliteIdentity);
      resetForTests();
      const sameName = certificateFor(satelliteIdentity.fingerprint);
      const server = await serve(sameName);
      try {
        const options = createPinnedTlsClientOptions(identity, { certPem: satellite.certPem, fingerprint: certificateFingerprint(satellite.certPem) });
        const result = await get(server.port, options);
        expect(result.status).toBeUndefined();
        expect(result.code).toBeTruthy();
        expect(server.requests).toEqual([]);
      } finally { await server.close(); }
    }, 30_000);

    it('refuses the right key behind a different certificate', async () => {
      const pinnedCert = certificateFor('satellite');
      const server = await serve(pinnedCert);
      try {
        // Pinned to the certificate's hash, so trusting the same PEM under another hash fails closed.
        expect(() => createPinnedTlsClientOptions(identity, { certPem: pinnedCert.cert, fingerprint: 'AB'.repeat(32) }))
          .toThrow(expect.objectContaining({ code: PIN_MISMATCH_CODE }));
        expect(server.requests).toEqual([]);
      } finally { await server.close(); }
    }, 30_000);

    it("enforces the satellite certificate's end date, so an expired one needs pairing again", async () => {
      const expired = certificateFor('satellite', { notBefore: new Date(Date.now() - 2 * 86_400_000), notAfter: new Date(Date.now() - 86_400_000) });
      const server = await serve(expired);
      try {
        const options = createPinnedTlsClientOptions(identity, { certPem: expired.cert, fingerprint: certificateFingerprint(expired.cert) });
        expect(await get(server.port, options)).toEqual({ code: 'CERT_HAS_EXPIRED' });
        expect(server.requests).toEqual([]);
      } finally { await server.close(); }
    }, 30_000);

    it('reads a server certificate for comparison without sending a request', async () => {
      const shown = certificateFor('satellite');
      const server = await serve(shown);
      try {
        const probed = await probePeerCertificate('127.0.0.1', server.port);
        expect(probed.fingerprint).toBe(certificateFingerprint(shown.cert));
        expect(sameCertificateFingerprint(certificateFingerprint(probed.certPem), probed.fingerprint)).toBe(true);
        expect(server.requests).toEqual([]);
      } finally { await server.close(); }
    }, 30_000);
  });

  describe('certificate binding', () => {
    it("verifies this instance's own certificate against its identity key, and nothing else", () => {
      const der = new crypto.X509Certificate(getOrCreateCert(identity).certPem).raw;
      const binding = signCertBinding(identity);
      expect(verifyCertBinding(identity.publicKey, der, binding)).toBe(true);
      expect(verifyCertBinding(makeTestIdentity().publicKey, der, binding)).toBe(false);
      expect(verifyCertBinding(identity.publicKey, Buffer.from('another certificate'), binding)).toBe(false);
      expect(verifyCertBinding(identity.publicKey, der, undefined)).toBe(false);
      expect(verifyCertBinding('not-a-key', der, binding)).toBe(false);
    });
  });

  it('compares certificate hashes whatever the colons or case', () => {
    expect(sameCertificateFingerprint('AB:'.repeat(31) + 'AB', 'ab'.repeat(32))).toBe(true);
    expect(sameCertificateFingerprint('ab'.repeat(32), 'ac'.repeat(32))).toBe(false);
    expect(sameCertificateFingerprint(undefined, undefined)).toBe(false);
  });
});
