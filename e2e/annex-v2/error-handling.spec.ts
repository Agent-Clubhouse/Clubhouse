/**
 * Annex V2 Error Handling E2E Tests
 *
 * Negative tests: wrong PIN, connections without the pinned client
 * certificate, rapid connect/disconnect, and concurrent pairing.
 */
import { test, expect } from '@playwright/test';
import { launchDual, cleanupDual, type DualInstanceHandles } from './dual-launch';
import {
  enableAnnexViaPreload,
  getAnnexStatus,
  pairOverTls,
  tryPairOverTls,
  connectWs,
  connectWsWithoutCertificate,
  upgradeOutcome,
  waitForOpen,
} from './helpers';
import { generateTestIdentity, type TestIdentity } from './tls-test-utils';

let handles: DualInstanceHandles;
let satPort: number;
let controller: TestIdentity;

test.setTimeout(300_000);

/** The current PIN: each one pairs a single identity. */
async function currentPin(): Promise<string> {
  return (await getAnnexStatus(handles.satellite.window)).pin;
}

test.beforeAll(async () => {
  handles = await launchDual();

  // Enable Annex on the satellite
  await enableAnnexViaPreload(handles.satellite.window);
  const satStatus = await getAnnexStatus(handles.satellite.window);
  satPort = satStatus.port;

  expect(satStatus.advertising).toBe(true);
  expect(satStatus.tlsEnabled).toBe(true);

  // Pair a controller identity for the tests that need one
  controller = generateTestIdentity();
  await pairOverTls('127.0.0.1', satPort, satStatus.pin, controller);
});

test.afterAll(async () => {
  if (handles) await cleanupDual(handles);
});

test.describe('error handling', () => {
  test('wrong PIN rejection', async () => {
    const reply = await tryPairOverTls('127.0.0.1', satPort, '000000', generateTestIdentity());
    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({ error: 'invalid_pin', message: expect.any(String) });
  });

  test('a WebSocket without a client certificate is refused with 401, with or without a token', async () => {
    for (const query of ['', 'token=fabricated-invalid-token']) {
      const outcome = await upgradeOutcome(connectWsWithoutCertificate('127.0.0.1', satPort, query));
      expect(outcome).toEqual({ status: 401, body: { error: 'unauthorized', message: expect.any(String) } });
    }
  });

  test('a WebSocket from an identity that has not paired is refused with 401 peer_not_paired', async () => {
    const outcome = await upgradeOutcome(connectWs('127.0.0.1', satPort, generateTestIdentity()));
    expect(outcome).toEqual({ status: 401, body: { error: 'peer_not_paired', message: expect.any(String) } });
  });

  test('rapid connect/disconnect cycles — server remains stable', async () => {
    const cycles = 5;

    for (let i = 0; i < cycles; i++) {
      const ws = connectWs('127.0.0.1', satPort, controller);
      await waitForOpen(ws, 5_000);
      ws.close();
      await new Promise((r) => setTimeout(r, 200));
    }

    // Verify server is still responsive after rapid cycling
    await expect.poll(async () => (await getAnnexStatus(handles.satellite.window)).connectedCount, { timeout: 5_000 }).toBe(0);
    const status = await getAnnexStatus(handles.satellite.window);
    expect(status.advertising).toBe(true);
    expect(status.port).toBeGreaterThan(0);
  });

  test('concurrent pairing of one identity with one PIN: both succeed with the same answer', async () => {
    const pin = await currentPin();
    const identity = generateTestIdentity();

    const [first, second] = await Promise.all([
      tryPairOverTls('127.0.0.1', satPort, pin, identity),
      tryPairOverTls('127.0.0.1', satPort, pin, identity),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(await currentPin()).not.toBe(pin);
  });

  test('concurrent pairing of two identities with one PIN: one pairs, the other gets 410 pin_used', async () => {
    const pin = await currentPin();

    const replies = await Promise.all([
      tryPairOverTls('127.0.0.1', satPort, pin, generateTestIdentity()),
      tryPairOverTls('127.0.0.1', satPort, pin, generateTestIdentity()),
    ]);

    expect(replies.map((r) => r.status).sort()).toEqual([200, 410]);
    const refused = replies.find((r) => r.status === 410)!;
    expect(refused.body).toMatchObject({ error: 'pin_used', message: expect.any(String) });
  });
});
