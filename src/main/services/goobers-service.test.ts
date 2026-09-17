import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: '' })),
}));

const { mockGetAllWindows, mockAppOn } = vi.hoisted(() => ({
  mockGetAllWindows: vi.fn(() => []),
  mockAppOn: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: mockGetAllWindows },
  app: { on: mockAppOn },
}));

// Wraps the real implementations by default — every existing test in this
// file drives probeLiveness/startDaemon/stopDaemon through real fs (no
// scheduler/api.address ⇒ 'not-running') and never needed these mocked.
// Only the auth-required describe block below overrides them per-test.
vi.mock('./goobers-liveness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./goobers-liveness')>();
  return { ...actual, probeLiveness: vi.fn(actual.probeLiveness) };
});
vi.mock('./goobers-daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./goobers-daemon')>();
  return { ...actual, startDaemon: vi.fn(actual.startDaemon), stopDaemon: vi.fn(actual.stopDaemon) };
});

import { getShellEnvironment } from '../util/shell';
import {
  GoobersService,
  validateInstanceRoot,
  resolveBinaryPath,
} from './goobers-service';
import { IPC } from '../../shared/ipc-channels';
import { probeLiveness } from './goobers-liveness';
import { startDaemon, stopDaemon } from './goobers-daemon';
import type { GoobersSettings } from '../../shared/types';
import type { ManagedSettings } from './managed-settings';
import type { LivenessSnapshot } from './goobers-liveness';

function visibleWindow() {
  return { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: { send: vi.fn() } };
}

/**
 * A real on-disk file's mode bits are a physical property of the host
 * OS/filesystem — mocking process.platform does NOT change what a real
 * fs.promises.stat() returns for .mode (e.g. NTFS never sets POSIX execute
 * bits, no matter what platform string the code checks), and chmodSync(0o755)
 * is a no-op on that front too. Any test that needs an "executable" binary
 * path MUST use this synthetic Stats object (or a path-scoped stat mock built
 * from it) instead of a real file + chmodSync — #1852 (M1) burned five CI
 * rounds on exactly this, and #1859 (M9) reproduced it by using a real file.
 */
function fakeStat(mode: number): fs.Stats {
  return { isFile: () => true, mode } as fs.Stats;
}

/**
 * Makes `fs.promises.stat(binaryPath)` report a synthetic executable file
 * (see `fakeStat` above) while leaving every other path's stat behavior on
 * the real filesystem — needed by tests that also drive `validateInstanceRoot`
 * against real on-disk fixtures (instance.yaml / .instance-decommissioned)
 * in the same call, where a blanket stat mock would falsely report the
 * decommissioned marker as present.
 */
function mockExecutableBinaryStat(binaryPath: string): void {
  const realStat = fs.promises.stat.bind(fs.promises);
  vi.spyOn(fs.promises, 'stat').mockImplementation(((candidate: fs.PathLike, ...rest: unknown[]) => {
    if (candidate === binaryPath) return Promise.resolve(fakeStat(0o100755));
    return (realStat as (...args: unknown[]) => Promise<fs.Stats>)(candidate, ...rest);
  }) as typeof fs.promises.stat);
}

function makeFakeSettings(initial: GoobersSettings): ManagedSettings<GoobersSettings> & { set: (s: GoobersSettings) => void } {
  let current = initial;
  const registered = { value: false };
  return {
    getSettings: () => current,
    saveSettings: async (s: GoobersSettings) => { current = s; },
    store: {} as ManagedSettings<GoobersSettings>['store'],
    register: () => { registered.value = true; },
    set: (s: GoobersSettings) => { current = s; },
  };
}

/** Real fs.promises calls chain several sequential awaits (stat, stat, readFile) —
 *  a single setImmediate can land between the first and second, so flush with
 *  a real timer instead of a microtask/next-tick. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function defaultSettings(overrides: Partial<GoobersSettings> = {}): GoobersSettings {
  return {
    instanceRoot: '',
    binaryPath: 'goobers',
    autoConnect: true,
    manageDaemon: false,
    ...overrides,
  };
}

let tmpRoot: string;
// Capture the real platform once — restoring a hardcoded 'darwin' here would
// permanently coerce process.platform away from its actual value on any
// non-macOS CI runner (e.g. Windows), breaking every later test that reads
// process.platform without mocking it itself.
const realPlatform = process.platform;

// Almost every test in this file exercises POSIX-supported-platform behavior
// (validateInstanceRoot, resolveBinaryPath's POSIX bitmask branch,
// GoobersService.isSupportedPlatform-gated activation) and never mocks
// process.platform itself — it must not inherit whatever platform the suite
// happens to actually be running on (win32 CI included). Pin a supported,
// non-win32 platform by default here; the few win32-specific tests
// (platform-gate describe block, resolveBinaryPath's "on win32" describe
// block) explicitly re-pin 'win32' as the first line of their own test body,
// which runs after this beforeEach and overrides it.
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goobers-service-test-'));
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  mockGetAllWindows.mockReset().mockReturnValue([]);
  mockAppOn.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  Object.defineProperty(process, 'platform', { value: realPlatform });
});

describe('validateInstanceRoot', () => {
  it('accepts a valid root and returns the .instance-id identity', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');

    const result = await validateInstanceRoot(tmpRoot);

    expect(result).toEqual({ ok: true, instanceId: 'eaf74575d8de50fa5471027ba7fd15cb' });
  });

  it('rejects a root with no instance.yaml, naming the exact missing file', async () => {
    const result = await validateInstanceRoot(tmpRoot);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not-a-goobers-instance-root');
    expect(result.error?.message).toContain('instance.yaml');
    expect(result.error?.message).toContain(tmpRoot);
  });

  it('rejects a decommissioned root', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-decommissioned'), '');

    const result = await validateInstanceRoot(tmpRoot);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('decommissioned-root');
  });

  it('uses .instance-id, never the sibling instance-id (no dot) file', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    // Different value on purpose — mirrors the reference instance (spec §4.2).
    fs.writeFileSync(path.join(tmpRoot, 'instance-id'), 'e86a94384664f7981488722ac46d2432\n');

    const result = await validateInstanceRoot(tmpRoot);
    expect(result.ok).toBe(true);
    expect(result.instanceId).toBe('eaf74575d8de50fa5471027ba7fd15cb');
    expect(result.instanceId).not.toBe('e86a94384664f7981488722ac46d2432');
  });

  it('rejects an unreadable .instance-id', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    const result = await validateInstanceRoot(tmpRoot);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('instance-id-unreadable');
  });
});

describe('resolveBinaryPath', () => {
  it('resolves an absolute, executable path', async () => {
    const binPath = path.join(tmpRoot, 'goobers-bin');
    vi.spyOn(fs.promises, 'stat').mockResolvedValue(fakeStat(0o100755));

    const result = await resolveBinaryPath(binPath);
    expect(result).toEqual({ resolved: binPath });
  });

  it('rejects an absolute, non-executable path', async () => {
    const binPath = path.join(tmpRoot, 'goobers-bin');
    vi.spyOn(fs.promises, 'stat').mockResolvedValue(fakeStat(0o100644));

    const result = await resolveBinaryPath(binPath);
    expect(result.resolved).toBeNull();
    expect(result.error?.code).toBe('binary-not-executable');
  });

  it('rejects an absolute path that does not exist', async () => {
    const result = await resolveBinaryPath(path.join(tmpRoot, 'nope'));
    expect(result.resolved).toBeNull();
    expect(result.error?.code).toBe('binary-not-found');
  });

  it('resolves a bare name found on PATH', async () => {
    const binPath = path.join(tmpRoot, 'goobers');
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (candidate) => {
      if (candidate === binPath) return fakeStat(0o100755);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    vi.mocked(getShellEnvironment).mockReturnValue({ PATH: tmpRoot });

    const result = await resolveBinaryPath('goobers');
    expect(result).toEqual({ resolved: binPath });
  });

  it('reports not-found for a bare name absent from PATH', async () => {
    vi.mocked(getShellEnvironment).mockReturnValue({ PATH: tmpRoot });

    const result = await resolveBinaryPath('goobers');
    expect(result.resolved).toBeNull();
    expect(result.error?.code).toBe('binary-not-found');
  });

  describe('on win32', () => {
    // fs.Stats.mode on Windows is derived from the read-only file attribute,
    // never a POSIX execute bit — `mode & 0o111` is always 0 there. Any
    // regular file must resolve as executable-enough on win32.
    it('resolves an absolute path without a POSIX executable bit', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const binPath = path.join(tmpRoot, 'goobers.exe');
      fs.writeFileSync(binPath, 'not posix-executable', { mode: 0o644 });

      const result = await resolveBinaryPath(binPath);
      expect(result).toEqual({ resolved: binPath });
    });

    it('resolves a bare name found on PATH without a POSIX executable bit', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const binPath = path.join(tmpRoot, 'goobers.exe');
      fs.writeFileSync(binPath, 'not posix-executable', { mode: 0o644 });
      vi.mocked(getShellEnvironment).mockReturnValue({ PATH: tmpRoot });

      const result = await resolveBinaryPath('goobers.exe');
      expect(result).toEqual({ resolved: binPath });
    });

    it('still reports not-found for a path that does not exist', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });

      const result = await resolveBinaryPath(path.join(tmpRoot, 'nope.exe'));
      expect(result.resolved).toBeNull();
      expect(result.error?.code).toBe('binary-not-found');
    });
  });
});

describe('GoobersService — idle-until-subscribed (§7.7)', () => {
  it('does zero fs work before the first subscribe', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    const statSpy = vi.spyOn(fs.promises, 'stat');
    const readFileSpy = vi.spyOn(fs.promises, 'readFile');

    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot }));
    const service = new GoobersService(settings);

    // Constructing the service must not touch disk.
    expect(statSpy).not.toHaveBeenCalled();
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(service.getState().connection).toBe('idle');

    service.subscribe();
    // Activation is async — flush microtasks.
    await flush();

    expect(statSpy).toHaveBeenCalled();
    expect(readFileSpy).toHaveBeenCalled();
    expect(service.getState().rootIdentity).toBe('eaf74575d8de50fa5471027ba7fd15cb');
  });

  it('activates only once across repeated subscribe() calls (ref-counted, not re-triggered)', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    const statSpy = vi.spyOn(fs.promises, 'stat');

    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot }));
    const service = new GoobersService(settings);

    service.subscribe();
    service.subscribe();
    service.subscribe();
    await flush();

    expect(service.subscriberCountForTests).toBe(3);
    // Guards against this assertion passing trivially at 0 === 0 if
    // activation never ran (e.g. an unsupported-platform false negative).
    expect(statSpy.mock.calls.length).toBeGreaterThan(0);
    expect(service.reconcileCountForTests).toBe(1);
    const callsAfterThreeSubscribes = statSpy.mock.calls.length;

    // A 4th subscribe should not re-run validation.
    service.subscribe();
    await flush();
    expect(statSpy.mock.calls.length).toBe(callsAfterThreeSubscribes);
    expect(service.reconcileCountForTests).toBe(1);
    expect(service.subscriberCountForTests).toBe(4);
  });

  it('release() decrements the ref count without going negative', () => {
    const settings = makeFakeSettings(defaultSettings());
    const service = new GoobersService(settings);

    service.subscribe();
    service.subscribe();
    expect(service.subscriberCountForTests).toBe(2);

    service.release();
    expect(service.subscriberCountForTests).toBe(1);

    service.release();
    service.release();
    expect(service.subscriberCountForTests).toBe(0);
  });

  it('reports unconfigured state (no I/O) when instanceRoot is empty', async () => {
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: '' }));
    const service = new GoobersService(settings);

    service.subscribe();
    await flush();

    // The constructor's initial state is already { configured: false,
    // connection: 'idle' } — assert reconcile() genuinely ran (which
    // requires a supported platform) rather than asserting only on a
    // state shape indistinguishable from "never activated".
    expect(service.reconcileCountForTests).toBe(1);
    expect(service.getState().configured).toBe(false);
    expect(service.getState().connection).toBe('idle');
  });

  it('surfaces an invalid root as a connection error', async () => {
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot }));
    const service = new GoobersService(settings);

    service.subscribe();
    await flush();

    expect(service.getState().connection).toBe('error');
    expect(service.getState().lastError?.code).toBe('not-a-goobers-instance-root');
  });

  it('surfaces instance name/environment from an optional config/manifest.yaml on a valid root', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    fs.mkdirSync(path.join(tmpRoot, 'config'));
    fs.writeFileSync(
      path.join(tmpRoot, 'config', 'manifest.yaml'),
      'spec:\n  instance:\n    name: goobers-local\n    environment: dev\n',
    );
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot }));
    const service = new GoobersService(settings);

    service.subscribe();
    await flush();

    expect(service.getState().instanceName).toBe('goobers-local');
    expect(service.getState().instanceEnvironment).toBe('dev');
  });

  it('leaves instance name/environment null (not an error) when config/manifest.yaml is absent', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot }));
    const service = new GoobersService(settings);

    service.subscribe();
    await flush();

    expect(service.getState().instanceName).toBeNull();
    expect(service.getState().instanceEnvironment).toBeNull();
    expect(service.getState().connection).not.toBe('error');
  });
});

describe('GoobersService — platform gate (§7.8)', () => {
  it('never activates on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    const statSpy = vi.spyOn(fs.promises, 'stat');

    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot }));
    const service = new GoobersService(settings);

    expect(service.isSupportedPlatform).toBe(false);
    service.subscribe();
    await flush();

    expect(statSpy).not.toHaveBeenCalled();
    expect(service.reconcileCountForTests).toBe(0);
  });

  it('connect() returns an unsupported-platform error envelope on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const settings = makeFakeSettings(defaultSettings());
    const service = new GoobersService(settings);

    const result = await service.connect();
    expect(result).toEqual({ error: { code: 'unsupported-platform', message: expect.any(String) } });
  });

  it('disconnect() returns an unsupported-platform error envelope on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const settings = makeFakeSettings(defaultSettings());
    const service = new GoobersService(settings);

    const result = service.disconnect();
    expect(result).toEqual({ error: { code: 'unsupported-platform', message: expect.any(String) } });
  });
});

describe('GoobersService — settings-change transitions (§4.1)', () => {
  it('re-validates when instanceRoot changes after activation', async () => {
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: '' }));
    const service = new GoobersService(settings);

    service.subscribe();
    await flush();
    expect(service.getState().configured).toBe(false);

    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    const next = defaultSettings({ instanceRoot: tmpRoot });
    settings.set(next);
    // Simulates the createManagedSettings onSave callback firing after a save
    // (the fake settings double doesn't wire that plumbing itself).
    (service as unknown as { onSettingsChanged: (s: GoobersSettings) => void }).onSettingsChanged(next);
    await flush();

    expect(service.getState().configured).toBe(true);
    expect(service.getState().rootIdentity).toBe('eaf74575d8de50fa5471027ba7fd15cb');
    expect(service.reconcileCountForTests).toBe(2);
  });

  it('does nothing before activation (idle service ignores settings saves)', async () => {
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: '' }));
    const service = new GoobersService(settings);

    const next = defaultSettings({ instanceRoot: tmpRoot });
    (service as unknown as { onSettingsChanged: (s: GoobersSettings) => void }).onSettingsChanged(next);
    await flush();

    expect(service.subscriberCountForTests).toBe(0);
    expect(service.reconcileCountForTests).toBe(0);
    expect(service.getState().connection).toBe('idle');
  });

  it('clears cached instance/health state on an instanceRoot change, asserted directly on getState()', async () => {
    // Start "connected" to a fake prior root by hand-installing state, then
    // change instanceRoot to a different (unconfigured) value and assert the
    // previous root's Instance/Health never survive into the new state.
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot }));
    const service = new GoobersService(settings);
    service.subscribe();
    await flush();

    (service as unknown as { state: unknown }).state = {
      ...service.getState(),
      instance: { name: 'old-instance' },
      health: { ready: true },
      rootIdentity: 'deadbeefdeadbeefdeadbeefdeadbeef',
    };
    expect(service.getState().instance).not.toBeNull();

    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goobers-service-other-'));
    const next = defaultSettings({ instanceRoot: otherRoot });
    settings.set(next);
    (service as unknown as { onSettingsChanged: (s: GoobersSettings) => void }).onSettingsChanged(next);
    await flush();

    expect(service.getState().instance).toBeNull();
    expect(service.getState().health).toBeNull();
    expect(service.getState().rootIdentity).not.toBe('deadbeefdeadbeefdeadbeefdeadbeef');
    fs.rmSync(otherRoot, { recursive: true, force: true });
  });
});

/**
 * M11: a binaryPath change that now resolves successfully left the *previous*
 * binary-not-found/binary-not-executable error sitting in `lastError`
 * (`result.error ?? this.state.lastError` never falls through to `null` on
 * success) and never broadcast the update, so the renderer kept showing a
 * stale, self-contradictory message — the new resolved name next to the old
 * error text. Reproduced live via the actual Settings → Goobers Binary field
 * before this fix, not just through the settings IPC bridge.
 */
describe('GoobersService — binaryPath re-resolution clears stale errors and broadcasts (M11)', () => {
  function fakeStat(mode: number): fs.Stats {
    return { isFile: () => true, mode } as fs.Stats;
  }

  it('clears a stale binary-not-found error once the corrected binaryPath resolves', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    const goodBin = path.join(tmpRoot, 'goobers-bin');
    const realStat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (p) => {
      if (p === goodBin) return fakeStat(0o100755);
      return realStat(p as fs.PathLike);
    });

    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot, binaryPath: 'definitely-not-goobers' }));
    const service = new GoobersService(settings);
    service.subscribe();
    await flush();

    expect(service.getState().lastError?.code).toBe('binary-not-found');
    expect(service.getState().lastError?.message).toContain('definitely-not-goobers');

    const next = defaultSettings({ instanceRoot: tmpRoot, binaryPath: goodBin });
    settings.set(next);
    (service as unknown as { onSettingsChanged: (s: GoobersSettings) => void }).onSettingsChanged(next);
    await flush();

    expect(service.getState().lastError).toBeNull();
  });

  it('broadcasts the corrected state to all windows once binaryPath resolves', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    const goodBin = path.join(tmpRoot, 'goobers-bin');
    const realStat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (p) => {
      if (p === goodBin) return fakeStat(0o100755);
      return realStat(p as fs.PathLike);
    });

    const send = vi.fn();
    mockGetAllWindows.mockReturnValue([{ ...visibleWindow(), webContents: { send } }]);

    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot, binaryPath: 'definitely-not-goobers' }));
    const service = new GoobersService(settings);
    service.subscribe();
    await flush();
    send.mockClear(); // only care about the broadcast from the binaryPath fix below

    const next = defaultSettings({ instanceRoot: tmpRoot, binaryPath: goodBin });
    settings.set(next);
    (service as unknown as { onSettingsChanged: (s: GoobersSettings) => void }).onSettingsChanged(next);
    await flush();

    expect(send).toHaveBeenCalledWith(IPC.GOOBERS.STATE_CHANGED, expect.objectContaining({ lastError: null }));
  });

  it('leaves an unrelated lastError (e.g. an invalid root) untouched when only binaryPath changes', async () => {
    // instanceRoot never contains instance.yaml — stays invalid the whole test.
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot, binaryPath: 'goobers' }));
    const service = new GoobersService(settings);
    service.subscribe();
    await flush();

    expect(service.getState().lastError?.code).toBe('not-a-goobers-instance-root');

    const next = defaultSettings({ instanceRoot: tmpRoot, binaryPath: 'still-not-goobers' });
    settings.set(next);
    (service as unknown as { onSettingsChanged: (s: GoobersSettings) => void }).onSettingsChanged(next);
    await flush();

    // The binaryPath re-resolution branch must not clobber a root error that
    // has nothing to do with it.
    expect(service.getState().lastError?.code).toBe('not-a-goobers-instance-root');
  });
});

/**
 * M12: `goobers:get-state` calls `subscribe()` then returns `getState()`
 * synchronously; `subscribe()` fires `reconcile()` unawaited, so that first
 * read is always the pre-activation idle snapshot regardless of what's
 * actually saved. `reconcile()` mutated `this.state` on every exit path but
 * never broadcast, so nothing corrected a subscribed renderer once
 * activation genuinely settled — the panel showed "Not configured"
 * indefinitely, self-correcting only by accident on `[refresh]`, which
 * merely re-invoked getState() after reconcile happened to have finished.
 * Pin a broadcast on every exit path, not just the happy one — that absence
 * is exactly why the bug was invisible before.
 */
describe('GoobersService — reconcile() always broadcasts on every exit path (M12)', () => {
  function lastSendCall(send: ReturnType<typeof vi.fn>): unknown[] | undefined {
    const calls = send.mock.calls.filter((c) => c[0] === IPC.GOOBERS.STATE_CHANGED);
    return calls[calls.length - 1];
  }

  it('broadcasts when the platform is unsupported', async () => {
    // subscribe()/connect() both gate on isSupportedPlatform before ever
    // calling reconcile() on win32 (§7.8 — see the platform-gate describe
    // block above), so this branch is unreachable through the public API in
    // real usage. Exercise reconcile() directly, the same test-only-accessor
    // pattern used elsewhere in this file for private methods, to pin its
    // own broadcast-on-every-path contract regardless of how it's reached.
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const send = vi.fn();
    mockGetAllWindows.mockReturnValue([{ ...visibleWindow(), webContents: { send } }]);

    const settings = makeFakeSettings(defaultSettings());
    const service = new GoobersService(settings);
    await (service as unknown as { reconcile: (s: GoobersSettings) => Promise<void> }).reconcile(settings.getSettings());

    const call = lastSendCall(send);
    expect(call).toBeDefined();
    expect((call![1] as { lastError: { code: string } | null }).lastError?.code).toBe('unsupported-platform');
  });

  it('broadcasts when instanceRoot is empty', async () => {
    const send = vi.fn();
    mockGetAllWindows.mockReturnValue([{ ...visibleWindow(), webContents: { send } }]);

    const settings = makeFakeSettings(defaultSettings({ instanceRoot: '' }));
    const service = new GoobersService(settings);
    service.subscribe();
    await flush();

    const call = lastSendCall(send);
    expect(call).toBeDefined();
    expect((call![1] as { configured: boolean }).configured).toBe(false);
  });

  it('broadcasts when the root is invalid', async () => {
    const send = vi.fn();
    mockGetAllWindows.mockReturnValue([{ ...visibleWindow(), webContents: { send } }]);

    // tmpRoot has no instance.yaml — invalid by construction.
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot }));
    const service = new GoobersService(settings);
    service.subscribe();
    await flush();

    const call = lastSendCall(send);
    expect(call).toBeDefined();
    expect((call![1] as { lastError: { code: string } | null }).lastError?.code).toBe('not-a-goobers-instance-root');
  });

  it('broadcasts the settled state on the daemon-down success path (establishConnection -> watchAddressFile)', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    fs.mkdirSync(path.join(tmpRoot, 'scheduler'), { recursive: true });
    const binPath = path.join(tmpRoot, 'goobers-bin');
    mockExecutableBinaryStat(binPath);

    const send = vi.fn();
    mockGetAllWindows.mockReturnValue([{ ...visibleWindow(), webContents: { send } }]);

    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot, binaryPath: binPath }));
    const service = new GoobersService(settings);
    service.subscribe();
    await flush();

    // This is the exact scenario M12 was invisible in: a valid, configured
    // root with the daemon down — reconcile() settles via
    // establishConnection() -> watchAddressFile(), a path with no broadcast
    // of its own.
    const call = lastSendCall(send);
    expect(call).toBeDefined();
    const broadcastState = call![1] as { configured: boolean; instanceRoot: string | null; daemon: { state: string } };
    expect(broadcastState.configured).toBe(true);
    expect(broadcastState.instanceRoot).toBe(tmpRoot);
    expect(broadcastState.daemon.state).toBe('not-running');
    // And the broadcast state must match what a subsequent getState() read
    // would return — no drift between the two.
    expect(service.getState()).toEqual(broadcastState);
  });
});

describe('GoobersService — registerSettings addendum (registerSettings() called from two places)', () => {
  it('handles an instanceRoot change exactly once end-to-end no matter how many times registerSettings() ran', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');

    const settings = makeFakeSettings(defaultSettings({ instanceRoot: '' }));
    const service = new GoobersService(settings);

    // Simulate settings-handlers.ts registering eagerly at startup, before
    // any subscribe() — then activate() registers again post-subscribe.
    service.registerSettings();
    service.registerSettings();
    service.registerSettings();

    service.subscribe();
    await flush();
    expect(service.reconcileCountForTests).toBe(1);

    const next = defaultSettings({ instanceRoot: tmpRoot });
    settings.set(next);
    (service as unknown as { onSettingsChanged: (s: GoobersSettings) => void }).onSettingsChanged(next);
    await flush();

    // Exactly one additional reconcile — not two or three, regardless of
    // how many times registerSettings() was called beforehand.
    expect(service.reconcileCountForTests).toBe(2);
    expect(service.getState().rootIdentity).toBe('eaf74575d8de50fa5471027ba7fd15cb');
  });
});

describe('GoobersService — polling suspend/resume (§7.7)', () => {
  it('does not start polling or watching when no window is visible', async () => {
    mockGetAllWindows.mockReturnValue([]); // no visible windows
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot }));
    const service = new GoobersService(settings);

    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');

    service.subscribe();
    await flush();

    expect(service.isPollingForTests).toBe(false);
    expect(service.isWatchingAddressFileForTests).toBe(false);
  });

  it('watches the address file when subscribed and a window is visible, and stops on release()', async () => {
    mockGetAllWindows.mockReturnValue([visibleWindow()]);
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    fs.mkdirSync(path.join(tmpRoot, 'scheduler'), { recursive: true });

    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot }));
    const service = new GoobersService(settings);

    service.subscribe();
    await flush();

    expect(service.isWatchingAddressFileForTests).toBe(true);

    service.release();
    expect(service.isWatchingAddressFileForTests).toBe(false);
  });

  it('registers a before-quit teardown handler and clears the watcher/poll interval on teardown()', async () => {
    mockGetAllWindows.mockReturnValue([visibleWindow()]);
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    fs.mkdirSync(path.join(tmpRoot, 'scheduler'), { recursive: true });

    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot }));
    const service = new GoobersService(settings);

    service.subscribe();
    await flush();
    expect(service.isWatchingAddressFileForTests).toBe(true);
    expect(mockAppOn).toHaveBeenCalledWith('before-quit', expect.any(Function));

    (service as unknown as { teardown: () => void }).teardown();
    expect(service.isWatchingAddressFileForTests).toBe(false);
    expect(service.isPollingForTests).toBe(false);
  });
});

describe('GoobersService — daemon control gating', () => {
  it('daemonStart refuses when manageDaemon is off', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot, manageDaemon: false }));
    const service = new GoobersService(settings);

    service.subscribe();
    await flush();

    const result = await service.daemonStart();
    expect(result).toEqual({ ok: false, error: 'daemon-control-disabled' });
  });

  it('daemonStop refuses when manageDaemon is off', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot, manageDaemon: false }));
    const service = new GoobersService(settings);

    service.subscribe();
    await flush();

    const result = await service.daemonStop();
    expect(result).toEqual({ ok: false, error: 'daemon-control-disabled' });
  });

  it('daemonStart refuses when the binary is unresolved, even with manageDaemon on', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    // binaryPath 'goobers' will not resolve — mocked getShellEnvironment returns PATH: ''.
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot, manageDaemon: true }));
    const service = new GoobersService(settings);

    service.subscribe();
    await flush();

    const result = await service.daemonStart();
    expect(result).toEqual({ ok: false, error: 'binary-not-found' });
  });

  it('daemonStatus returns idle daemon status when unconfigured', async () => {
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: '' }));
    const service = new GoobersService(settings);
    service.subscribe();
    await flush();

    const status = await service.daemonStatus();
    expect(status).toMatchObject({ state: 'unknown' });
  });
});

describe('GoobersService — daemon-start-unknown (M17)', () => {
  it('a genuine start failure (child exited before ready) still sets connection:error and daemon-start-failed', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    const binaryPath = path.join(tmpRoot, 'goobers-bin');
    mockExecutableBinaryStat(binaryPath);
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot, binaryPath, manageDaemon: true }));
    const service = new GoobersService(settings);
    service.subscribe();
    await flush();

    vi.mocked(startDaemon).mockResolvedValueOnce({ ok: false, error: 'daemon exited before becoming ready', stderr: 'boom' });
    const result = await service.daemonStart();

    expect(result).toEqual({ ok: false, error: 'daemon exited before becoming ready' });
    expect(service.getState().connection).toBe('error');
    expect(service.getState().lastError?.code).toBe('daemon-start-failed');
  });

  it('a timeout with the child still alive (outcome: "unknown") is never reported as daemon-start-failed, and keeps polling', async () => {
    mockGetAllWindows.mockReturnValue([visibleWindow()]);
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    const binaryPath = path.join(tmpRoot, 'goobers-bin');
    mockExecutableBinaryStat(binaryPath);
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot, binaryPath, manageDaemon: true }));
    const service = new GoobersService(settings);
    service.subscribe();
    await flush();

    vi.mocked(startDaemon).mockResolvedValueOnce({
      ok: false,
      outcome: 'unknown',
      error: 'daemon started but has not become ready after 60s',
      stderr: 'still working…',
      logPathHint: '/instance/root/scheduler',
    });
    const result = await service.daemonStart();

    expect(result).toEqual({ ok: false, error: 'daemon started but has not become ready after 60s', outcome: 'unknown' });
    // The whole point: this must NOT look like a failure to the panel.
    expect(service.getState().connection).not.toBe('error');
    expect(service.getState().lastError?.code).toBe('daemon-start-unknown');
    expect(service.getState().lastError?.code).not.toBe('daemon-start-failed');
    expect(service.getState().lastError?.stderr).toBe('still working…');
    expect(service.getState().lastError?.logPathHint).toBe('/instance/root/scheduler');
    // §7.5 — must keep observing rather than going silent (this is what a
    // failure path would never do, and what let the panel wrongly show
    // "didn't start" for 37 minutes in the M17 report).
    expect(service.isPollingForTests).toBe(true);
  });

  it('self-corrects to running with no user action once a later poll tick confirms readiness', async () => {
    mockGetAllWindows.mockReturnValue([visibleWindow()]);
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    const binaryPath = path.join(tmpRoot, 'goobers-bin');
    mockExecutableBinaryStat(binaryPath);
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot, binaryPath, manageDaemon: true }));
    const service = new GoobersService(settings);
    service.subscribe();
    await flush();

    vi.mocked(startDaemon).mockResolvedValueOnce({
      ok: false,
      outcome: 'unknown',
      error: 'daemon started but has not become ready after 60s',
      stderr: '',
      logPathHint: '/instance/root/scheduler',
    });
    await service.daemonStart();
    expect(service.getState().lastError?.code).toBe('daemon-start-unknown');

    // Simulate the next poll tick (same private-method pattern used by the
    // existing "stops polling once a tick observes a 401" test above) once
    // the daemon has actually become ready — no refresh/retry from the user.
    vi.mocked(probeLiveness).mockResolvedValueOnce({
      daemon: { state: 'running', address: '127.0.0.1:8080', pid: 34419, version: 'v1', startedAt: 'x', lastTickAgeMillis: 0, draining: false },
      instance: null,
      health: { ready: true, healthy: true } as unknown as LivenessSnapshot['health'],
      degraded: false,
    });
    const svc = service as unknown as {
      refreshConnectionOnce: (s: GoobersSettings) => Promise<void>;
      afterPollTick: (s: GoobersSettings) => void;
    };
    await svc.refreshConnectionOnce(settings.getSettings());
    svc.afterPollTick(settings.getSettings());

    expect(service.getState().daemon.state).toBe('running');
    expect(service.getState().connection).toBe('connected');
    expect(service.getState().lastError).toBeNull();
    expect(service.isPollingForTests).toBe(true); // still polling normally, not knocked back to file-watching
  });
});

describe('GoobersService — daemon-stop-failed (M14, mirrors daemon-start-failed)', () => {
  it('a genuine stop failure sets both connection:error and lastError, mirroring daemonStart\'s failure path', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    const binaryPath = path.join(tmpRoot, 'goobers-bin');
    mockExecutableBinaryStat(binaryPath);
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot, binaryPath, manageDaemon: true }));
    const service = new GoobersService(settings);
    service.subscribe();
    await flush();

    vi.mocked(stopDaemon).mockResolvedValueOnce({ ok: false, error: 'permission denied' });
    const result = await service.daemonStop();

    expect(result).toEqual({ ok: false, error: 'permission denied' });
    expect(service.getState().connection).toBe('error');
    expect(service.getState().lastError).toEqual({ code: 'daemon-stop-failed', message: 'permission denied' });
  });

  it('a successful stop-request (draining) is unaffected — connection stays connected, no daemon-stop-failed', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    const binaryPath = path.join(tmpRoot, 'goobers-bin');
    mockExecutableBinaryStat(binaryPath);
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot, binaryPath, manageDaemon: true }));
    const service = new GoobersService(settings);
    service.subscribe();
    await flush();

    vi.mocked(stopDaemon).mockResolvedValueOnce({ ok: true });
    const result = await service.daemonStop();

    expect(result).toEqual({ ok: true });
    expect(service.getState().connection).toBe('connected');
    expect(service.getState().daemon.draining).toBe(true);
    expect(service.getState().lastError?.code).not.toBe('daemon-stop-failed');
  });

  it('lock-contention (alreadyStopped) is treated as success, not a failure', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    const binaryPath = path.join(tmpRoot, 'goobers-bin');
    mockExecutableBinaryStat(binaryPath);
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot, binaryPath, manageDaemon: true }));
    const service = new GoobersService(settings);
    service.subscribe();
    await flush();

    vi.mocked(stopDaemon).mockResolvedValueOnce({ ok: true, alreadyStopped: true });
    const result = await service.daemonStop();

    expect(result).toEqual({ ok: true, alreadyStopped: true });
    expect(service.getState().connection).not.toBe('error');
    expect(service.getState().lastError?.code).not.toBe('daemon-stop-failed');
  });
});

/**
 * M19 — the `manageDaemon` seam. An off switch already exists at the
 * settings layer (GoobersSettingsView.tsx, M2) and the two guards here
 * (:770/:834) were already regression-tested in isolation ("daemon control
 * gating" above), but nothing exercised the *pair* through a live
 * daemonStart/daemonStop cycle, and nothing asserted the :862 comment's
 * claim — "a `manageDaemon` toggle to false later must not stop this
 * tracking" — against an actual in-progress drain.
 */
describe('GoobersService — manageDaemon toggle-off preserves tracking (M19)', () => {
  it('toggling manageDaemon off mid-drain does not stop polling or clear draining state', async () => {
    mockGetAllWindows.mockReturnValue([visibleWindow()]);
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    const binaryPath = path.join(tmpRoot, 'goobers-bin');
    mockExecutableBinaryStat(binaryPath);
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot, binaryPath, manageDaemon: true }));
    const service = new GoobersService(settings);
    service.subscribe();
    await flush();

    vi.mocked(stopDaemon).mockResolvedValueOnce({ ok: true });
    const stopResult = await service.daemonStop();
    expect(stopResult).toEqual({ ok: true });
    expect(service.getState().daemon.draining).toBe(true);
    expect(service.isPollingForTests).toBe(true);

    // The toggle to false: same instanceRoot/binaryPath/autoConnect, only
    // manageDaemon flips — this is exactly the shape a Settings-page save
    // produces (settings-store-factory.ts always sends the full object).
    const next = defaultSettings({ instanceRoot: tmpRoot, binaryPath, manageDaemon: false });
    settings.set(next);
    (service as unknown as { onSettingsChanged: (s: GoobersSettings) => void }).onSettingsChanged(next);
    await flush();

    // Tracking must survive: still polling, still draining, connection
    // untouched by the toggle itself.
    expect(service.isPollingForTests).toBe(true);
    expect(service.getState().daemon.draining).toBe(true);
    expect(service.getState().connection).toBe('connected');
  });

  it('on -> off -> on: spawn paths are unreachable while off and reachable again once back on', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    const binaryPath = path.join(tmpRoot, 'goobers-bin');
    mockExecutableBinaryStat(binaryPath);
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot, binaryPath, manageDaemon: true }));
    const service = new GoobersService(settings);
    service.subscribe();
    await flush();

    // ON: the spawn path is reachable (goobers-daemon.ts's startDaemon is
    // called; daemonStart() does not short-circuit on the gate).
    vi.mocked(startDaemon).mockResolvedValueOnce({ ok: true, holderKind: 'daemon' });
    const onResult = await service.daemonStart();
    expect(onResult.error).not.toBe('daemon-control-disabled');
    expect(vi.mocked(startDaemon)).toHaveBeenCalledTimes(1);

    // OFF: both control paths refuse before ever reaching startDaemon/stopDaemon.
    const off = defaultSettings({ instanceRoot: tmpRoot, binaryPath, manageDaemon: false });
    settings.set(off);
    (service as unknown as { onSettingsChanged: (s: GoobersSettings) => void }).onSettingsChanged(off);
    await flush();

    const startWhileOff = await service.daemonStart();
    const stopWhileOff = await service.daemonStop();
    expect(startWhileOff).toEqual({ ok: false, error: 'daemon-control-disabled' });
    expect(stopWhileOff).toEqual({ ok: false, error: 'daemon-control-disabled' });
    expect(vi.mocked(startDaemon)).toHaveBeenCalledTimes(1); // unchanged — no new spawn attempt
    expect(vi.mocked(stopDaemon)).not.toHaveBeenCalled();

    // ON again: the gate reopens, spawn path reachable once more.
    const onAgain = defaultSettings({ instanceRoot: tmpRoot, binaryPath, manageDaemon: true });
    settings.set(onAgain);
    (service as unknown as { onSettingsChanged: (s: GoobersSettings) => void }).onSettingsChanged(onAgain);
    await flush();

    vi.mocked(startDaemon).mockResolvedValueOnce({ ok: true, holderKind: 'daemon' });
    const backOnResult = await service.daemonStart();
    expect(backOnResult.error).not.toBe('daemon-control-disabled');
    expect(vi.mocked(startDaemon)).toHaveBeenCalledTimes(2);
  });
});

describe('GoobersService — listRuns', () => {
  it('refuses to fetch runs when the daemon is not running', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot }));
    const service = new GoobersService(settings);

    service.subscribe();
    await flush();

    const result = await service.listRuns({ phase: 'running' });
    expect(result).toEqual({ error: { code: 'daemon-not-running', message: expect.any(String) } });
  });
});

describe('GoobersService — 401 / auth-required (§8.4, §9.2, §10.1)', () => {
  function authRequiredSnapshot(): LivenessSnapshot {
    return {
      daemon: { state: 'running', address: '127.0.0.1:8080', pid: 7027, version: 'v1', startedAt: 'x', lastTickAgeMillis: null, draining: false },
      instance: null,
      health: null,
      degraded: false,
      error: { code: 'auth-required', message: 'GET /api/v1/instance returned 401' },
    };
  }

  function runningSnapshot(): LivenessSnapshot {
    return {
      daemon: { state: 'running', address: '127.0.0.1:8080', pid: 7027, version: 'v1', startedAt: 'x', lastTickAgeMillis: 1000, draining: false },
      instance: { instanceRoot: tmpRoot } as unknown as LivenessSnapshot['instance'],
      health: { ready: true, healthy: true } as unknown as LivenessSnapshot['health'],
      degraded: false,
    };
  }

  function writeConfiguredRoot(): void {
    fs.writeFileSync(path.join(tmpRoot, 'instance.yaml'), 'kind: Instance\n');
    fs.writeFileSync(path.join(tmpRoot, '.instance-id'), 'eaf74575d8de50fa5471027ba7fd15cb\n');
  }

  it('a 401 on connect maps to lastError.code "auth-required" and does not start polling or the address watcher', async () => {
    mockGetAllWindows.mockReturnValue([visibleWindow()]);
    writeConfiguredRoot();
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot }));
    const service = new GoobersService(settings);

    vi.mocked(probeLiveness).mockResolvedValueOnce(authRequiredSnapshot());

    service.subscribe();
    await flush();

    expect(service.getState().lastError?.code).toBe('auth-required');
    expect(service.getState().daemon.state).toBe('running'); // §14.1 — /readyz already confirmed this
    expect(service.isPollingForTests).toBe(false);
    expect(service.isWatchingAddressFileForTests).toBe(false);
  });

  it('stops polling once a tick observes a 401, rather than retrying in a loop', async () => {
    mockGetAllWindows.mockReturnValue([visibleWindow()]);
    writeConfiguredRoot();
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot }));
    const service = new GoobersService(settings);

    vi.mocked(probeLiveness).mockResolvedValueOnce(runningSnapshot());
    service.subscribe();
    await flush();
    expect(service.isPollingForTests).toBe(true); // connected fine — polling started normally

    // Simulate the next 5s tick observing a 401, by directly driving the same
    // private sequence the poll interval calls (refreshConnectionOnce then
    // afterPollTick) — consistent with how this file already reaches into
    // private methods (see onSettingsChanged/teardown above).
    vi.mocked(probeLiveness).mockResolvedValueOnce(authRequiredSnapshot());
    const svc = service as unknown as {
      refreshConnectionOnce: (s: GoobersSettings) => Promise<void>;
      afterPollTick: (s: GoobersSettings) => void;
    };
    await svc.refreshConnectionOnce(settings.getSettings());
    svc.afterPollTick(settings.getSettings());

    expect(service.getState().lastError?.code).toBe('auth-required');
    expect(service.isPollingForTests).toBe(false);
  });

  it('daemon start/stop remain callable while auth-required — the read path is disabled, not daemon control', async () => {
    mockGetAllWindows.mockReturnValue([visibleWindow()]);
    writeConfiguredRoot();
    const binaryPath = path.join(tmpRoot, 'goobers-bin');
    mockExecutableBinaryStat(binaryPath);
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot, binaryPath, manageDaemon: true }));
    const service = new GoobersService(settings);

    vi.mocked(probeLiveness).mockResolvedValueOnce(authRequiredSnapshot());
    service.subscribe();
    await flush();
    expect(service.getState().lastError?.code).toBe('auth-required');

    vi.mocked(startDaemon).mockResolvedValueOnce({ ok: false, error: 'lock-contention', holderKind: 'daemon' });
    vi.mocked(probeLiveness).mockResolvedValueOnce(authRequiredSnapshot());
    const startResult = await service.daemonStart();
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(startResult.error).not.toBe('daemon-control-disabled');
    expect(startResult.error).not.toBe('binary-not-found');

    vi.mocked(stopDaemon).mockResolvedValueOnce({ ok: true });
    const stopResult = await service.daemonStop();
    expect(stopDaemon).toHaveBeenCalledTimes(1);
    expect(stopResult.ok).toBe(true);
  });

  it('recovers once a later probe returns 200 (e.g. a manual reconnect after fixing the credential)', async () => {
    mockGetAllWindows.mockReturnValue([visibleWindow()]);
    writeConfiguredRoot();
    // A resolvable binaryPath, so the only source of lastError in this test
    // is the auth-required snapshot itself — not the separate "unresolvable
    // binaryPath" fallback error (§4.1) that would otherwise survive
    // recovery and give a false negative on the "clears to null" assertion.
    const binaryPath = path.join(tmpRoot, 'goobers-bin');
    mockExecutableBinaryStat(binaryPath);
    const settings = makeFakeSettings(defaultSettings({ instanceRoot: tmpRoot, binaryPath }));
    const service = new GoobersService(settings);

    vi.mocked(probeLiveness).mockResolvedValueOnce(authRequiredSnapshot());
    service.subscribe();
    await flush();
    expect(service.getState().lastError?.code).toBe('auth-required');
    expect(service.isPollingForTests).toBe(false);

    vi.mocked(probeLiveness).mockResolvedValueOnce(runningSnapshot());
    await service.connect();

    expect(service.getState().lastError).toBeNull();
    expect(service.getState().connection).toBe('connected');
    expect(service.getState().instance).not.toBeNull();
    expect(service.isPollingForTests).toBe(true);
  });
});
