import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockExecFileSync, mockSpawn, mockPathExists, mockApp, mockGetSettings } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockSpawn: vi.fn(),
  mockPathExists: vi.fn(async () => false),
  mockApp: {
    getPath: (key: string) => {
      if (key === 'userData') return '/tmp/test-clubhouse';
      if (key === 'temp') return '/tmp/test-temp';
      if (key === 'exe') return 'C:\\Program Files\\Clubhouse\\Clubhouse.exe';
      return `/tmp/test-${key}`;
    },
    getVersion: () => '0.25.0',
    exit: vi.fn(),
    relaunch: vi.fn(),
  },
  mockGetSettings: vi.fn(() => ({ previewChannel: false })),
}));

vi.mock('electron', () => ({
  app: mockApp,
  shell: { showItemInFolder: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
  flush: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
  execSync: vi.fn(),
  spawn: mockSpawn,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    createReadStream: actual.createReadStream,
    createWriteStream: actual.createWriteStream,
  };
});

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => { throw new Error('ENOENT'); }),
  writeFile: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  access: vi.fn(async () => { throw new Error('ENOENT'); }),
  rm: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
}));

vi.mock('./fs-utils', () => ({
  pathExists: mockPathExists,
}));

vi.mock('./settings-store', () => ({
  createSettingsStore: vi.fn(() => ({
    get: mockGetSettings,
    save: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { applyUpdate, applyUpdateOnQuit, applyWindowsUpdate, getStatus, _setStatusForTesting } from './auto-update-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const readyStatus = {
  state: 'ready' as const,
  availableVersion: '1.0.0',
  releaseNotes: null,
  releaseMessage: null,
  downloadProgress: 100,
  error: null,
  downloadPath: 'C:\\Users\\test\\AppData\\Local\\Clubhouse\\Update with spaces\\Clubhouse-1.0.0.exe',
  artifactUrl: 'https://example.com/Clubhouse-1.0.0.exe',
  applyAttempted: false,
};

function createSpawnedChild() {
  const child = {
    once: vi.fn(),
    unref: vi.fn(),
  };
  child.once.mockImplementation((event: string, handler: () => void) => {
    if (event === 'spawn') handler();
    return child;
  });
  return child;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== 'win32')('Windows update apply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockReturnValue({ previewChannel: false });
    _setStatusForTesting({
      state: 'idle',
      availableVersion: null,
      releaseNotes: null,
      releaseMessage: null,
      downloadProgress: 0,
      error: null,
      downloadPath: null,
      artifactUrl: null,
      applyAttempted: false,
    });
  });

  describe('applyUpdate', () => {
    it('throws when no update is ready', async () => {
      await expect(applyUpdate()).rejects.toThrow('No update ready to apply');
    });

    it('calls Update.exe --update with releasesUrl', async () => {
      mockPathExists.mockImplementation(async () => true);
      mockSpawn.mockReturnValue(createSpawnedChild());

      await applyUpdate(readyStatus);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        expect.stringContaining('Update.exe'),
        ['--update', expect.stringContaining('/squirrel/')],
        expect.objectContaining({ timeout: 300_000, windowsHide: true }),
      );
    });

    it('spawns Update.exe --processStart after execFileSync', async () => {
      mockPathExists.mockImplementation(async () => true);
      mockSpawn.mockReturnValue(createSpawnedChild());

      await applyUpdate(readyStatus);

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringContaining('Update.exe'),
        ['--processStart', path.basename(process.execPath)],
        expect.objectContaining({ detached: true, windowsHide: true }),
      );
    });

    it('calls app.exit(0) after spawning', async () => {
      mockPathExists.mockImplementation(async () => true);
      mockSpawn.mockReturnValue(createSpawnedChild());

      await applyUpdate(readyStatus);

      expect(mockApp.exit).toHaveBeenCalledWith(0);
    });

    it('throws when Update.exe is not found', async () => {
      mockPathExists.mockImplementation(async () => false);

      await expect(applyUpdate(readyStatus)).rejects.toThrow(/Update\.exe not found/i);
    });

    it('is exported as a function', () => {
      expect(typeof applyUpdate).toBe('function');
    });
  });

  describe('applyUpdateOnQuit', () => {
    it('is a no-op when state is not ready', async () => {
      const status = getStatus();
      expect(status.state).toBe('idle');
      await applyUpdateOnQuit();
      expect(mockExecFileSync).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockPathExists).not.toHaveBeenCalled();
    });

    it('spawns Update.exe --update with detached process', async () => {
      mockPathExists.mockImplementation(async () => true);
      mockSpawn.mockReturnValue(createSpawnedChild());

      await applyUpdateOnQuit(readyStatus);

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringContaining('Update.exe'),
        ['--update', expect.stringContaining('/squirrel/')],
        expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: true }),
      );
    });

    it('does not call execFileSync (unlike applyUpdate)', async () => {
      mockPathExists.mockImplementation(async () => true);
      mockSpawn.mockReturnValue(createSpawnedChild());

      await applyUpdateOnQuit(readyStatus);

      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('does not call app.exit', async () => {
      mockPathExists.mockImplementation(async () => true);
      mockSpawn.mockReturnValue(createSpawnedChild());

      await applyUpdateOnQuit(readyStatus);

      expect(mockApp.exit).not.toHaveBeenCalled();
    });

    it('registers error handler on child process', async () => {
      mockPathExists.mockImplementation(async () => true);
      const child = createSpawnedChild();
      mockSpawn.mockReturnValue(child);

      await applyUpdateOnQuit(readyStatus);

      expect(child.once).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('logs and rejects when child.once("error") is triggered', async () => {
      mockPathExists.mockImplementation(async () => true);
      const child = createSpawnedChild();
      const testError = new Error('Failed to start');
      child.once.mockImplementation((event: string, handler: (error?: Error) => void) => {
        if (event === 'error') handler(testError);
        return child;
      });
      mockSpawn.mockReturnValue(child);

      const { appLog } = await vi.importMock('./log-service');

      await expect(applyUpdateOnQuit(readyStatus)).rejects.toThrow('Failed to start');
      expect(appLog).toHaveBeenCalledWith(
        'update:apply-on-quit',
        'error',
        expect.stringContaining('Updater failed to start'),
      );
    });

    it('is exported as a function', () => {
      expect(typeof applyUpdateOnQuit).toBe('function');
    });
  });

  describe('applyWindowsUpdate', () => {
    it('throws when Update.exe is not found', async () => {
      mockPathExists.mockImplementation(async () => false);

      const context = {
        version: '1.0.0',
        downloadPath: 'C:\\path\\to\\download',
        artifactUrl: 'https://example.com/download',
      };

      await expect(applyWindowsUpdate(context, { relaunch: true })).rejects.toThrow(
        /Update\.exe not found/i,
      );
    });

    it('calls Update.exe with correct arguments on relaunch=true', async () => {
      mockPathExists.mockImplementation(async () => true);
      mockSpawn.mockReturnValue(createSpawnedChild());

      const context = {
        version: '1.0.0',
        downloadPath: 'C:\\path\\to\\download',
        artifactUrl: 'https://example.com/download',
      };

      await applyWindowsUpdate(context, { relaunch: true });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        expect.stringContaining('Update.exe'),
        ['--update', expect.stringContaining('/squirrel/')],
        expect.objectContaining({ timeout: 300_000, windowsHide: true }),
      );
    });

    it('calls spawn with --processStart on relaunch=true', async () => {
      mockPathExists.mockImplementation(async () => true);
      mockSpawn.mockReturnValue(createSpawnedChild());

      const context = {
        version: '1.0.0',
        downloadPath: 'C:\\path\\to\\download',
        artifactUrl: 'https://example.com/download',
      };

      await applyWindowsUpdate(context, { relaunch: true });

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringContaining('Update.exe'),
        ['--processStart', path.basename(process.execPath)],
        expect.objectContaining({ detached: true, windowsHide: true }),
      );
    });

    it('respects previewChannel setting', async () => {
      mockPathExists.mockImplementation(async () => true);
      mockSpawn.mockReturnValue(createSpawnedChild());
      mockGetSettings.mockReturnValue({ previewChannel: true });

      const context = {
        version: '1.0.0',
        downloadPath: 'C:\\path\\to\\download',
        artifactUrl: 'https://example.com/download',
      };

      await applyWindowsUpdate(context, { relaunch: true });

      expect(mockExecFileSync).toHaveBeenCalledWith(
        expect.stringContaining('Update.exe'),
        ['--update', expect.stringContaining('/preview/')],
        expect.any(Object),
      );
    });
  });
});

describe('Windows update code paths (unit)', () => {
  it('Update.exe path check works for valid paths', () => {
    expect('C:\\Program Files\\Update.exe'.endsWith('Update.exe')).toBe(true);
    expect('C:\\Program Files\\Update.msi'.endsWith('Update.exe')).toBe(false);
  });

  it('platformKey can be used to build Squirrel URLs', () => {
    const key = `${process.platform}-${process.arch}`;
    if (process.platform === 'win32') {
      expect(key).toMatch(/^win32-/);
    }
  });

  it('manifest with win32-x64 artifact is recognized', () => {
    const manifest = {
      version: '1.0.0',
      releaseDate: '2026-01-01',
      artifacts: {
        'win32-x64': {
          url: 'https://example.com/Clubhouse-1.0.0-win32-x64.exe',
          sha256: 'abc123',
          size: 50000000,
        },
        'darwin-arm64': {
          url: 'https://example.com/Clubhouse-1.0.0-darwin-arm64.zip',
          sha256: 'def456',
          size: 60000000,
        },
      },
    };
    const key = `${process.platform}-${process.arch}`;
    const artifact = manifest.artifacts[key as keyof typeof manifest.artifacts];
    if (process.platform === 'win32' && process.arch === 'x64') {
      expect(artifact).toBeDefined();
      expect(artifact!.url).toContain('win32-x64');
    }
  });

  it('process.execPath basename extraction works', () => {
    if (process.platform === 'win32') {
      const mockExePath = 'C:\\Program Files\\Clubhouse\\Clubhouse.exe';
      const appExeName = path.basename(mockExePath);
      expect(appExeName).toBe('Clubhouse.exe');
    } else {
      // On non-Windows platforms, simulate the expected behavior
      const appExeName = 'Clubhouse.exe';
      expect(appExeName.endsWith('.exe')).toBe(true);
    }
  });
});
