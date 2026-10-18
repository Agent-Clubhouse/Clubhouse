import { describe, it, expect, vi, afterEach } from 'vitest';
import { createBeforeQuitHandler, createShutdownCoordinator, type ShutdownPlan, type ShutdownTask } from './shutdown-guard';
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

afterEach(() => {
  vi.useRealTimers();
});

/** A promise a fake participant settles by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

const task = (step: ShutdownTask['step'], run: () => Promise<void>, timeoutMs = 1_000): ShutdownTask => ({ step, label: step, run, timeoutMs });

/**
 * Fake runtimes: a terminal, a chat session and a headless run. Stopping one
 * ends its run, which starts that run's session-id write (as the real exit
 * handlers do); the persist phase has to see every write.
 */
function fakeApp() {
  const events: string[] = [];
  const pendingWrites = new Set<Promise<void>>();
  const disk: string[] = [];
  const memory: string[] = [];
  const endRun = (name: string, delayMs = 0) => {
    events.push(`${name}:stopped`);
    const write = new Promise<void>((r) => setTimeout(r, delayMs)).then(() => { memory.push(`${name}-session`); });
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
  };
  const stops = {
    pty: task('pty_kill_all', async () => endRun('pty')),
    chat: task('chat_stop', async () => { await new Promise((r) => setTimeout(r, 5)); endRun('chat', 5); }),
    headless: task('headless_stop', async () => endRun('headless')),
  };
  const plan = (over: Partial<ShutdownPlan> = {}): ShutdownPlan => ({
    begin: () => events.push('launches-closed'),
    stop: [stops.pty, stops.chat, stops.headless],
    persist: [
      task('session_capture', async () => { while (pendingWrites.size) await Promise.all([...pendingWrites]); events.push('sessions-saved'); }),
      task('agent_config_flush', async () => { disk.push(...memory.splice(0)); events.push('configs-flushed'); }),
    ],
    restore: [task('config_restore', async () => { events.push('config-restored'); })],
    ...over,
  });
  return { events, disk, plan, stops };
}

describe('shutdown coordinator (#2053)', () => {
  it('stops every runtime, saves their session ids, flushes, then restores config', async () => {
    const app = fakeApp();
    const onError = vi.fn();
    await createShutdownCoordinator({ plan: () => app.plan(), onCleanupError: onError }).run();

    expect(app.events[0]).toBe('launches-closed');
    expect(app.events.slice(1, 4).sort()).toEqual(['chat:stopped', 'headless:stopped', 'pty:stopped']);
    expect(app.events.slice(4)).toEqual(['sessions-saved', 'configs-flushed', 'config-restored']);
    // The chat session's write landed late and still made the flush.
    expect(app.disk.sort()).toEqual(['chat-session', 'headless-session', 'pty-session']);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a rejected stop and still runs the rest of shutdown', async () => {
    const app = fakeApp();
    const onError = vi.fn();
    await createShutdownCoordinator({
      plan: () => app.plan({ stop: [app.stops.pty, app.stops.chat, task('headless_stop', async () => { throw new Error('ESRCH'); })] }),
      onCleanupError: onError,
    }).run();
    expect(onError).toHaveBeenCalledWith('headless_stop', expect.objectContaining({ message: 'ESRCH' }));
    expect(app.events.slice(-3)).toEqual(['sessions-saved', 'configs-flushed', 'config-restored']);
    expect(app.disk.sort()).toEqual(['chat-session', 'pty-session']);
  });

  it('holds persistence back until a delayed stop settles', async () => {
    const app = fakeApp();
    const chat = deferred();
    const run = createShutdownCoordinator({
      plan: () => app.plan({ stop: [task('chat_stop', () => chat.promise, 10_000)] }),
      onCleanupError: vi.fn(),
    }).run();
    await new Promise((r) => setTimeout(r, 20));
    expect(app.events).toEqual(['launches-closed']);
    chat.resolve();
    await run;
    expect(app.events).toEqual(['launches-closed', 'sessions-saved', 'configs-flushed', 'config-restored']);
  });

  it('times out a stop stuck on a permission wait, and goes on', async () => {
    vi.useFakeTimers();
    const app = fakeApp();
    const onError = vi.fn();
    // A chat session waiting on a permission the user never answers.
    const waitingOnPermission = new Promise<void>(() => undefined);
    const run = createShutdownCoordinator({
      plan: () => app.plan({ stop: [app.stops.pty, task('chat_stop', () => waitingOnPermission, 10_000)] }),
      onCleanupError: onError,
    }).run();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(app.events).not.toContain('sessions-saved');
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(onError).toHaveBeenCalledWith('chat_stop', expect.objectContaining({ name: 'ShutdownTimeoutError' }));
    expect(app.events.slice(-3)).toEqual(['sessions-saved', 'configs-flushed', 'config-restored']);
    expect(app.disk).toEqual(['pty-session']);
  });

  it('times out a persist step that never settles, and still restores config', async () => {
    vi.useFakeTimers();
    const app = fakeApp();
    const onError = vi.fn();
    const run = createShutdownCoordinator({
      plan: () => app.plan({ persist: [task('checkpoint_drain', () => new Promise<void>(() => undefined), 5_000)] }),
      onCleanupError: onError,
    }).run();
    // The step's timeout starts once the stop phase (a 5ms fake chat stop) is done.
    await vi.advanceTimersByTimeAsync(5_100);
    await run;
    expect(onError).toHaveBeenCalledWith('checkpoint_drain', expect.objectContaining({ name: 'ShutdownTimeoutError' }));
    expect(app.events.at(-1)).toBe('config-restored');
  });

  it('waits for a delayed config restore before resolving', async () => {
    const app = fakeApp();
    const restore = deferred();
    let done = false;
    const run = createShutdownCoordinator({
      plan: () => app.plan({ restore: [task('config_restore', () => restore.promise, 10_000)] }),
      onCleanupError: vi.fn(),
    }).run().then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(app.events).toContain('configs-flushed');
    expect(done).toBe(false);
    restore.resolve();
    await run;
    expect(done).toBe(true);
  });

  it('a repeated quit joins the run in progress instead of starting another', async () => {
    const app = fakeApp();
    const planned = vi.fn(() => app.plan());
    const coordinator = createShutdownCoordinator({ plan: planned, onCleanupError: vi.fn() });
    const first = coordinator.run();
    const second = coordinator.run();
    expect(second).toBe(first);
    await Promise.all([first, second, coordinator.run()]);
    expect(planned).toHaveBeenCalledOnce();
    expect(app.events.filter((e) => e === 'pty:stopped')).toHaveLength(1);
  });

  it('runs again after reset (an update that failed to apply, then a quit)', async () => {
    const app = fakeApp();
    const coordinator = createShutdownCoordinator({ plan: () => app.plan(), onCleanupError: vi.fn() });
    await coordinator.run();
    coordinator.reset();
    expect(coordinator.started).toBe(false);
    await coordinator.run();
    expect(app.events.filter((e) => e === 'config-restored')).toHaveLength(2);
  });

  it('runs only the first caller\'s trailing tasks, after restore', async () => {
    const app = fakeApp();
    const coordinator = createShutdownCoordinator({ plan: () => app.plan(), onCleanupError: vi.fn() });
    const first = coordinator.run([task('update_apply_on_quit', async () => { app.events.push('apply-update'); })]);
    const joined = coordinator.run([task('update_apply_on_quit', async () => { app.events.push('never'); })]);
    await Promise.all([first, joined]);
    expect(app.events.slice(-2)).toEqual(['config-restored', 'apply-update']);
    expect(app.events).not.toContain('never');
  });
});

describe('before-quit handler', () => {
  it('holds the quit until shutdown, the update hand-off and the telemetry flush are done', async () => {
    const app = fakeApp();
    const coordinator = createShutdownCoordinator({ plan: () => app.plan(), onCleanupError: vi.fn() });
    const preventDefault = vi.fn();
    await new Promise<void>((resolve) => {
      createBeforeQuitHandler({
        shutdown: (after) => coordinator.run(after),
        applyUpdateOnQuit: async () => { app.events.push('apply-update'); },
        flushTelemetry: async () => { app.events.push('telemetry'); },
        appQuit: () => { app.events.push('quit'); resolve(); },
        onCleanupError: vi.fn(),
      })({ preventDefault });
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(app.events.slice(-5)).toEqual(['configs-flushed', 'config-restored', 'apply-update', 'telemetry', 'quit']);
  });

  it('lets its own second before-quit (from app.quit) through', async () => {
    const appQuit = vi.fn();
    let quitted!: () => void;
    const done = new Promise<void>((r) => (quitted = r));
    const handler = createBeforeQuitHandler({
      shutdown: async () => {},
      applyUpdateOnQuit: async () => {},
      appQuit: () => { appQuit(); quitted(); },
      onCleanupError: vi.fn(),
    });
    handler({ preventDefault: vi.fn() });
    await done;
    const second = vi.fn();
    handler({ preventDefault: second });
    expect(second).not.toHaveBeenCalled();
    expect(appQuit).toHaveBeenCalledOnce();
  });

  it('a quit during an update restart waits for the same shutdown', async () => {
    const app = fakeApp();
    const restore = deferred();
    const coordinator = createShutdownCoordinator({
      plan: () => app.plan({ restore: [task('config_restore', () => restore.promise, 10_000)] }),
      onCleanupError: vi.fn(),
    });
    const update = coordinator.run();
    let quit = false;
    createBeforeQuitHandler({
      shutdown: (after) => coordinator.run(after),
      applyUpdateOnQuit: async () => {},
      appQuit: () => { quit = true; },
      onCleanupError: vi.fn(),
    })({ preventDefault: vi.fn() });
    await new Promise((r) => setTimeout(r, 30));
    expect(quit).toBe(false);
    restore.resolve();
    await update;
    await new Promise((r) => setTimeout(r, 0));
    expect(quit).toBe(true);
    expect(app.events.filter((e) => e === 'pty:stopped')).toHaveLength(1);
  });

  it('waits for the real detached updater spawn before quitting with no running agents', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const events: string[] = [];
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
    const coordinator = createShutdownCoordinator({ plan: () => ({ stop: [], persist: [], restore: [] }), onCleanupError: vi.fn() });

    try {
      await new Promise<void>((resolve) => {
        createBeforeQuitHandler({
          shutdown: (after) => coordinator.run(after),
          applyUpdateOnQuit: () => applyUpdateOnQuit(update),
          appQuit: () => { events.push('quit'); resolve(); },
          onCleanupError: () => undefined,
        })({ preventDefault: vi.fn() });
      });
      expect(pathExists).toHaveBeenCalled();
      expect(events).toEqual(['spawn', 'quit']);
    } finally {
      platform.mockRestore();
    }
  });

  it('quits when update application rejects', async () => {
    const onError = vi.fn();
    const coordinator = createShutdownCoordinator({ plan: () => ({ stop: [], persist: [], restore: [] }), onCleanupError: onError });
    await new Promise<void>((resolve) => {
      createBeforeQuitHandler({
        shutdown: (after) => coordinator.run(after),
        applyUpdateOnQuit: () => Promise.reject(new Error('spawn failed')),
        appQuit: () => resolve(),
        onCleanupError: onError,
      })({ preventDefault: vi.fn() });
    });
    expect(onError).toHaveBeenCalledWith('apply update on quit', expect.any(Error));
  });

  it('quits after reporting a failed telemetry flush', async () => {
    const onError = vi.fn();
    const events: string[] = [];
    await new Promise<void>((resolve) => {
      createBeforeQuitHandler({
        shutdown: async () => {},
        applyUpdateOnQuit: async () => {},
        flushTelemetry: async () => {
          await new Promise((r) => setTimeout(r, 5));
          events.push('telemetry');
          throw new Error('exporter down');
        },
        appQuit: () => { events.push('quit'); resolve(); },
        onCleanupError: onError,
      })({ preventDefault: vi.fn() });
    });
    expect(events).toEqual(['telemetry', 'quit']);
    expect(onError).toHaveBeenCalledWith('flush telemetry', expect.any(Error));
  });
});

describe('shutdown deadline and reset (#2053 review)', () => {
  it('caps the whole run, skips what\'s left, and still restores config within its reserve', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const onError = vi.fn();
    const never = () => new Promise<void>(() => undefined);
    const run = createShutdownCoordinator({
      plan: () => ({
        stop: [task('chat_stop', never, 10_000)],
        persist: [task('session_capture', never, 5_000), task('agent_config_flush', async () => { events.push('flushed'); }, 5_000)],
        restore: [task('config_restore', async () => { events.push('restored'); }, 5_000)],
      }),
      onCleanupError: onError,
      deadlineMs: 12_000,
      restoreReserveMs: 3_000,
    }).run([task('update_apply_on_quit', async () => { events.push('applied'); }, 30_000)]);
    // Steps before the restore share 9s (12s minus the restore's 3s), so the
    // stop times out at 9s and the persist steps after it have nothing left.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(onError).toHaveBeenCalledWith('chat_stop', expect.objectContaining({ name: 'ShutdownTimeoutError' }));
    await vi.advanceTimersByTimeAsync(60_000);
    await run;
    const failures = onError.mock.calls.map(([label, err]) => `${label}:${(err as Error).name}`);
    expect(failures).toEqual([
      'chat_stop:ShutdownTimeoutError',
      'session_capture:ShutdownDeadlineError',
      'agent_config_flush:ShutdownDeadlineError',
    ]);
    // The restore still ran within its reserve; the trailing step ran in what was left.
    expect(events).toEqual(['restored', 'applied']);
  });

  it('names the step that ran out of time', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const run = createShutdownCoordinator({
      plan: () => ({ stop: [task('headless_stop', () => new Promise<void>(() => undefined), 8_000)], persist: [], restore: [] }),
      onCleanupError: onError,
      deadlineMs: 5_000,
    }).run();
    await vi.advanceTimersByTimeAsync(5_000);
    await run;
    expect(onError).toHaveBeenCalledWith('headless_stop', expect.objectContaining({ message: 'headless_stop did not finish within 5000ms' }));
  });

  it('drains in-flight spawns before stopping runtimes', async () => {
    const events: string[] = [];
    await createShutdownCoordinator({
      plan: () => ({
        drain: [task('spawn_drain', async () => { await new Promise((r) => setTimeout(r, 10)); events.push('spawns-settled'); })],
        stop: [task('pty_kill_all', async () => { events.push('stopped'); })],
        persist: [],
        restore: [],
      }),
      onCleanupError: vi.fn(),
    }).run();
    expect(events).toEqual(['spawns-settled', 'stopped']);
  });

  it('ignores reset while a run is in progress', async () => {
    const restore = deferred();
    const coordinator = createShutdownCoordinator({
      plan: () => ({ stop: [], persist: [], restore: [task('config_restore', () => restore.promise, 10_000)] }),
      onCleanupError: vi.fn(),
    });
    const first = coordinator.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(coordinator.reset()).toBe(false);
    expect(coordinator.run()).toBe(first);
    restore.resolve();
    await first;
    expect(coordinator.reset()).toBe(true);
  });
});
