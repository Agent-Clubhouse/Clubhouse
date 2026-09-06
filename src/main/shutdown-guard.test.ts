/* eslint-disable no-restricted-syntax -- TODO(TC-CRIT-03): structural readFileSync tests pending behavioral conversion */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { awaitShutdownCleanup } from './shutdown-guard';
import { applyUpdateOnQuit } from './services/auto-update-service';
import { pathExists } from './services/fs-utils';

const mockSpawn = vi.hoisted(() => vi.fn(() => ({ unref: vi.fn() })));

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

/**
 * Structural tests verifying the before-quit handler properly awaits async cleanup.
 * The actual Electron event handling can't be unit-tested without mocking the full
 * Electron runtime, so we verify the source structure instead.
 */

const indexSource = fs.readFileSync(
  path.resolve(__dirname, 'index.ts'),
  'utf-8',
);

describe('before-quit handler', () => {
  it('should use event.preventDefault() to delay quit', () => {
    expect(indexSource).toContain('event.preventDefault()');
  });

  it('should have a re-entrance guard', () => {
    expect(indexSource).toContain('isQuitting');
  });

  it('should await killAll via Promise', () => {
    // killAll should be inside a Promise.all or awaited
    expect(indexSource).toMatch(/awaitShutdownCleanup\(\s*\[[\s\S]*?killAll\(\)/);
  });

  it('should await flushAllAgentConfigs via Promise', () => {
    expect(indexSource).toMatch(/awaitShutdownCleanup\(\s*\[[\s\S]*?flushAllAgentConfigs\(\)/);
  });

  it('should await applyUpdateOnQuit via Promise', () => {
    expect(indexSource).toMatch(/awaitShutdownCleanup\(\s*\[[\s\S]*?applyUpdateOnQuit\(\)/);
  });

  it('should call app.quit() after cleanup completes', () => {
    expect(indexSource).toMatch(/awaitShutdownCleanup\([\s\S]*?\],\s*\(\)\s*=>\s*\{[\s\S]*?app\.quit\(\)/);
  });

  it('waits for the real detached updater spawn before quitting with no running agents', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const events: string[] = [];
    const runningAgents = 0;
    const killAll = vi.fn(async () => {
      expect(runningAgents).toBe(0);
    });
    const spawnDetachedUpdater = vi.fn(() => {
      events.push('spawn');
    });
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
      spawnDetachedUpdater();
      return { unref: vi.fn() };
    });

    try {
      await new Promise<void>((resolve) => {
        awaitShutdownCleanup([
          killAll(),
          applyUpdateOnQuit(update),
        ], () => {
          appQuit();
          resolve();
        });
      });

      expect(pathExists).toHaveBeenCalled();
      expect(spawnDetachedUpdater).toHaveBeenCalledOnce();
      expect(killAll).toHaveBeenCalledOnce();
      expect(appQuit).toHaveBeenCalledOnce();
      expect(events).toEqual(['spawn', 'quit']);
    } finally {
      platform.mockRestore();
    }
  });

  it('quits when update application rejects after cleanup starts', async () => {
    const appQuit = vi.fn();

    await new Promise<void>((resolve) => {
      awaitShutdownCleanup([
        Promise.reject(new Error('spawn failed')).catch(() => undefined),
      ], () => {
        appQuit();
        resolve();
      });
    });

    expect(appQuit).toHaveBeenCalledOnce();
  });
});
