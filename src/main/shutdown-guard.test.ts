import { describe, it, expect, vi } from 'vitest';
import { createBeforeQuitHandler } from './shutdown-guard';
import { applyUpdateOnQuit } from './services/auto-update-service';
import { pathExists } from './services/fs-utils';

const mockSpawn = vi.hoisted(() => vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })));

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => key === 'exe'
      ? '/Applications/Clubhouse.app/Contents/MacOS/Clubhouse'
      : '/tmp/test-temp',
    getVersion: () => '0.41.0',
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('./services/log-service', () => ({
  appLog: vi.fn(),
  flush: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => { throw new Error('ENOENT'); }),
}));

vi.mock('./services/fs-utils', () => ({
  pathExists: vi.fn(async () => true),
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execSync: vi.fn(),
}));

describe('before-quit handler', () => {
  it('waits for the real detached updater spawn before quitting with no running agents', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const events: string[] = [];
    const appQuit = vi.fn(() => {
      events.push('quit');
    });
    const update = {
      state: 'ready' as const,
      availableVersion: '0.42.0',
      releaseNotes: null,
      releaseMessage: null,
      downloadProgress: 100,
      downloadPath: '',
      error: null,
      artifactUrl: 'https://example.test/Clubhouse-0.42.0.zip',
    };
    mockSpawn.mockImplementation(() => {
      events.push('spawn');
      return { on: vi.fn(), unref: vi.fn() };
    });

    try {
      await new Promise<void>((resolve) => {
        const handleBeforeQuit = createBeforeQuitHandler({
          killAll: async () => undefined,
          flushAllAgentConfigs: async () => undefined,
          applyUpdateOnQuit: () => applyUpdateOnQuit(update),
          appQuit: () => {
            appQuit();
            resolve();
          },
          onCleanupError: () => undefined,
        });
        handleBeforeQuit({ preventDefault: vi.fn() });
      });

      expect(pathExists).toHaveBeenCalled();
      expect(appQuit).toHaveBeenCalledOnce();
      expect(events).toEqual(['spawn', 'quit']);
    } finally {
      platform.mockRestore();
    }
  });

  it('quits when update application rejects after cleanup starts', async () => {
    const appQuit = vi.fn();

    await new Promise<void>((resolve) => {
      const handleBeforeQuit = createBeforeQuitHandler({
        killAll: async () => undefined,
        flushAllAgentConfigs: async () => undefined,
        applyUpdateOnQuit: () => Promise.reject(new Error('spawn failed')),
        appQuit: () => {
          appQuit();
          resolve();
        },
        onCleanupError: vi.fn(),
      });
      handleBeforeQuit({ preventDefault: vi.fn() });
    });

    expect(appQuit).toHaveBeenCalledOnce();
  });
});
