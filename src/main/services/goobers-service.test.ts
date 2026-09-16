import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: '' })),
}));

import { getShellEnvironment } from '../util/shell';
import {
  GoobersService,
  validateInstanceRoot,
  resolveBinaryPath,
} from './goobers-service';
import type { GoobersSettings } from '../../shared/types';
import type { ManagedSettings } from './managed-settings';

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

  it('rejects a root with no instance.yaml', async () => {
    const result = await validateInstanceRoot(tmpRoot);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not-a-goobers-instance-root');
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
  // A real on-disk file's mode bits are a physical property of the host
  // OS/filesystem — mocking process.platform does NOT change what a real
  // fs.promises.stat() returns for .mode (e.g. NTFS never sets POSIX
  // execute bits, no matter what platform string the code checks). The
  // POSIX bitmask branch of isExecutableMode must be tested against a
  // synthetic Stats object with a controlled .mode instead of a real file,
  // so these tests are deterministic on every CI runner's actual OS.
  function fakeStat(mode: number): fs.Stats {
    return { isFile: () => true, mode } as fs.Stats;
  }

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
});
