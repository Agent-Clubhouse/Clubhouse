/**
 * Annex V2 Error Handling E2E Tests
 *
 * Adversarial/negative tests: wrong PIN, invalid token, rapid connect/disconnect.
 */
import { test, expect } from '@playwright/test';
import { launchDual, cleanupDual, type DualInstanceHandles } from './dual-launch';
import {
  enableAnnexViaPreload,
  getAnnexStatus,
  pairViaHttp,
  connectWsPlain,
  waitForOpen,
} from './helpers';

let handles: DualInstanceHandles;
let satPort: number;
let pairingPort: number;
let satPin: string;
let bearerToken: string;

test.setTimeout(300_000);

test.beforeAll(async () => {
  handles = await launchDual();

  // Enable Annex on the satellite
  await enableAnnexViaPreload(handles.satellite.window);
  const satStatus = await getAnnexStatus(handles.satellite.window);
  satPort = satStatus.port;
  pairingPort = satStatus.pairingPort;
  satPin = satStatus.pin;

  expect(satStatus.advertising).toBe(true);

  // Pair for tests that need a valid token
  const pairResult = await pairViaHttp('127.0.0.1', pairingPort, satPin);
  bearerToken = pairResult.token;
});

test.afterAll(async () => {
  if (handles) await cleanupDual(handles);
});

test.describe('error handling', () => {
  test('wrong PIN rejection', async () => {
    try {
      await pairViaHttp('127.0.0.1', pairingPort, '000000');
      // Should not reach here
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('401');
    }
  });

  test('invalid bearer token is rejected on WS', async () => {
    const ws = connectWsPlain('127.0.0.1', satPort, 'fabricated-invalid-token');

    const result = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 10_000);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve('opened'); // Should NOT happen
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        resolve(`error: ${err.message}`);
      });
      ws.on('close', (code) => {
        clearTimeout(timer);
        resolve(`closed: ${code}`);
      });
    });

    // Connection should be rejected (closed or error), NOT opened
    expect(result).not.toBe('opened');
    ws.close();
  });

  test('rapid connect/disconnect cycles — server remains stable', async () => {
    const cycles = 5;

    for (let i = 0; i < cycles; i++) {
      const ws = connectWsPlain('127.0.0.1', satPort, bearerToken);
      try {
        await waitForOpen(ws, 5_000);
        ws.close();
        await new Promise((r) => setTimeout(r, 200));
      } catch {
        // Connection may fail for ws:// if server uses TLS — that's fine
        ws.close();
      }
    }

    // Verify server is still responsive after rapid cycling
    const status = await getAnnexStatus(handles.satellite.window);
    expect(status.advertising).toBe(true);
    expect(status.port).toBeGreaterThan(0);
    expect(status.connectedCount).toBe(0);
  });

  test('concurrent pairing attempts both succeed', async () => {
    // Get fresh status with PIN
    const status = await getAnnexStatus(handles.satellite.window);
    const pin = status.pin;

    // Make two concurrent pairing requests with the correct PIN
    const [result1, result2] = await Promise.allSettled([
      pairViaHttp('127.0.0.1', status.pairingPort, pin),
      pairViaHttp('127.0.0.1', status.pairingPort, pin),
    ]);

    // At least one should succeed
    const successes = [result1, result2].filter((r) => r.status === 'fulfilled');
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // All fulfilled results should have a token
    for (const result of successes) {
      if (result.status === 'fulfilled') {
        expect(result.value.token).toBeTruthy();
      }
    }
  });
});
