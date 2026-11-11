import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'stream';

// ---------------------------------------------------------------------------
// Hoisted variables for use in vi.mock factories
// ---------------------------------------------------------------------------

const { mockSettings, mockSave } = vi.hoisted(() => ({
  mockSettings: {
    autoUpdate: true,
    previewChannel: false,
    lastCheck: null as string | null,
    dismissedVersion: null as string | null,
    lastSeenVersion: null as string | null,
  },
  mockSave: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
  flush: vi.fn(),
  flushSync: vi.fn(),
}));

vi.mock('./settings-store', () => ({
  createSettingsStore: () => ({
    get: () => ({ ...mockSettings }),
    save: mockSave,
    update: vi.fn(),
  }),
}));

vi.mock('https', () => ({
  get: vi.fn((_url: string, _opts: unknown, _cb: unknown) => {
    return new EventEmitter();
  }),
}));

vi.mock('http', () => ({ get: vi.fn() }));
vi.mock('child_process', async () => ({
  ...await vi.importActual<typeof import('child_process')>('child_process'),
  execFileSync: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    createReadStream: actual.createReadStream,
    createWriteStream: actual.createWriteStream,
  };
});

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(async () => {}),
  access: vi.fn(async () => { throw new Error('ENOENT'); }),
  unlink: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
  readdir: vi.fn(async () => []),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { getReadyUpdateProblem, getSelfUpdateUnsupportedReason, _setStatusForTesting, startPeriodicChecks, stopPeriodicChecks, shouldAutoCheckOnStartup } from './auto-update-service';
import type { UpdateStatus } from '../../shared/types';
import { app } from 'electron';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startPeriodicChecks / stopPeriodicChecks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSettings.autoUpdate = true;
    mockSettings.previewChannel = false;
    mockSettings.lastCheck = null;
    mockSettings.dismissedVersion = 'old-dismissed';
    mockSettings.lastSeenVersion = null;
  });

  afterEach(() => {
    stopPeriodicChecks();
    vi.useRealTimers();
  });

  it('seeds lastSeenVersion on first launch', async () => {
    mockSettings.lastSeenVersion = null;
    await startPeriodicChecks();
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ lastSeenVersion: expect.any(String) }),
    );
  });

  it('clears dismissedVersion on startup', async () => {
    mockSettings.dismissedVersion = '0.30.0';
    await startPeriodicChecks();
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ dismissedVersion: null }),
    );
  });

  it('preserves lastSeenVersion when clearing dismissedVersion in the same startup pass', async () => {
    mockSettings.lastSeenVersion = null;
    mockSettings.dismissedVersion = '0.30.0';

    await startPeriodicChecks();

    expect(mockSave).toHaveBeenCalledTimes(2);
    expect(mockSave.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        lastSeenVersion: expect.any(String),
        dismissedVersion: null,
      }),
    );
  });

  it('returns early without scheduling when autoUpdate is false', async () => {
    mockSettings.autoUpdate = false;
    // Should not throw and should return early
    await startPeriodicChecks();
    // stopPeriodicChecks is safe even when no timer was created
    expect(() => stopPeriodicChecks()).not.toThrow();
  });

  it('stopPeriodicChecks is safe to call multiple times', async () => {
    await startPeriodicChecks();
    stopPeriodicChecks();
    expect(() => stopPeriodicChecks()).not.toThrow();
  });

  it('calling startPeriodicChecks twice does not create duplicate timers', async () => {
    await startPeriodicChecks();
    await startPeriodicChecks(); // second call should be a no-op
    stopPeriodicChecks();
  });
});

describe('shouldAutoCheckOnStartup', () => {
  const originalPackaged = app.isPackaged;
  const originalEnv = process.env.CLUBHOUSE_DISABLE_AUTO_UPDATE;

  afterEach(() => {
    (app as { isPackaged: boolean }).isPackaged = originalPackaged;
    if (originalEnv === undefined) delete process.env.CLUBHOUSE_DISABLE_AUTO_UPDATE;
    else process.env.CLUBHOUSE_DISABLE_AUTO_UPDATE = originalEnv;
  });

  describe('self-update support for remote requests', () => {
    const originalPackaged = app.isPackaged;
    afterEach(() => {
      app.isPackaged = originalPackaged;
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it('refuses development, disabled and nonrelease integration/main/nightly builds with plain reasons', () => {
      app.isPackaged = false;
      expect(getSelfUpdateUnsupportedReason()).toContain('development build');
      app.isPackaged = true;
      vi.stubEnv('CLUBHOUSE_DISABLE_AUTO_UPDATE', '1');
      expect(getSelfUpdateUnsupportedReason()).toContain('disabled');
      vi.stubEnv('CLUBHOUSE_DISABLE_AUTO_UPDATE', '');
      vi.spyOn(app, 'getName').mockReturnValue('Clubhouse');
      for (const version of ['0.0.0-integration.123.1', '1.2.3-main.45', '1.2.3-nightly.1']) {
        vi.spyOn(app, 'getVersion').mockReturnValue(version);
        expect(getSelfUpdateUnsupportedReason()).toContain('cannot update itself');
      }
      vi.spyOn(app, 'getVersion').mockReturnValue('1.2.3');
      vi.spyOn(app, 'getName').mockReturnValue('Clubhouse Integration');
      expect(getSelfUpdateUnsupportedReason()).toContain('cannot update itself');
    });

    it('checks the actual platform installer rather than allowing the relaunch-only fallback', () => {
      app.isPackaged = true;
      vi.stubEnv('CLUBHOUSE_DISABLE_AUTO_UPDATE', '');
      vi.spyOn(app, 'getName').mockReturnValue('Clubhouse');
      vi.spyOn(app, 'getVersion').mockReturnValue('1.2.3-beta.1');
      vi.stubGlobal('process', { ...process, platform: 'darwin' });
      vi.spyOn(app, 'getPath').mockReturnValue('/Applications/Clubhouse.app/Contents/MacOS/Clubhouse');
      expect(getSelfUpdateUnsupportedReason()).toBeNull();
      vi.spyOn(app, 'getPath').mockReturnValue('/tmp/Clubhouse');
      expect(getSelfUpdateUnsupportedReason()).toContain('not an updatable Mac app');
      vi.stubGlobal('process', { ...process, platform: 'win32' });
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(getSelfUpdateUnsupportedReason()).toContain('no updater');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(getSelfUpdateUnsupportedReason()).toBeNull();
    });

    it('refuses missing, wrong-format or stale installers before remote shutdown', () => {
      vi.stubGlobal('process', { ...process, platform: 'darwin' });
      vi.spyOn(app, 'getVersion').mockReturnValue('1.0.0');
      const ready = { state: 'ready', availableVersion: '1.1.0', downloadPath: '/tmp/update.zip' } as UpdateStatus;
      _setStatusForTesting(ready);
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(getReadyUpdateProblem()).toContain('installer is missing');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(getReadyUpdateProblem()).toBeNull();
      _setStatusForTesting({ ...ready, downloadPath: '/tmp/update.txt' });
      expect(getReadyUpdateProblem()).toContain('cannot be applied');
      _setStatusForTesting({ ...ready, availableVersion: '1.0.0' });
      expect(getReadyUpdateProblem()).toContain('not ready');
    });

    it('does not spawn package-manager checks on each Linux status/progress broadcast', () => {
      app.isPackaged = true;
      vi.stubEnv('CLUBHOUSE_DISABLE_AUTO_UPDATE', '');
      vi.spyOn(app, 'getName').mockReturnValue('Clubhouse');
      vi.spyOn(app, 'getVersion').mockReturnValue('1.2.3');
      vi.stubGlobal('process', { ...process, platform: 'linux' });
      _setStatusForTesting({ state: 'idle' } as UpdateStatus);
      vi.mocked(execFileSync).mockReturnValue('install ok installed');
      expect(getSelfUpdateUnsupportedReason()).toBeNull();
      expect(getSelfUpdateUnsupportedReason()).toBeNull();
      expect(execFileSync).toHaveBeenCalledOnce();
    });
  });

  it('returns false for an unpackaged build (dev / E2E)', () => {
    (app as { isPackaged: boolean }).isPackaged = false;
    delete process.env.CLUBHOUSE_DISABLE_AUTO_UPDATE;
    expect(shouldAutoCheckOnStartup()).toBe(false);
  });

  it('returns true for a packaged build', () => {
    (app as { isPackaged: boolean }).isPackaged = true;
    delete process.env.CLUBHOUSE_DISABLE_AUTO_UPDATE;
    expect(shouldAutoCheckOnStartup()).toBe(true);
  });

  it('returns false when the E2E disable override is set, even if packaged', () => {
    (app as { isPackaged: boolean }).isPackaged = true;
    process.env.CLUBHOUSE_DISABLE_AUTO_UPDATE = '1';
    expect(shouldAutoCheckOnStartup()).toBe(false);
  });
});
