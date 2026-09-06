/* eslint-disable no-restricted-syntax -- TODO(TC-CRIT-03): structural readFileSync tests pending behavioral conversion */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { awaitShutdownCleanup } from './shutdown-guard';

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

  it('waits for the detached updater spawn before quitting with no running agents', async () => {
    const update = { state: 'ready', runningAgents: 0 };
    const events: string[] = [];
    const spawnDetachedUpdater = vi.fn(() => {
      events.push('spawn');
    });
    const applyUpdateOnQuit = async () => {
      expect(update).toEqual({ state: 'ready', runningAgents: 0 });
      spawnDetachedUpdater();
    };
    const appQuit = vi.fn(() => {
      events.push('quit');
    });

    await new Promise<void>((resolve) => {
      awaitShutdownCleanup([
        Promise.resolve(),
        applyUpdateOnQuit(),
      ], () => {
        appQuit();
        resolve();
      });
    });

    expect(spawnDetachedUpdater).toHaveBeenCalledOnce();
    expect(appQuit).toHaveBeenCalledOnce();
    expect(events).toEqual(['spawn', 'quit']);
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
