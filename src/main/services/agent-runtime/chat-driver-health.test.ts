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

  it('keeps a pause while the binary is unchanged and drops it when the binary is replaced at the same path', () => {
    const { bin, done } = tempBinary();
    const key = driverHealthKey(new FakeChatDriver(), bin);
    const t0 = 1_000_000;
    for (let i = 0; i < DRIVER_FAILURE_THRESHOLD; i++) recordDriverFailure(key, 'session start failed: boom', t0, bin);
    expect(driverPausedReason(key, t0 + 1, bin)).toBe('session start failed: boom');
    // Same binary: still paused, and the cooldown still ends it.
    expect(driverPausedReason(key, t0 + 2, bin)).toBe('session start failed: boom');
    expect(driverPausedReason(key, t0 + DRIVER_PAUSE_MS, bin)).toBeUndefined();
    // A fixed install at the same path is tried before the cooldown ends.
    fs.writeFileSync(bin, 'v2-fixed');
    fs.utimesSync(bin, new Date(), new Date(Date.now() + 60_000));
    expect(driverPausedReason(key, t0 + 3, bin)).toBeUndefined();
    // Its old failures are gone: it starts a fresh count.
    for (let i = 1; i < DRIVER_FAILURE_THRESHOLD; i++) recordDriverFailure(key, 'still broken', t0 + 4, bin);
    expect(driverPausedReason(key, t0 + 5, bin)).toBeUndefined();
    recordDriverFailure(key, 'still broken', t0 + 4, bin);
    expect(driverPausedReason(key, t0 + 5, bin)).toBe('still broken');
    done();
  });

  it('a replaced binary clears only its own key\'s pause', () => {
    const { bin, done } = tempBinary();
    const driver = new FakeChatDriver();
    const a = driverHealthKey(driver, bin, { CLAUDE_CONFIG_DIR: 'a' });
    const b = driverHealthKey(driver, 'other-bin', { CLAUDE_CONFIG_DIR: 'b' });
    const t0 = 1_000_000;
    for (let i = 0; i < DRIVER_FAILURE_THRESHOLD; i++) {
      recordDriverFailure(a, 'a broken', t0, bin);
      recordDriverFailure(b, 'b broken', t0);
    }
    fs.writeFileSync(bin, 'v2-fixed');
    expect(driverPausedReason(a, t0 + 1, bin)).toBeUndefined();
    expect(driverPausedReason(b, t0 + 1)).toBe('b broken');
    done();
  });

  it('re-probes a binary replaced while paused, and its failures pause the new binary', async () => {
    const { bin, done } = tempBinary();
    const driver = new FakeChatDriver();
    const key = driverHealthKey(driver, bin);
    let probes = 0;
    driver.probe = async () => { probes++; return { handshakeOk: false, capabilities: driver.capabilities, error: 'boom' }; };
    for (let i = 0; i < DRIVER_FAILURE_THRESHOLD; i++) await probeDriver(driver, bin);
    expect(driverPausedReason(key, Date.now(), bin)).toBe('handshake failed: boom');
    fs.writeFileSync(bin, 'v2-fixed');
    fs.utimesSync(bin, new Date(), new Date(Date.now() + 60_000));
    // The pause check and the probe cache agree the binary changed.
    expect(driverPausedReason(key, Date.now(), bin)).toBeUndefined();
    driver.probe = async () => { probes++; return { handshakeOk: true, cliVersion: '2.1.300', capabilities: driver.capabilities }; };
    expect((await probeDriver(driver, bin)).handshakeOk).toBe(true);
    expect(probes).toBe(DRIVER_FAILURE_THRESHOLD + 1);
    done();
  });

  it('re-probes a cached binary replaced with the same mtime', async () => {
    const { bin, done } = tempBinary();
    const driver = new FakeChatDriver();
    let probes = 0;
    driver.probe = async () => { probes++; return { handshakeOk: true, cliVersion: '2.1.300', capabilities: driver.capabilities }; };
    await probeDriver(driver, bin);
    const { atime, mtime } = fs.statSync(bin);
    fs.writeFileSync(bin, 'v2-longer');
    fs.utimesSync(bin, atime, mtime);
    await probeDriver(driver, bin);
    expect(probes).toBe(2);
    done();
  });

  it('shares one probe among concurrent callers after a replacement, without handing them the old binary\'s probe', async () => {
    const { bin, done } = tempBinary();
    const driver = new FakeChatDriver();
    const key = driverHealthKey(driver, bin);
    const releases: Array<(ok: boolean) => void> = [];
    driver.probe = () => new Promise((resolve) => {
      releases.push((ok) => resolve(ok
        ? { handshakeOk: true, cliVersion: '2.1.300', capabilities: driver.capabilities }
        : { handshakeOk: false, capabilities: driver.capabilities, error: 'old binary' }));
    });
    const oldProbe = probeDriver(driver, bin);
    fs.writeFileSync(bin, 'v2-fixed');
    const burst = Array.from({ length: 5 }, () => probeDriver(driver, bin));
    await new Promise((r) => setImmediate(r));
    expect(releases).toHaveLength(2);
    releases[1](true);
    expect((await Promise.all(burst)).every((r) => r.handshakeOk)).toBe(true);
    // The old binary's late failure neither pauses nor evicts the new one.
    releases[0](false);
    expect((await oldProbe).handshakeOk).toBe(false);
    expect(driverPausedReason(key, Date.now(), bin)).toBeUndefined();
    await probeDriver(driver, bin);
    expect(releases).toHaveLength(2);
    done();
  });

  it('drops failures recorded while the binary could not be read once it can be', () => {
    const { bin, done } = tempBinary();
    const key = driverHealthKey(new FakeChatDriver(), bin);
    const t0 = 1_000_000;
    fs.rmSync(bin);
    for (let i = 0; i < DRIVER_FAILURE_THRESHOLD; i++) recordDriverFailure(key, 'missing', t0, bin);
    expect(driverPausedReason(key, t0 + 1, bin)).toBe('missing');
    fs.writeFileSync(bin, 'v2');
    expect(driverPausedReason(key, t0 + 1, bin)).toBeUndefined();
    done();
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
