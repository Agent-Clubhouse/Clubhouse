/**
 * Annex V2 Lifecycle E2E Tests
 *
 * Full dual-instance lifecycle: connect → snapshot → disconnect → reconnect.
 * Tests the happy path of the remote control protocol.
 */
import { test, expect } from '@playwright/test';
import WebSocket from 'ws';
import { launchDual, cleanupDual, type DualInstanceHandles } from './dual-launch';
import {
  enableAnnexViaPreload,
  getAnnexStatus,
  pairOverTls,
  connectWs,
  waitForOpen,
  waitForMessage,
} from './helpers';
import { generateTestIdentity, type TestIdentity } from './tls-test-utils';

/** Connect over mTLS with the paired controller's certificate. */
async function connectControllerWs(host: string, port: number, identity: TestIdentity): Promise<WebSocket> {
  const ws = connectWs(host, port, identity);
  await waitForOpen(ws, 10_000);
  return ws;
}

let handles: DualInstanceHandles;
let controller: TestIdentity;
let satPort: number;

test.setTimeout(300_000);

test.beforeAll(async () => {
  handles = await launchDual();

  // Enable Annex on the satellite
  await enableAnnexViaPreload(handles.satellite.window);
  const satStatus = await getAnnexStatus(handles.satellite.window);
  satPort = satStatus.port;

  expect(satStatus.advertising).toBe(true);
  expect(satPort).toBeGreaterThan(0);

  // Pair controller with satellite over TLS; its certificate is pinned
  controller = generateTestIdentity();
  const pairResult = await pairOverTls('127.0.0.1', satPort, satStatus.pin, controller);
  expect(pairResult.fingerprint).toBeTruthy();
});

test.afterAll(async () => {
  if (handles) await cleanupDual(handles);
});

test.describe('lifecycle', () => {
  test('connect → snapshot → disconnect → reconnect', async () => {
    // 1. Connect via WebSocket
    const ws1 = await connectControllerWs('127.0.0.1', satPort, controller);

    // 2. Receive snapshot
    const snapshot = await waitForMessage(ws1, 'snapshot', 15_000);
    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.payload).toBeDefined();
    const payload = snapshot.payload as Record<string, unknown>;
    expect(payload.protocolVersion).toBe(2);

    // 3. Disconnect
    ws1.close();
    await new Promise((r) => setTimeout(r, 1_000));

    // Verify server shows 0 connections
    const statusAfterDisconnect = await getAnnexStatus(handles.satellite.window);
    expect(statusAfterDisconnect.connectedCount).toBe(0);

    // 4. Reconnect
    const ws2 = await connectControllerWs('127.0.0.1', satPort, controller);
    const snapshot2 = await waitForMessage(ws2, 'snapshot', 15_000);
    expect(snapshot2.type).toBe('snapshot');
    expect((snapshot2.payload as any).protocolVersion).toBe(2);

    // Verify server shows 1 connection
    const statusAfterReconnect = await getAnnexStatus(handles.satellite.window);
    expect(statusAfterReconnect.connectedCount).toBe(1);

    ws2.close();
  });

  test('multiple sequential operations', async () => {
    // Connect
    const ws = await connectControllerWs('127.0.0.1', satPort, controller);
    const snapshot = await waitForMessage(ws, 'snapshot', 15_000);
    expect(snapshot.type).toBe('snapshot');

    // PTY resize (should not error even if no PTY is running)
    ws.send(JSON.stringify({
      type: 'pty:resize',
      payload: { agentId: 'nonexistent', cols: 120, rows: 40 },
    }));

    // Give server time to process
    await new Promise((r) => setTimeout(r, 500));

    // Disconnect
    ws.close();
    await new Promise((r) => setTimeout(r, 500));

    const status = await getAnnexStatus(handles.satellite.window);
    expect(status.connectedCount).toBe(0);
  });
});
