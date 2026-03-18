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
    if (!settings.enabled) {
      await w.clubhouse.annex.saveSettings({ ...settings, enabled: true });
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

test('PIN pairing works via HTTP', async () => {
  const status = await window.evaluate(async () => {
    const w = window as any;
    return w.clubhouse.annex.getStatus();
  });

  const port = status.pairingPort || status.port;
  const response = await fetch(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: status.pin }),
  });

  expect(response.ok).toBe(true);
  const result = await response.json();
  expect(result.token).toBeTruthy();
  expect(typeof result.token).toBe('string');

  console.log(`Pairing: token=${result.token.slice(0, 8)}...`);
});

test('brute-force lockout after wrong PINs', async () => {
  const status = await window.evaluate(async () => {
    const w = window as any;
    return w.clubhouse.annex.getStatus();
  });

  const port = status.pairingPort || status.port;

  // Send wrong PINs
  for (let i = 0; i < 5; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '0000' }),
    });
    // Should be 401 or 429
    expect(response.ok).toBe(false);
  }

  // The next attempt should be rate-limited (429) even with the correct PIN
  const lockedResponse = await fetch(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: status.pin }),
  });
  expect(lockedResponse.status).toBe(429);

  // Unlock pairing
  await window.evaluate(async () => {
    const w = window as any;
    await w.clubhouse.annex.unlockPairing();
  });

  console.log('Brute-force lockout verified');
});

test('settings UI shows Annex Server section', async () => {
  // Ensure experimental annex flag is enabled (nav item is gated behind it).
  // showAnnex in AccessoryPanel is set once in useEffect on mount, so we must
  // reload the page after saving the flag to force React to re-initialize.
  await window.evaluate(async () => {
    const w = window as any;
    const expSettings = await w.clubhouse.app.getExperimentalSettings();
    if (!expSettings.annex) {
      await w.clubhouse.app.saveExperimentalSettings({ ...expSettings, annex: true });
    }
  });
  await window.reload({ waitUntil: 'domcontentloaded' });
  await window.locator('#root').waitFor({ state: 'visible', timeout: 10_000 });

  // Navigate to settings
  const settingsBtn = window.locator('[data-testid="nav-settings"]');
  await settingsBtn.click();

  // The Annex nav button depends on an async useEffect chain:
  // getVersion() → isBetaBuild() → getExperimentalSettings() → setShowAnnex(true)
  // Use Playwright's auto-retry with a generous timeout instead of a fixed wait.
  const annexBtn = window.locator('button:has-text("Annex Server")').first();
  await expect(annexBtn).toBeVisible({ timeout: 10_000 });

  await annexBtn.click();
  await window.waitForTimeout(500);
  await window.screenshot({ path: path.join(SCREENSHOTS_DIR, 'annex-settings.png') });

  // Toggle settings off
  await settingsBtn.click();
  await window.waitForTimeout(300);
});
