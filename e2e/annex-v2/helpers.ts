/**
 * Protocol-level helpers for Annex V2 E2E tests.
 *
 * These helpers interact with the Annex server at the HTTPS/WSS level with a
 * client certificate, allowing fast protocol validation without requiring
 * full UI automation.
 */
import type { Page } from '@playwright/test';
import * as https from 'https';
import WebSocket from 'ws';
import { connectMtlsWs, type TestIdentity } from './tls-test-utils';

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
  /** Main TLS port: pairing, REST and the WebSocket. */
  port: number;
  /** Plain HTTP port: identity hint only. */
  pairingPort: number;
  /** Single-use: read it again after each pairing. */
  pin: string;
  connectedCount: number;
  tlsEnabled: boolean;
  tlsCertificateFingerprint?: string;
}

/**
 * Read Annex status (ports + current PIN) via the preload API in the renderer.
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
      tlsEnabled: status.tlsEnabled,
      tlsCertificateFingerprint: status.tlsCertificateFingerprint,
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
    if (!settings.enableServer || !settings.enableClient) {
      await (window as any).clubhouse.annex.saveSettings({ ...settings, enableServer: true, enableClient: true });
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
// Pairing and mTLS helpers
//
// Pairing is `POST /pair` on the main TLS port, presenting a client
// certificate whose CN is the identity fingerprint. The server pins that
// certificate; every REST request and WebSocket presents it afterwards.
// A PIN is single-use, so read it from status again before each pairing.
// ---------------------------------------------------------------------------

export interface PairResult {
  /** Vestigial: nothing authenticates by it. */
  token: string;
  tlsCertificateFingerprint?: string;
  mobileProtocolVersion?: number;
  pairingMode?: string;
  publicKey?: string;
  alias?: string;
  icon?: string;
  color?: string;
  fingerprint?: string;
}

export interface JsonReply {
  status: number;
  body: any;
}

/** A JSON request to the main TLS port, presenting the identity's client certificate. */
export function mtlsRequest(
  host: string,
  port: number,
  identity: TestIdentity,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<JsonReply> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, port, method, path: urlPath,
      cert: identity.certPem, key: identity.keyPem, rejectUnauthorized: false, agent: false,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed: unknown = data;
        try { parsed = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** `POST /pair` on the main TLS port with this identity; answers whatever status the server gives. */
export function tryPairOverTls(
  host: string,
  port: number,
  pin: string,
  identity: TestIdentity,
  extra: Record<string, unknown> = {},
): Promise<JsonReply> {
  return mtlsRequest(host, port, identity, 'POST', '/pair', {
    pin,
    publicKey: identity.ed25519PublicKeyBase64,
    alias: 'E2E controller',
    icon: 'computer',
    color: 'indigo',
    ...extra,
  });
}

/** Pair this identity over TLS on the main port. Throws with the status on anything but 200. */
export async function pairOverTls(
  host: string,
  port: number,
  pin: string,
  identity: TestIdentity,
  extra: Record<string, unknown> = {},
): Promise<PairResult> {
  const reply = await tryPairOverTls(host, port, pin, identity, extra);
  if (reply.status !== 200) {
    throw new Error(`Pair failed (${reply.status}): ${JSON.stringify(reply.body)}`);
  }
  return reply.body as PairResult;
}

/** A plain HTTP request to the pairing port (identity hint only; `POST /pair` there is 410). */
export async function plainPairingPortRequest(
  host: string,
  pairingPort: number,
  method: 'GET' | 'POST',
  urlPath: string,
  body?: unknown,
): Promise<JsonReply> {
  const response = await fetch(`http://${host}:${pairingPort}${urlPath}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** Fetch a JSON endpoint over mTLS; throws on anything but 200. */
export async function fetchMtls(
  host: string,
  port: number,
  identity: TestIdentity,
  urlPath: string,
): Promise<unknown> {
  const reply = await mtlsRequest(host, port, identity, 'GET', urlPath);
  if (reply.status !== 200) {
    throw new Error(`Request failed (${reply.status}): ${urlPath}`);
  }
  return reply.body;
}

/** Same SHA-256 certificate fingerprint, whatever the separators or case. */
export function sameCertFingerprint(a: string | undefined, b: string | undefined): boolean {
  const norm = (f: string | undefined) => (f ?? '').replace(/[:\s]/g, '').toLowerCase();
  return norm(a).length === 64 && norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

/**
 * Connect to an Annex server's WebSocket endpoint over mTLS with a paired identity.
 */
export function connectWs(host: string, port: number, identity: TestIdentity, query = ''): WebSocket {
  return connectMtlsWs(host, port, identity, query);
}

/**
 * A WebSocket to the main TLS port that presents no client certificate.
 */
export function connectWsWithoutCertificate(host: string, port: number, query = ''): WebSocket {
  return new WebSocket(`wss://${host}:${port}/ws${query ? `?${query}` : ''}`, { rejectUnauthorized: false });
}

/**
 * How the server answered an upgrade: 'opened', or the HTTP status and JSON body it refused with.
 */
export function upgradeOutcome(ws: WebSocket, timeout = 10_000): Promise<'opened' | JsonReply> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No answer to the WebSocket upgrade within ${timeout}ms`)), timeout);
    ws.on('error', () => { /* the refusal below says what happened */ });
    ws.once('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve('opened');
    });
    ws.once('unexpected-response', (_req, res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        let body: unknown = data;
        try { body = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
  });
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
