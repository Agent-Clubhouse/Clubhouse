/**
 * Annex V2 Minimal Validation Test
 *
 * Verifies that the app launches with rendered UI and that the Annex V2
 * preload APIs are available. This is the basic sanity check before
 * running protocol-level tests.
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import { launchApp } from '../launch';
import * as path from 'path';
import * as fs from 'fs';
import { plainPairingPortRequest, sameCertFingerprint, tryPairOverTls } from './helpers';
import { generateTestIdentity } from './tls-test-utils';

const SCREENSHOTS_DIR = path.resolve(__dirname, 'screenshots');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;

test.beforeAll(async () => {
  ({ electronApp, window } = await launchApp());
});

test.afterAll(async () => {
  await electronApp?.close();
});

test.setTimeout(120_000);

test('app renders UI (not blank screen)', async () => {
  const root = window.locator('#root');
  await expect(root).toBeVisible({ timeout: 5_000 });
  const childCount = await root.evaluate((el) => el.children.length);
  expect(childCount).toBeGreaterThan(0);

  await window.screenshot({ path: path.join(SCREENSHOTS_DIR, 'minimal-test.png') });
});

test('annex preload API is available', async () => {
  const hasAnnex = await window.evaluate(() => {
    const w = window as any;
    return {
      annex: typeof w.clubhouse?.annex === 'object',
      annexGetSettings: typeof w.clubhouse?.annex?.getSettings === 'function',
      annexGetStatus: typeof w.clubhouse?.annex?.getStatus === 'function',
      annexSaveSettings: typeof w.clubhouse?.annex?.saveSettings === 'function',
      annexListPeers: typeof w.clubhouse?.annex?.listPeers === 'function',
      annexClient: typeof w.clubhouse?.annexClient === 'object',
      annexClientGetSatellites: typeof w.clubhouse?.annexClient?.getSatellites === 'function',
    };
  });

  expect(hasAnnex.annex).toBe(true);
  expect(hasAnnex.annexGetSettings).toBe(true);
  expect(hasAnnex.annexGetStatus).toBe(true);
  expect(hasAnnex.annexSaveSettings).toBe(true);
  expect(hasAnnex.annexListPeers).toBe(true);
  expect(hasAnnex.annexClient).toBe(true);
  expect(hasAnnex.annexClientGetSatellites).toBe(true);
});

test('annex server can be enabled and returns status', async () => {
  // Enable experimental flag first (annex is gated behind it)
  await window.evaluate(async () => {
    const w = window as any;
    const expSettings = await w.clubhouse.app.getExperimentalSettings();
    if (!expSettings.annex) {
      await w.clubhouse.app.saveExperimentalSettings({ ...expSettings, annex: true });
    }
  });

  // Enable annex via preload API
  await window.evaluate(async () => {
    const w = window as any;
    const settings = await w.clubhouse.annex.getSettings();
    if (!settings.enableServer || !settings.enableClient) {
      await w.clubhouse.annex.saveSettings({ ...settings, enableServer: true, enableClient: true });
    }
  });

  // Poll for server to start advertising (may take a few seconds on CI)
  let status: any;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    status = await window.evaluate(async () => {
      const w = window as any;
      return w.clubhouse.annex.getStatus();
    });
    if (status.advertising) break;
    await window.waitForTimeout(500);
  }

  expect(status.advertising).toBe(true);
  expect(status.port).toBeGreaterThan(0);
  expect(status.pin).toBeTruthy();
  expect(typeof status.pin).toBe('string');
  expect(status.pin.length).toBeGreaterThanOrEqual(4);

  console.log(`Annex status: port=${status.port}, pin=${status.pin}, advertising=${status.advertising}`);
});

test('identity endpoint is accessible', async () => {
  const status = await window.evaluate(async () => {
    const w = window as any;
    return w.clubhouse.annex.getStatus();
  });

  // Fetch the identity endpoint directly
  const response = await fetch(`http://127.0.0.1:${status.pairingPort || status.port}/api/v1/identity`);
  expect(response.ok).toBe(true);

  const identity = await response.json();
  expect(identity.fingerprint).toBeTruthy();
  expect(typeof identity.fingerprint).toBe('string');

  console.log(`Identity: fingerprint=${identity.fingerprint}`);
});

test('POST /pair on the plain pairing port is 410 update_required', async () => {
  const status = await window.evaluate(async () => {
    const w = window as any;
    return w.clubhouse.annex.getStatus();
  });

  const identity = generateTestIdentity();
  const reply = await plainPairingPortRequest('127.0.0.1', status.pairingPort, 'POST', '/pair', {
    pin: status.pin,
    publicKey: identity.ed25519PublicKeyBase64,
  });
  expect(reply.status).toBe(410);
  expect(reply.body).toMatchObject({ error: 'update_required', message: expect.any(String) });
  expect(reply.body).not.toHaveProperty('token');

  const peers = await window.evaluate(async () => (window as any).clubhouse.annex.listPeers());
  expect(peers.some((p: { fingerprint: string }) => p.fingerprint === identity.fingerprint)).toBe(false);
});

test('PIN pairing works over TLS on the main port, and the PIN is then replaced', async () => {
  const status = await window.evaluate(async () => {
    const w = window as any;
    return w.clubhouse.annex.getStatus();
  });
  expect(status.tlsEnabled).toBe(true);

  const identity = generateTestIdentity();
  const reply = await tryPairOverTls('127.0.0.1', status.port, status.pin, identity);
  expect(reply.status).toBe(200);
  expect(reply.body).toMatchObject({ mobileProtocolVersion: 1, pairingMode: 'persistent', fingerprint: status.fingerprint });
  expect(sameCertFingerprint(reply.body.tlsCertificateFingerprint, status.tlsCertificateFingerprint)).toBe(true);

  const after = await window.evaluate(async () => (window as any).clubhouse.annex.getStatus());
  expect(after.pin).not.toBe(status.pin);

  console.log(`Pairing: controller=${identity.fingerprint}`);
});

test('brute-force lockout after wrong PINs', async () => {
  const status = await window.evaluate(async () => {
    const w = window as any;
    return w.clubhouse.annex.getStatus();
  });

  const identity = generateTestIdentity();

  // Send wrong PINs
  for (let i = 0; i < 5; i++) {
    const reply = await tryPairOverTls('127.0.0.1', status.port, '0000', identity);
    // Should be 409 (wrong PIN) or 429 (rate limited)
    expect([409, 429]).toContain(reply.status);
  }

  // The next attempt should be rate-limited (429) even with the correct PIN
  const locked = await tryPairOverTls('127.0.0.1', status.port, status.pin, identity);
  expect(locked.status).toBe(429);

  // Unlock pairing
  await window.evaluate(async () => {
    const w = window as any;
    await w.clubhouse.annex.unlockPairing();
  });

  console.log('Brute-force lockout verified');
});

test('annex experimental flag can be toggled', async () => {
  // Verify the experimental settings API works for the annex flag.
  // The nav button visibility in settings is gated behind isBetaBuild() +
  // an async useEffect, which is already exercised by full-demo.spec.ts.
  // Here we just verify the flag round-trips correctly.
  await window.evaluate(async () => {
    const w = window as any;
    const s = await w.clubhouse.app.getExperimentalSettings();
    await w.clubhouse.app.saveExperimentalSettings({ ...s, annex: true });
  });

  const after = await window.evaluate(async () => {
    return (window as any).clubhouse.app.getExperimentalSettings();
  });

  expect(after.annex).toBe(true);
});
