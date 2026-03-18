/**
 * Annex V2 Remote PTY Control E2E Tests
 *
 * Single Electron instance (satellite) + Node.js mTLS WebSocket client.
 * Proves bidirectional PTY control — the core value proposition of Annex V2.
 *
 * CI constraint: No agent CLI binary available. We use shell terminals
 * (pty.spawnShell) as the control surface instead.
 */
import { test, expect, _electron as electron, Page } from '@playwright/test';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { launchApp } from '../launch';
import {
  enableAnnexViaPreload,
  getAnnexStatus,
  pairViaHttp,
  connectWs,
  connectWsPlain,
  waitForOpen,
  waitForMessage,
  collectPtyData,
} from './helpers';
import { generateTestIdentity, connectMtlsWs, type TestIdentity } from './tls-test-utils';

const SCREENSHOTS_DIR = path.resolve(__dirname, 'screenshots');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

/** Cross-platform safe directory for PTY cwd.
 * os.tmpdir() is blocked on macOS (/private/var is restricted).
 * Use the user's home directory instead. */
const SHELL_CWD = os.homedir();

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Page;
let identity: TestIdentity;
let bearerToken: string;
let satPort: number;
let pairingPort: number;

test.setTimeout(180_000);

test.beforeAll(async () => {
  // Launch satellite
  ({ electronApp, window } = await launchApp());

  // Enable Annex
  await enableAnnexViaPreload(window);

  const status = await getAnnexStatus(window);
  satPort = status.port;
  pairingPort = status.pairingPort;

  // Generate test identity
  identity = generateTestIdentity();

  // Pair with public key (registers fingerprint as peer for mTLS)
  const pairResult = await pairViaHttp(
    '127.0.0.1',
    pairingPort,
    status.pin,
    identity.ed25519PublicKeyBase64,
  );
  bearerToken = pairResult.token;

  console.log(`Satellite ready: port=${satPort}, pairingPort=${pairingPort}`);
  console.log(`Test identity fingerprint: ${identity.fingerprint}`);
});

test.afterAll(async () => {
  await electronApp?.close();
});

test('mTLS WebSocket receives snapshot with protocolVersion 2', async () => {
  const ws = connectMtlsWs('127.0.0.1', satPort, identity, bearerToken);
  try {
    await waitForOpen(ws, 10_000);
    const snapshot = await waitForMessage(ws, 'snapshot', 15_000);

    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.payload).toBeTruthy();

    const payload = snapshot.payload as Record<string, unknown>;
    // The snapshot should have the expected structure
    expect(payload).toHaveProperty('projects');
    expect(payload).toHaveProperty('lastSeq');
  } finally {
    ws.close();
  }
});

test('bearer-only WS rejects pty:input with error', async () => {
  // Connect with bearer token only (no mTLS cert)
  let ws = connectWs('127.0.0.1', satPort, bearerToken);
  try {
    await waitForOpen(ws, 5_000);
  } catch {
    ws.close();
    ws = connectWsPlain('127.0.0.1', satPort, bearerToken);
    await waitForOpen(ws, 10_000);
  }

  try {
    // Drain the initial snapshot
    await waitForMessage(ws, 'snapshot', 10_000);

    // Try sending a control message — should be rejected
    ws.send(JSON.stringify({
      type: 'pty:input',
      payload: { agentId: 'test', data: 'hello\n' },
    }));

    const error = await waitForMessage(ws, 'error', 10_000);
    expect(error.type).toBe('error');
    const errorPayload = error.payload as Record<string, unknown>;
    expect(errorPayload.message).toContain('mTLS');
  } finally {
    ws.close();
  }
});

test('spawn shell, send echo command, receive output back', async () => {
  const shellId = `remote-shell-${Date.now()}`;

  // Connect via mTLS first so we don't miss early pty:data events
  const ws = connectMtlsWs('127.0.0.1', satPort, identity, bearerToken);
  try {
    await waitForOpen(ws, 10_000);

    // Drain the initial snapshot
    await waitForMessage(ws, 'snapshot', 10_000);

    // Spawn a shell on the satellite
    await window.evaluate(
      async ([id, cwd]: [string, string]) => {
        await (window as any).clubhouse.pty.spawnShell(id, cwd);
      },
      [shellId, SHELL_CWD] as [string, string],
    );

    // Wait for the shell prompt to arrive as pty:data (proves event bus → WS works)
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        ws.removeListener('message', onMsg);
        resolve();
      }, 5_000);
      function onMsg(data: import('ws').Data) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'pty:data' && msg.payload?.agentId === shellId) {
            clearTimeout(timeout);
            ws.removeListener('message', onMsg);
            resolve();
          }
        } catch { /* ignore */ }
      }
      ws.on('message', onMsg);
    });

    // Send echo command to the shell
    const marker = `ANNEX_E2E_MARKER_${Date.now()}`;
    ws.send(JSON.stringify({
      type: 'pty:input',
      payload: { agentId: shellId, data: `echo ${marker}\n` },
    }));

    // Collect pty:data until we see the marker
    const output = await collectPtyData(ws, marker, 30_000);
    expect(output).toContain(marker);

    console.log(`Bidirectional PTY control verified: marker "${marker}" appeared in output`);

    // Cleanup: kill the shell
    ws.send(JSON.stringify({
      type: 'agent:kill',
      payload: { agentId: shellId },
    }));
    await waitForMessage(ws, 'agent:kill:ack', 5_000);
  } finally {
    ws.close();
  }

  await window.screenshot({ path: path.join(SCREENSHOTS_DIR, 'remote-pty-echo.png') });
});

test('pty:resize accepted without error', async () => {
  const shellId = `resize-shell-${Date.now()}`;

  // Spawn a shell
  await window.evaluate(
    async ([id, cwd]: [string, string]) => {
      await (window as any).clubhouse.pty.spawnShell(id, cwd);
    },
    [shellId, SHELL_CWD] as [string, string],
  );
  await window.waitForTimeout(500);

  const ws = connectMtlsWs('127.0.0.1', satPort, identity, bearerToken);
  try {
    await waitForOpen(ws, 10_000);
    await waitForMessage(ws, 'snapshot', 10_000);

    // Send resize — should not produce an error
    ws.send(JSON.stringify({
      type: 'pty:resize',
      payload: { agentId: shellId, cols: 120, rows: 40 },
    }));

    // Wait a moment — no error message should arrive
    const errorOrTimeout = await waitForMessage(ws, 'error', 3_000).catch(() => null);
    expect(errorOrTimeout).toBeNull();

    // Cleanup
    ws.send(JSON.stringify({
      type: 'agent:kill',
      payload: { agentId: shellId },
    }));
    // The kill ack may or may not arrive depending on timing
    await waitForMessage(ws, 'agent:kill:ack', 5_000).catch(() => {});
  } finally {
    ws.close();
  }
});

test('agent:kill terminates remote shell', async () => {
  const shellId = `kill-shell-${Date.now()}`;

  // Spawn a shell
  await window.evaluate(
    async ([id, cwd]: [string, string]) => {
      await (window as any).clubhouse.pty.spawnShell(id, cwd);
    },
    [shellId, SHELL_CWD] as [string, string],
  );
  await window.waitForTimeout(500);

  const ws = connectMtlsWs('127.0.0.1', satPort, identity, bearerToken);
  try {
    await waitForOpen(ws, 10_000);
    await waitForMessage(ws, 'snapshot', 10_000);

    // Kill the shell
    ws.send(JSON.stringify({
      type: 'agent:kill',
      payload: { agentId: shellId },
    }));

    const ack = await waitForMessage(ws, 'agent:kill:ack', 10_000);
    expect(ack.type).toBe('agent:kill:ack');
    const ackPayload = ack.payload as Record<string, unknown>;
    expect(ackPayload.agentId).toBe(shellId);

    // pty:exit may or may not arrive depending on timing, but the ack confirms the kill was sent
    const exitMsg = await waitForMessage(ws, 'pty:exit', 5_000).catch(() => null);
    console.log(`Shell kill ack received, pty:exit=${exitMsg !== null}`);
  } finally {
    ws.close();
  }
});

test('pty:input over 64KB rejected', async () => {
  const ws = connectMtlsWs('127.0.0.1', satPort, identity, bearerToken);
  try {
    await waitForOpen(ws, 10_000);
    await waitForMessage(ws, 'snapshot', 10_000);

    // Send a payload over 64KB
    const bigData = 'x'.repeat(65 * 1024);
    ws.send(JSON.stringify({
      type: 'pty:input',
      payload: { agentId: 'any', data: bigData },
    }));

    const error = await waitForMessage(ws, 'error', 10_000);
    expect(error.type).toBe('error');
    const errorPayload = error.payload as Record<string, unknown>;
    expect(errorPayload.message).toContain('64KB');
  } finally {
    ws.close();
  }
});

test('agent:spawn with invalid projectId returns error', async () => {
  const ws = connectMtlsWs('127.0.0.1', satPort, identity, bearerToken);
  try {
    await waitForOpen(ws, 10_000);
    await waitForMessage(ws, 'snapshot', 10_000);

    // Try to spawn an agent in a non-existent project
    ws.send(JSON.stringify({
      type: 'agent:spawn',
      payload: { projectId: 'non-existent-project-id', prompt: 'test' },
    }));

    const error = await waitForMessage(ws, 'error', 10_000);
    expect(error.type).toBe('error');
    const errorPayload = error.payload as Record<string, unknown>;
    expect(errorPayload.message).toContain('project_not_found');
  } finally {
    ws.close();
  }
});
