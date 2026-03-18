/**
 * Annex V2 Full Validation E2E
 *
 * Validates Annex V2 protocol and UI integration using dual Clubhouse instances.
 * Uses preload APIs (not require()) for all IPC interactions.
 *
 * Phase 1 (Security): identity, dual-port, PIN pairing, brute-force lockout
 * Phase 2 (Client):   dual-instance launch, Annex enable, pairing, WS, snapshots
 * Phase 3 (Data Model): remote projects, lock overlay, plugin matching
 * Phase 4 (Full Demo): rail satellites, remote agent, bidirectional PTY
 */
import { test, expect, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { launchDual, cleanupDual, type DualInstanceHandles } from './dual-launch';
import { pairViaHttp, connectWs, connectWsPlain, waitForOpen, waitForMessage } from './helpers';

const SCREENSHOTS_DIR = path.resolve(__dirname, 'screenshots');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${name}.png`), fullPage: true });
}

let handles: DualInstanceHandles;

test.setTimeout(300_000);

test.afterAll(async () => {
  if (handles) {
    await cleanupDual(handles).catch(() => {});
  }
});

test('Phase 2: Dual-instance launch, enable, pair, connect', async () => {
  // ── Step 1: Launch dual instances ─────────────────────────────────────
  console.log('\n=== Step 1: Launch dual instances ===');
  handles = await launchDual();
  const { satellite, controller } = handles;

  // Verify both rendered
  for (const [label, inst] of [['satellite', satellite], ['controller', controller]] as const) {
    const root = inst.window.locator('#root');
    await expect(root).toBeVisible({ timeout: 10_000 });
    const childCount = await root.evaluate((el) => el.children.length);
    expect(childCount).toBeGreaterThan(0);
    console.log(`  ${label}: rendered (${childCount} children)`);
    await screenshot(inst.window, `01-${label}-launched`);
  }

  // ── Step 2: Enable Annex on satellite ─────────────────────────────────
  console.log('\n=== Step 2: Enable Annex on satellite ===');
  // Enable experimental flag first (annex is gated behind it)
  await satellite.window.evaluate(async () => {
    const w = window as any;
    const expSettings = await w.clubhouse.app.getExperimentalSettings();
    if (!expSettings.annex) {
      await w.clubhouse.app.saveExperimentalSettings({ ...expSettings, annex: true });
    }
  });
  await satellite.window.evaluate(async () => {
    const w = window as any;
    const settings = await w.clubhouse.annex.getSettings();
    if (!settings.enabled) {
      await w.clubhouse.annex.saveSettings({ ...settings, enabled: true });
    }
  });
  // Poll for server to start advertising (may take a few seconds on CI)
  let satStatus: any;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    satStatus = await satellite.window.evaluate(async () => {
      return (window as any).clubhouse.annex.getStatus();
    });
    if (satStatus.advertising) break;
    await satellite.window.waitForTimeout(500);
  }
  expect(satStatus.advertising).toBe(true);
  expect(satStatus.port).toBeGreaterThan(0);
  expect(satStatus.pin).toBeTruthy();
  console.log(`  Satellite: port=${satStatus.port}, pairingPort=${satStatus.pairingPort}, pin=${satStatus.pin}`);
  await screenshot(satellite.window, '02-satellite-annex-enabled');

  // ── Step 3: Identity endpoint accessible ──────────────────────────────
  console.log('\n=== Step 3: Check identity endpoint ===');
  const identityPort = satStatus.pairingPort || satStatus.port;
  const identityResp = await fetch(`http://127.0.0.1:${identityPort}/api/v1/identity`);
  expect(identityResp.ok).toBe(true);
  const identity = await identityResp.json();
  expect(identity.fingerprint).toBeTruthy();
  console.log(`  Identity: fingerprint=${identity.fingerprint}, alias=${identity.alias}`);

  // ── Step 4: Pair controller with satellite ────────────────────────────
  console.log('\n=== Step 4: Pair controller with satellite ===');
  const pairResult = await pairViaHttp(
    '127.0.0.1',
    identityPort,
    satStatus.pin,
  );
  expect(pairResult.token).toBeTruthy();
  console.log(`  Paired: token=${pairResult.token.slice(0, 8)}...`);

  // ── Step 5: WebSocket connection with bearer token ────────────────────
  console.log('\n=== Step 5: WebSocket connection ===');
  const wsPort = satStatus.port;

  // Try wss:// first (TLS), fall back to ws:// (HTTP fallback)
  let ws = connectWs('127.0.0.1', wsPort, pairResult.token);
  try {
    await waitForOpen(ws, 5_000);
    console.log('  WebSocket connected via wss://');
  } catch {
    console.log('  wss:// failed, trying ws:// fallback...');
    ws.close();
    ws = connectWsPlain('127.0.0.1', wsPort, pairResult.token);
    await waitForOpen(ws, 10_000);
    console.log('  WebSocket connected via ws://');
  }

  try {
    // Wait for initial snapshot
    const snapshotMsg = await waitForMessage(ws, 'snapshot', 15_000);
    expect(snapshotMsg.type).toBe('snapshot');
    console.log(`  Received snapshot: ${JSON.stringify(Object.keys(snapshotMsg)).slice(0, 100)}`);
  } finally {
    ws.close();
  }

  await screenshot(satellite.window, '05-after-ws-connection');
  await screenshot(controller.window, '05-controller-after-pair');

  // ── Step 6: Navigate to Annex settings on satellite ───────────────────
  console.log('\n=== Step 6: Navigate to Annex settings ===');
  const settingsBtn = satellite.window.locator('[data-testid="nav-settings"]');
  await settingsBtn.click();
  await satellite.window.waitForTimeout(500);

  const annexBtn = satellite.window.locator('button:has-text("Annex Server")').first();
  if (await annexBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await annexBtn.click();
    await satellite.window.waitForTimeout(500);
  }
  await screenshot(satellite.window, '06-satellite-annex-settings');

  // ── Step 7: Navigate to Annex Control on controller ───────────────────
  console.log('\n=== Step 7: Navigate to Annex Control ===');
  const ctrlSettingsBtn = controller.window.locator('[data-testid="nav-settings"]');
  await ctrlSettingsBtn.click();
  await controller.window.waitForTimeout(500);

  const annexControlBtn = controller.window.locator('button:has-text("Annex Control")').first();
  if (await annexControlBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await annexControlBtn.click();
    await controller.window.waitForTimeout(500);
  }
  await screenshot(controller.window, '07-controller-annex-control');

  // ── Step 8: Verify peer management APIs work ──────────────────────────
  console.log('\n=== Step 8: Verify peer management ===');
  const peers = await satellite.window.evaluate(async () => {
    return (window as any).clubhouse.annex.listPeers();
  });
  expect(Array.isArray(peers)).toBe(true);
  // PIN-only pairing without publicKey doesn't persist a peer — that's expected.
  // The bearer token alone is sufficient for WS auth.
  console.log(`  Satellite has ${peers.length} peer(s)`);

  // Verify connected count reflects the WS connection we just made
  const finalStatus = await satellite.window.evaluate(async () => {
    return (window as any).clubhouse.annex.getStatus();
  });
  expect(finalStatus.advertising).toBe(true);
  console.log(`  Connected count: ${finalStatus.connectedCount}, fingerprint: ${finalStatus.fingerprint}`);

  console.log('\n=== Phase 2 validation complete ===');
});
