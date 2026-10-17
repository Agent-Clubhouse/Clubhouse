import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
import { appLog } from '../log-service';
import { ATTR } from '../../../shared/telemetry/attributes';
import { FakeChatDriver } from './fake-chat-driver';
import {
  DRIVER_FAILURE_THRESHOLD,
  DRIVER_PAUSE_MS,
  clearDriverHealth,
  driverHealthKey,
  driverPausedReason,
  probeDriver,
  recordDriverFailure,
  recordDriverSuccess,
} from './chat-driver-health';

afterEach(() => clearDriverHealth());
beforeEach(() => vi.clearAllMocks());

function tempBinary(): { bin: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-probe-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, 'v1');
  return { bin, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('chat driver health', () => {
  it('logs one failed probe with local diagnostics and only bounded telemetry fields', async () => {
    const driver = new FakeChatDriver('codex_app_server');
    driver.probe = async () => ({
      handshakeOk: false, capabilities: driver.capabilities,
      error: 'private stderr /private/install', errorCode: 'spawn_failed',
    });
    await Promise.all(Array.from({ length: 3 }, () => probeDriver(driver, '/private/codex', { SECRET_TOKEN: 'secret-value' })));
    expect(appLog).toHaveBeenCalledTimes(1);
    expect(appLog).toHaveBeenCalledWith('core:chat', 'warn', 'Chat handshake probe failed', {
      meta: {
        driver: driver.id, provider: driver.provider, binary: '/private/codex',
        elapsedMs: expect.any(Number), error: 'private stderr /private/install', errorCode: 'spawn_failed',
      },
      telemetry: {
        event: 'clubhouse.chat.probe_failed',
        attrs: [ATTR.chatDriver('codex_app_server'), ATTR.errorType('spawn_failed')],
      },
    });
    expect(JSON.stringify(vi.mocked(appLog).mock.calls)).not.toContain('secret-value');
  });

  it('pauses a key after repeated failures, then lets it try again', () => {
    const t0 = 1_000_000;
    const key = 'k';
    for (let i = 1; i < DRIVER_FAILURE_THRESHOLD; i++) recordDriverFailure(key, `fail ${i}`, t0);
    expect(driverPausedReason(key, t0)).toBeUndefined();
    recordDriverFailure(key, 'handshake failed: boom', t0);
    expect(driverPausedReason(key, t0 + 1)).toBe('handshake failed: boom');
    expect(driverPausedReason('other', t0 + 1)).toBeUndefined();
    expect(driverPausedReason(key, t0 + DRIVER_PAUSE_MS)).toBeUndefined();
    // Another failure after the pause pauses it again; a success clears it.
    recordDriverFailure(key, 'again', t0 + DRIVER_PAUSE_MS);
    expect(driverPausedReason(key, t0 + DRIVER_PAUSE_MS + 1)).toBe('again');
    recordDriverSuccess(key);
    expect(driverPausedReason(key, t0 + DRIVER_PAUSE_MS + 1)).toBeUndefined();
  });

  it('keys health by driver, binary and profile env', () => {
    const d = new FakeChatDriver('claude_agent_sdk');
    const a = driverHealthKey(d, 'bin', { CLAUDE_CONFIG_DIR: 'one' });
    expect(driverHealthKey(d, 'bin', { CLAUDE_CONFIG_DIR: 'one' })).toBe(a);
    expect(driverHealthKey(d, 'bin', { CLAUDE_CONFIG_DIR: 'two' })).not.toBe(a);
    expect(driverHealthKey(d, 'other-bin', { CLAUDE_CONFIG_DIR: 'one' })).not.toBe(a);
    expect(driverHealthKey(new FakeChatDriver('claude_stream_json'), 'bin', { CLAUDE_CONFIG_DIR: 'one' })).not.toBe(a);
    expect(driverHealthKey(d, 'bin', { B: '1', A: '2' })).toBe(driverHealthKey(d, 'bin', { A: '2', B: '1' }));
    expect(driverHealthKey(d, 'bin', {})).toBe(driverHealthKey(d, 'bin'));
  });

  it('caches a successful probe until the binary changes', async () => {
    const { bin, done } = tempBinary();
    const driver = new FakeChatDriver();
    let probes = 0;
    driver.probe = async () => { probes++; return { handshakeOk: true, cliVersion: '2.1.300', capabilities: driver.capabilities }; };
    await probeDriver(driver, bin);
    await probeDriver(driver, bin);
    expect(probes).toBe(1);
    fs.utimesSync(bin, new Date(), new Date(Date.now() + 60_000));
    await probeDriver(driver, bin);
    expect(probes).toBe(2);
    // A different profile env is a different key.
    await probeDriver(driver, bin, { CLAUDE_CONFIG_DIR: 'x' });
    expect(probes).toBe(3);
    done();
  });

  it('shares one in-flight probe between concurrent callers and counts one failure', async () => {
    const { bin, done } = tempBinary();
    const driver = new FakeChatDriver();
    let probes = 0;
    let release!: () => void;
    driver.probe = () => {
      probes++;
      return new Promise((resolve) => { release = () => resolve({ handshakeOk: false, capabilities: driver.capabilities, error: 'boom' }); });
    };
    const burst = Array.from({ length: 10 }, () => probeDriver(driver, bin));
    await new Promise((r) => setImmediate(r));
    release();
    const results = await Promise.all(burst);
    expect(probes).toBe(1);
    expect(results.every((r) => !r.handshakeOk)).toBe(true);
    expect(driverPausedReason(driverHealthKey(driver, bin))).toBeUndefined();
    // Separate failed probes do add up.
    driver.probe = async () => ({ handshakeOk: false, capabilities: driver.capabilities, error: 'boom' });
    for (let i = 1; i < DRIVER_FAILURE_THRESHOLD; i++) await probeDriver(driver, bin);
    expect(driverPausedReason(driverHealthKey(driver, bin))).toBe('handshake failed: boom');
    done();
  });

  it('keys health by command prefix too, and probes through it', async () => {
    const { bin, done } = tempBinary();
    const d = new FakeChatDriver();
    expect(driverHealthKey(d, 'bin', undefined, 'wsl -e')).not.toBe(driverHealthKey(d, 'bin'));
    const calls: unknown[][] = [];
    d.probe = async (...args: unknown[]) => { calls.push(args); return { handshakeOk: true, capabilities: d.capabilities }; };
    await probeDriver(d, bin, { A: '1' }, 'wsl -e');
    expect(calls).toEqual([[bin, { A: '1' }, { commandPrefix: 'wsl -e' }]]);
    done();
  });

  it('neither caches nor counts a probe that needs a login, so logging in takes effect next time', async () => {
    const { bin, done } = tempBinary();
    const driver = new FakeChatDriver();
    let probes = 0;
    driver.probe = async () => { probes++; return { handshakeOk: true, needsLogin: true, loginHint: 'Run codex login', capabilities: driver.capabilities }; };
    for (let i = 0; i < DRIVER_FAILURE_THRESHOLD + 1; i++) await probeDriver(driver, bin);
    expect(probes).toBe(DRIVER_FAILURE_THRESHOLD + 1);
    expect(driverPausedReason(driverHealthKey(driver, bin))).toBeUndefined();
    done();
  });

  it('treats a throwing probe as a failed handshake', async () => {
    const driver = new FakeChatDriver();
    driver.probe = async () => { throw new Error('spawn ENOENT'); };
    expect(await probeDriver(driver, path.join(os.tmpdir(), 'clubhouse-missing-claude'))).toMatchObject({ handshakeOk: false, error: 'spawn ENOENT' });
  });
});
