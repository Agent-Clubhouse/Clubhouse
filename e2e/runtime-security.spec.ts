import { test, expect } from '@playwright/test';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { brotliCompressSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import forge from 'node-forge';
import { launchApp } from './launch';
import { devDependencies } from '../package.json';

// Exercise the embedded runtime, not the Node process running Playwright.
// These are compatibility checks, not proofs that every runtime CVE is fixed.
test('reports the locked runtime and preserves TLS verification and fetch decoding', async () => {
  const testInfo = test.info();
  const { electronApp, profile } = await launchApp();
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 3_600_000);
  cert.setSubject([{ name: 'commonName', value: 'localhost' }]);
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const ca = forge.pki.certificateToPem(cert);
  const payload = JSON.stringify({ plugins: [], version: 'security-smoke' });
  const secure = createHttpsServer({ key: forge.pki.privateKeyToPem(keys.privateKey), cert: ca }, (_req, res) => {
    res.end(payload);
  });
  const compressed = createHttpServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'br' });
    res.end(brotliCompressSync(payload));
  });

  try {
    await Promise.all([secure, compressed].map((server) => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    })));
    const tlsUrl = `https://127.0.0.1:${(secure.address() as AddressInfo).port}`;
    const fetchUrl = `http://127.0.0.1:${(compressed.address() as AddressInfo).port}`;
    const result = await electronApp.evaluate(async (_electron, input) => {
      const https = process.getBuiltinModule('https');
      const get = (ca?: string) => new Promise<{ body?: string; error?: string }>((resolve) => {
        const req = https.get(input.tlsUrl, { ca, timeout: 5_000 }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ body }));
          res.on('error', (error: NodeJS.ErrnoException) => resolve({ error: error.code }));
        });
        req.on('timeout', () => req.destroy(new Error('TLS smoke timed out')));
        req.on('error', (error: NodeJS.ErrnoException) => resolve({ error: error.code ?? error.message }));
      });
      return {
        versions: { ...process.versions },
        untrusted: await get(),
        trusted: await get(input.ca),
        // A valid Brotli response establishes the marketplace fetch decoding
        // path without sending a malformed exploit payload to the runtime.
        decoded: await (await fetch(input.fetchUrl, { signal: AbortSignal.timeout(5_000) })).text(),
      };
    }, { tlsUrl, fetchUrl, ca });
    await testInfo.attach('embedded-runtime.json', {
      body: JSON.stringify(result.versions, null, 2), contentType: 'application/json',
    });
    expect(result.versions.electron).toBe(devDependencies.electron);
    expect(result.versions.node).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.versions.chrome).toMatch(/^\d+\./);
    expect(result.untrusted.error).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
    expect(result.trusted).toEqual({ body: payload });
    expect(result.decoded).toBe(payload);
  } finally {
    secure.closeAllConnections();
    compressed.closeAllConnections();
    await Promise.all([secure, compressed].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await electronApp.close();
    profile.dispose();
  }
});
