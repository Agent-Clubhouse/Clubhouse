/**
 * Annex V2 Remote Control E2E Tests — Lock Overlay + Snapshot Content
 *
 * Dual Electron instances (satellite + controller). Tests the UI-visible
 * effects of remote control: lock overlay appearance/disappearance,
 * pause UX, and snapshot data integrity.
 */
import { test, expect } from '@playwright/test';
import WebSocket from 'ws';
import * as path from 'path';
import * as fs from 'fs';
import { launchDual, cleanupDual, type DualInstanceHandles } from './dual-launch';
import {
  enableAnnexViaPreload,
  getAnnexStatus,
  pairViaHttp,
  connectWs,
  connectWsPlain,
  waitForOpen,
  waitForMessage,
} from './helpers';
import { generateTestIdentity, connectMtlsWs, type TestIdentity } from './tls-test-utils';
import { addProject, stubDialogForPath } from '../smoke-helpers';

/** Connect with bearer token only (tries wss, falls back to ws). No lock overlay. */
async function connectBearerWs(host: string, port: number, token: string): Promise<WebSocket> {
  let ws = connectWs(host, port, token);
  try {
    await waitForOpen(ws, 5_000);
    return ws;
  } catch {
    ws.close();
    ws = connectWsPlain(host, port, token);
    await waitForOpen(ws, 10_000);
    return ws;
  }
}

const SCREENSHOTS_DIR = path.resolve(__dirname, 'screenshots');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const FIXTURE_PROJECT = path.resolve(__dirname, '../fixtures/project-smoke');

let handles: DualInstanceHandles;
let identity: TestIdentity;
let bearerToken: string;
let satPort: number;
let pairingPort: number;

test.setTimeout(300_000);

test.beforeAll(async () => {
  handles = await launchDual();
  const { satellite } = handles;

  // Add a fixture project to the satellite so snapshots have data
  await stubDialogForPath(satellite.electronApp, FIXTURE_PROJECT);
  await addProject(satellite.electronApp, satellite.window, FIXTURE_PROJECT);

  // Enable Annex on satellite
  await enableAnnexViaPreload(satellite.window);

  const status = await getAnnexStatus(satellite.window);
  satPort = status.port;
  pairingPort = status.pairingPort;

  // Generate test identity and pair
  identity = generateTestIdentity();

  const pairResult = await pairViaHttp(
    '127.0.0.1',
    pairingPort,
    status.pin,
    identity.ed25519PublicKeyBase64,
  );
  bearerToken = pairResult.token;

  console.log(`Dual launch ready: satPort=${satPort}, pairingPort=${pairingPort}`);
});

test.afterAll(async () => {
  if (handles) {
    await cleanupDual(handles).catch(() => {});
  }
});

test('mTLS connection triggers lock overlay on satellite', async () => {
  const { satellite } = handles;

  // Connect via mTLS — server broadcasts LOCK_STATE_CHANGED { locked: true }
  const ws = connectMtlsWs('127.0.0.1', satPort, identity, bearerToken);
  try {
    await waitForOpen(ws, 10_000);
    await waitForMessage(ws, 'snapshot', 15_000);

    // Wait for the lock overlay to appear on the satellite
    // The overlay text is "Controlled by {alias}" — the alias defaults to 'Unknown' if not set
    const lockOverlay = satellite.window.locator('text=/Controlled by/');
    await expect(lockOverlay).toBeVisible({ timeout: 10_000 });

    await satellite.window.screenshot({
      path: path.join(SCREENSHOTS_DIR, 'lock-overlay-active.png'),
      fullPage: true,
    });

    console.log('Lock overlay appeared on satellite');
  } finally {
    // Close WS — server broadcasts LOCK_STATE_CHANGED { locked: false }
    ws.close();
  }

  // Wait for lock overlay to disappear
  const lockOverlay = satellite.window.locator('text=/Controlled by/');
  await expect(lockOverlay).not.toBeVisible({ timeout: 10_000 });

  await satellite.window.screenshot({
    path: path.join(SCREENSHOTS_DIR, 'lock-overlay-cleared.png'),
    fullPage: true,
  });

  console.log('Lock overlay cleared after disconnect');
});

test('lock overlay Pause button toggles to paused state', async () => {
  const { satellite } = handles;

  const ws = connectMtlsWs('127.0.0.1', satPort, identity, bearerToken);
  try {
    await waitForOpen(ws, 10_000);
    await waitForMessage(ws, 'snapshot', 15_000);

    // Wait for lock overlay
    const lockOverlay = satellite.window.locator('text=/Controlled by/');
    await expect(lockOverlay).toBeVisible({ timeout: 10_000 });

    // Click the Pause button
    const pauseBtn = satellite.window.locator('button:has-text("Pause")');
    await expect(pauseBtn).toBeVisible({ timeout: 5_000 });
    await pauseBtn.click();

    // In paused state, the full overlay dims and shows "(paused)" text
    const pausedIndicator = satellite.window.locator('text=/paused/');
    await expect(pausedIndicator).toBeVisible({ timeout: 5_000 });

    await satellite.window.screenshot({
      path: path.join(SCREENSHOTS_DIR, 'lock-overlay-paused.png'),
      fullPage: true,
    });

    console.log('Pause UX works');
  } finally {
    ws.close();
  }

  // Wait for overlay to clear
  await expect(satellite.window.locator('text=/Controlled by/')).not.toBeVisible({ timeout: 10_000 });
  await expect(satellite.window.locator('text=/paused/')).not.toBeVisible({ timeout: 5_000 });
});

test('snapshot contains satellite project data', async () => {
  const ws = connectMtlsWs('127.0.0.1', satPort, identity, bearerToken);
  try {
    await waitForOpen(ws, 10_000);
    const snapshot = await waitForMessage(ws, 'snapshot', 15_000);

    const payload = snapshot.payload as Record<string, unknown>;
    expect(payload).toHaveProperty('projects');

    const projects = payload.projects as Array<Record<string, unknown>>;
    expect(Array.isArray(projects)).toBe(true);
    expect(projects.length).toBeGreaterThan(0);

    // The fixture project should be in the snapshot
    const hasProject = projects.some((p) =>
      typeof p.name === 'string' && p.name.length > 0,
    );
    expect(hasProject).toBe(true);

    console.log(`Snapshot contains ${projects.length} project(s): ${projects.map((p) => p.name).join(', ')}`);
  } finally {
    ws.close();
  }
});

test('snapshot updates when project is added', async () => {
  const { satellite } = handles;

  // Get initial project count via bearer WS (no lock overlay)
  let ws = await connectBearerWs('127.0.0.1', satPort, bearerToken);
  let initialCount: number;
  try {
    const initialSnapshot = await waitForMessage(ws, 'snapshot', 15_000);
    const initialProjects = ((initialSnapshot.payload as any).projects as any[]) || [];
    initialCount = initialProjects.length;
  } finally {
    ws.close();
  }

  // Add another fixture project (no lock overlay blocking clicks)
  const fixtureB = path.resolve(__dirname, '../fixtures/project-b');
  if (!fs.existsSync(fixtureB)) {
    console.log('Skipping dynamic project test: fixtures/project-b not found');
    return;
  }

  await stubDialogForPath(satellite.electronApp, fixtureB);
  await addProject(satellite.electronApp, satellite.window, fixtureB);
  await satellite.window.waitForTimeout(2_000);

  // Reconnect to get a fresh snapshot with the new project
  ws = await connectBearerWs('127.0.0.1', satPort, bearerToken);
  try {
    const updatedSnapshot = await waitForMessage(ws, 'snapshot', 15_000);
    const updatedProjects = ((updatedSnapshot.payload as any).projects as any[]) || [];

    expect(updatedProjects.length).toBeGreaterThan(initialCount);
    console.log(`Project count updated: ${initialCount} -> ${updatedProjects.length}`);
  } finally {
    ws.close();
  }
});

test('two mTLS connections: lock persists until both disconnect', async () => {
  const { satellite } = handles;

  // Generate a second identity and pair it
  const identity2 = generateTestIdentity();
  const status = await getAnnexStatus(satellite.window);
  const port2 = status.pairingPort;

  // Unlock pairing if locked from previous tests
  await satellite.window.evaluate(async () => {
    await (window as any).clubhouse.annex.unlockPairing();
  });

  const pairResult2 = await pairViaHttp(
    '127.0.0.1',
    port2,
    status.pin,
    identity2.ed25519PublicKeyBase64,
  );

  // Connect both controllers
  const ws1 = connectMtlsWs('127.0.0.1', satPort, identity, bearerToken);
  await waitForOpen(ws1, 10_000);
  await waitForMessage(ws1, 'snapshot', 15_000);

  const ws2 = connectMtlsWs('127.0.0.1', satPort, identity2, pairResult2.token);
  await waitForOpen(ws2, 10_000);
  await waitForMessage(ws2, 'snapshot', 15_000);

  // Lock overlay should be visible
  const lockOverlay = satellite.window.locator('text=/Controlled by/');
  await expect(lockOverlay).toBeVisible({ timeout: 10_000 });

  // Disconnect first controller
  ws1.close();
  await satellite.window.waitForTimeout(1_000);

  // Lock should still be active (second controller still connected)
  // The overlay may update the alias, but should still be visible
  const stillLocked = satellite.window.locator('text=/Controlled by/');
  await expect(stillLocked).toBeVisible({ timeout: 5_000 });

  console.log('Lock persists with one controller still connected');

  // Disconnect second controller
  ws2.close();

  // Now lock should clear
  await expect(lockOverlay).not.toBeVisible({ timeout: 10_000 });

  console.log('Lock cleared after both controllers disconnected');

  await satellite.window.screenshot({
    path: path.join(SCREENSHOTS_DIR, 'multi-controller-cleared.png'),
    fullPage: true,
  });
});
