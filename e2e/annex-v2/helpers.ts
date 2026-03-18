/**
 * Protocol-level helpers for Annex V2 E2E tests.
 *
 * These helpers interact with the Annex server at the HTTP/WS level,
 * allowing fast protocol validation without requiring full UI automation.
 */
import type { Page } from '@playwright/test';
import WebSocket from 'ws';

type ElectronApp = Awaited<ReturnType<typeof import('@playwright/test')._electron.launch>>;

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

/**
 * Enable the Annex server via the settings UI toggle.
 */
export async function enableAnnex(window: Page): Promise<void> {
  // Navigate to settings
  const settingsBtn = window.locator('[data-testid="nav-settings"]');
  await settingsBtn.click();
  await window.waitForTimeout(500);

  // Click the Annex nav item
  const annexBtn = window.locator('button:has-text("Annex")').first();
  await annexBtn.click();
  await window.waitForTimeout(300);

  // Toggle annex on if not already enabled
  const toggle = window.locator('[data-testid="annex-toggle"]');
  const isChecked = await toggle.isChecked().catch(() => false);
  if (!isChecked) {
    await toggle.click();
    // Wait for server to start
    await window.waitForTimeout(1_000);
  }
}

// ---------------------------------------------------------------------------
// IPC-level helpers (bypass UI)
// ---------------------------------------------------------------------------

export interface AnnexStatusInfo {
  advertising: boolean;
  port: number;
  pin: string;
  connectedCount: number;
}

/**
 * Read Annex status (port + PIN) via IPC evaluation in the main process.
 */
export async function getAnnexStatus(electronApp: ElectronApp): Promise<AnnexStatusInfo> {
  return electronApp.evaluate(async ({ ipcMain }) => {
    // Access the annex server module through require
    const annexServer = require('./services/annex-server');
    return annexServer.getStatus();
  });
}

/**
 * Enable Annex server programmatically via IPC (no UI interaction).
 */
export async function enableAnnexViaIpc(electronApp: ElectronApp): Promise<void> {
  await electronApp.evaluate(async () => {
    const { ipcMain } = require('electron');
    const annexSettings = require('./services/annex-settings');
    const annexServer = require('./services/annex-server');

    const settings = annexSettings.getSettings();
    if (!settings.enabled) {
      await annexSettings.saveSettings({ ...settings, enabled: true });
      annexServer.start();
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

export interface PairResult {
  token: string;
  publicKey?: string;
  alias?: string;
  icon?: string;
  color?: string;
  fingerprint?: string;
}

/**
 * Pair with an Annex server via HTTP POST /pair.
 */
export async function pairViaHttp(
  host: string,
  port: number,
  pin: string,
  clientPublicKey?: string,
): Promise<PairResult> {
  const body: Record<string, unknown> = { pin };
  if (clientPublicKey) body.publicKey = clientPublicKey;

  const response = await fetch(`http://${host}:${port}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(`Pair failed (${response.status}): ${JSON.stringify(errorBody)}`);
  }

  return response.json();
}

/**
 * Fetch a JSON endpoint with bearer token authentication.
 */
export async function fetchAuthed(
  host: string,
  port: number,
  token: string,
  path: string,
): Promise<unknown> {
  const response = await fetch(`http://${host}:${port}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${path}`);
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

/**
 * Connect to an Annex server's WebSocket endpoint.
 */
export function connectWs(host: string, port: number, token: string): WebSocket {
  const ws = new WebSocket(`ws://${host}:${port}/ws?token=${encodeURIComponent(token)}`);
  return ws;
}

/**
 * Wait for a specific WebSocket message type.
 */
export function waitForMessage(
  ws: WebSocket,
  type: string,
  timeout = 10_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for WS message type "${type}" (${timeout}ms)`));
    }, timeout);

    function onMessage(data: WebSocket.Data) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          cleanup();
          resolve(msg);
        }
      } catch {
        // Ignore parse errors
      }
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function onClose() {
      cleanup();
      reject(new Error(`WebSocket closed while waiting for "${type}"`));
    }

    function cleanup() {
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      ws.removeListener('error', onError);
      ws.removeListener('close', onClose);
    }

    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

/**
 * Wait for the WebSocket to reach the OPEN state.
 */
export function waitForOpen(ws: WebSocket, timeout = 10_000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`WebSocket did not open within ${timeout}ms`));
    }, timeout);

    function onOpen() {
      cleanup();
      resolve();
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      clearTimeout(timer);
      ws.removeListener('open', onOpen);
      ws.removeListener('error', onError);
    }

    ws.on('open', onOpen);
    ws.on('error', onError);
  });
}
