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
  pairingPort: number;
  pin: string;
  connectedCount: number;
}

/**
 * Read Annex status (port + PIN) via the preload API in the renderer.
 */
export async function getAnnexStatus(page: Page): Promise<AnnexStatusInfo> {
  return page.evaluate(async () => {
    const status = await (window as any).clubhouse.annex.getStatus();
    return {
      advertising: status.advertising,
      port: status.port,
      pairingPort: status.pairingPort || status.port,
      pin: status.pin,
      connectedCount: status.connectedCount,
    };
  });
}

/**
 * Enable Annex server programmatically via the preload API (no UI interaction).
 * Also enables the experimental flag so the server actually starts.
 */
export async function enableAnnexViaPreload(page: Page): Promise<void> {
  // Enable the experimental flag first (annex is gated behind it)
  await page.evaluate(async () => {
    const w = window as any;
    const expSettings = await w.clubhouse.app.getExperimentalSettings();
    if (!expSettings.annex) {
      await w.clubhouse.app.saveExperimentalSettings({ ...expSettings, annex: true });
    }
  });

  await page.evaluate(async () => {
    const settings = await (window as any).clubhouse.annex.getSettings();
    if (!settings.enabled) {
      await (window as any).clubhouse.annex.saveSettings({ ...settings, enabled: true });
    }
  });
  // Poll for server to start advertising (may take a few seconds on CI)
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await page.evaluate(async () => {
      return (window as any).clubhouse.annex.getStatus();
    });
    if (status.advertising) break;
    await page.waitForTimeout(500);
  }
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
 * Tries wss:// first (TLS with self-signed cert), falls back to ws://.
 */
export function connectWs(host: string, port: number, token: string): WebSocket {
  // The main port may be TLS — use wss:// with rejectUnauthorized: false for self-signed certs
  const ws = new WebSocket(
    `wss://${host}:${port}/ws?token=${encodeURIComponent(token)}`,
    { rejectUnauthorized: false },
  );
  return ws;
}

/**
 * Connect to an Annex server's WebSocket endpoint using plain ws://.
 * Use this when the main server fell back to HTTP (no TLS).
 */
export function connectWsPlain(host: string, port: number, token: string): WebSocket {
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
 * Collect pty:data messages until accumulated data contains the marker string.
 * Returns the full accumulated output.
 */
export function collectPtyData(
  ws: WebSocket,
  marker: string,
  timeout = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let accumulated = '';

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for PTY marker "${marker}" in output (${timeout}ms). Got: ${accumulated.slice(-200)}`));
    }, timeout);

    function onMessage(data: WebSocket.Data) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'pty:data' && typeof msg.payload?.data === 'string') {
          accumulated += msg.payload.data;
          if (accumulated.includes(marker)) {
            cleanup();
            resolve(accumulated);
          }
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
      reject(new Error(`WebSocket closed while waiting for PTY marker "${marker}"`));
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
