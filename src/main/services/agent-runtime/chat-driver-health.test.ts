import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChatDriver } from './fake-chat-driver';
import {
  DRIVER_FAILURE_THRESHOLD,
  DRIVER_PAUSE_MS,
  clearDriverHealth,
  driverPausedReason,
  probeDriver,
  recordDriverFailure,
  recordDriverSuccess,
} from './chat-driver-health';

afterEach(() => clearDriverHealth());

describe('chat driver health', () => {
  it('pauses a driver after repeated failures, then lets it try again', () => {
    const t0 = 1_000_000;
    for (let i = 1; i < DRIVER_FAILURE_THRESHOLD; i++) recordDriverFailure('claude_agent_sdk', `fail ${i}`, t0);
    expect(driverPausedReason('claude_agent_sdk', t0)).toBeUndefined();
    recordDriverFailure('claude_agent_sdk', 'handshake failed: boom', t0);
    expect(driverPausedReason('claude_agent_sdk', t0 + 1)).toBe('handshake failed: boom');
    expect(driverPausedReason('claude_stream_json', t0 + 1)).toBeUndefined();
    expect(driverPausedReason('claude_agent_sdk', t0 + DRIVER_PAUSE_MS)).toBeUndefined();
    // Another failure after the pause pauses it again; a success clears it.
    recordDriverFailure('claude_agent_sdk', 'again', t0 + DRIVER_PAUSE_MS);
    expect(driverPausedReason('claude_agent_sdk', t0 + DRIVER_PAUSE_MS + 1)).toBe('again');
    recordDriverSuccess('claude_agent_sdk');
    expect(driverPausedReason('claude_agent_sdk', t0 + DRIVER_PAUSE_MS + 1)).toBeUndefined();
  });

  it('caches a successful probe until the binary changes, and counts failed probes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-probe-'));
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, 'v1');
    const driver = new FakeChatDriver();
    let probes = 0;
    let ok = true;
    driver.probe = async () => { probes++; return ok ? { handshakeOk: true, cliVersion: '2.1.300', capabilities: driver.capabilities } : { handshakeOk: false, capabilities: driver.capabilities, error: 'boom' }; };

    await probeDriver(driver, bin);
    await probeDriver(driver, bin);
    expect(probes).toBe(1);
    fs.utimesSync(bin, new Date(), new Date(Date.now() + 60_000));
    await probeDriver(driver, bin);
    expect(probes).toBe(2);

    ok = false;
    fs.utimesSync(bin, new Date(), new Date(Date.now() + 120_000));
    for (let i = 0; i < DRIVER_FAILURE_THRESHOLD; i++) expect((await probeDriver(driver, bin)).handshakeOk).toBe(false);
    expect(driverPausedReason(driver.id)).toBe('handshake failed: boom');

    driver.probe = async () => { throw new Error('spawn ENOENT'); };
    expect(await probeDriver(driver, path.join(dir, 'missing'))).toMatchObject({ handshakeOk: false, error: 'spawn ENOENT' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
