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
  pairViaHttp,
  connectWs,
  connectWsPlain,
  waitForOpen,
  waitForMessage,
  collectPtyData,
} from './helpers';

/** Connect with bearer token (tries wss, falls back to ws). */
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

let handles: DualInstanceHandles;
let bearerToken: string;
let satPort: number;
let pairingPort: number;

test.setTimeout(300_000);

test.beforeAll(async () => {
  handles = await launchDual();

  // Enable Annex on the satellite
  await enableAnnexViaPreload(handles.satellite.window);
  const satStatus = await getAnnexStatus(handles.satellite.window);
  satPort = satStatus.port;
  pairingPort = satStatus.pairingPort;

  expect(satStatus.advertising).toBe(true);
  expect(satPort).toBeGreaterThan(0);

  // Pair controller with satellite
  const pairResult = await pairViaHttp('127.0.0.1', pairingPort, satStatus.pin);
  bearerToken = pairResult.token;
  expect(bearerToken).toBeTruthy();
});

test.afterAll(async () => {
  if (handles) await cleanupDual(handles);
});

test.describe('lifecycle', () => {
  test('connect → snapshot → disconnect → reconnect', async () => {
    // 1. Connect via WebSocket
    const ws1 = await connectBearerWs('127.0.0.1', satPort, bearerToken);

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
    const ws2 = await connectBearerWs('127.0.0.1', satPort, bearerToken);
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
    const ws = await connectBearerWs('127.0.0.1', satPort, bearerToken);
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
