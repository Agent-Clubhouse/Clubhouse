import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAppLifecycle, LifecycleTimeoutError, type AppLifecycleDeps, type LifecycleStep } from './app-lifecycle';

/**
 * Contract tests for the app lifecycle coordinator (#2053): fake PTY, chat and
 * headless participants prove that exit (the caller's `.then`) can never
 * overtake runtime stops, persistence drains or config restoration.
 */

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A fake runtime with live sessions; stop() ends them after `gate` settles. */
function fakeRuntime(name: string, events: string[], gate?: Promise<void>) {
  let live = true;
  const step: LifecycleStep & { stop: ReturnType<typeof vi.fn>; isLive: () => boolean } = {
    name,
    stop: vi.fn(),
    isLive: () => live,
    run: async () => {
      step.stop();
      events.push(`${name}:stop`);
      await gate;
      live = false;
      events.push(`${name}:stopped`);
    },
  };
  return step;
}

function setup(overrides: Partial<AppLifecycleDeps> & { events?: string[] } = {}) {
  const events = overrides.events ?? [];
  const pty = fakeRuntime('pty', events);
  const chat = fakeRuntime('chat', events);
  const headless = fakeRuntime('headless', events);
  const onStepError = vi.fn();
  const setLaunchesBlocked = vi.fn((blocked: boolean) => events.push(blocked ? 'launches:blocked' : 'launches:open'));
  const deps: AppLifecycleDeps = {
    setLaunchesBlocked,
    runtimes: [pty, chat, headless],
    drains: [
      { name: 'session captures', run: async () => { events.push('drain:sessions'); } },
      { name: 'chat transcripts', run: async () => { events.push('drain:transcripts'); } },
      { name: 'checkpoints', run: async () => { events.push('drain:checkpoints'); } },
    ],
    restoreConfig: async () => { events.push('restore'); },
    onStepError,
    ...overrides,
  };
  return { lifecycle: createAppLifecycle(deps), events, pty, chat, headless, onStepError, setLaunchesBlocked };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('app lifecycle coordinator', () => {
  it('stops mixed PTY, chat and headless runtimes, then drains, then restores, then exits', async () => {
    const { lifecycle, events, pty, chat, headless } = setup();

    await lifecycle.shutdown({ reason: 'quit' }).then(() => events.push('exit'));

    expect(pty.stop).toHaveBeenCalledOnce();
    expect(chat.stop).toHaveBeenCalledOnce();
    expect(headless.stop).toHaveBeenCalledOnce();
    expect(events[0]).toBe('launches:blocked');
    const last = (prefix: string) => events.map((e, i) => (e.startsWith(prefix) ? i : -1)).reduce((a, b) => Math.max(a, b));
    const first = (prefix: string) => events.findIndex((e) => e.startsWith(prefix));
    // Every runtime has stopped before any drain begins.
    expect(last('pty:stopped')).toBeLessThan(first('drain:'));
    expect(last('chat:stopped')).toBeLessThan(first('drain:'));
    expect(last('headless:stopped')).toBeLessThan(first('drain:'));
    // Restore follows every drain; exit follows restore.
    expect(last('drain:')).toBeLessThan(events.indexOf('restore'));
    expect(events.slice(-2)).toEqual(['restore', 'exit']);
  });

  it('stops runtimes in parallel and waits for the slowest', async () => {
    const events: string[] = [];
    const slowChat = deferred();
    const { lifecycle } = setup({
      events,
      runtimes: [fakeRuntime('pty', events), fakeRuntime('chat', events, slowChat.promise), fakeRuntime('headless', events)],
    });
    let exited = false;
    const done = lifecycle.shutdown({ reason: 'quit' }).then(() => { exited = true; });
    await flush();

    // All three were asked to stop at once; the slow chat holds the rest back.
    expect(events).toEqual(expect.arrayContaining(['pty:stop', 'chat:stop', 'headless:stop', 'pty:stopped', 'headless:stopped']));
    expect(events).not.toContain('drain:sessions');
    expect(exited).toBe(false);

    slowChat.resolve();
    await done;
    expect(events.indexOf('chat:stopped')).toBeLessThan(events.indexOf('drain:sessions'));
    expect(exited).toBe(true);
  });

  it('a rejected stop is reported and does not stop the other runtimes, drains or restore', async () => {
    const events: string[] = [];
    const failure = new Error('driver close failed');
    const { lifecycle, onStepError } = setup({
      events,
      runtimes: [
        fakeRuntime('pty', events),
        { name: 'chat', run: async () => { events.push('chat:stop'); throw failure; } },
        fakeRuntime('headless', events),
      ],
    });

    await lifecycle.shutdown({ reason: 'quit' });

    expect(onStepError).toHaveBeenCalledWith('stop', 'chat', failure);
    expect(events).toEqual(expect.arrayContaining(['pty:stopped', 'headless:stopped', 'drain:transcripts', 'restore']));
  });

  it('a synchronous throw from a participant is contained like a rejection', async () => {
    const { lifecycle, events, onStepError } = setup({
      runtimes: [{ name: 'pty', run: () => { throw new Error('boom'); } }],
    });

    await lifecycle.shutdown({ reason: 'quit' });

    expect(onStepError).toHaveBeenCalledWith('stop', 'pty', expect.objectContaining({ message: 'boom' }));
    expect(events).toContain('restore');
  });

  it('a delayed config restore holds the exit until it finishes', async () => {
    const restore = deferred();
    const events: string[] = [];
    const { lifecycle } = setup({
      events,
      restoreConfig: async () => { events.push('restore:start'); await restore.promise; events.push('restore:done'); },
    });

    const done = lifecycle.shutdown({ reason: 'quit' }).then(() => events.push('exit'));
    await vi.waitFor(() => expect(events).toContain('restore:start'));
    await flush();
    expect(events).not.toContain('exit');

    restore.resolve();
    await done;
    expect(events.slice(-2)).toEqual(['restore:done', 'exit']);
  });

  it('drains wait for runtime stops: a chat session end written during stop is flushed', async () => {
    // Chat's stop appends session_ended to its transcript; the transcript
    // drain must start only after that append was queued.
    const pending: Array<Promise<void>> = [];
    const written: string[] = [];
    const { lifecycle } = setup({
      runtimes: [{
        name: 'chat',
        run: async () => {
          pending.push(new Promise<void>((r) => setTimeout(() => { written.push('session_ended'); r(); }, 5)));
        },
      }],
      drains: [{ name: 'chat transcripts', run: async () => { await Promise.all(pending); } }],
      restoreConfig: async () => { written.push('restore'); },
    });

    await lifecycle.shutdown({ reason: 'quit' });

    expect(written).toEqual(['session_ended', 'restore']);
  });

  it('a chat stop settles a pending permission instead of waiting for the user', async () => {
    // Model of ChatAgentRuntime: a turn blocked on a permission answer that
    // never comes. stop() settles it (deny) and ends the session.
    const events: string[] = [];
    let answerPermission!: (decision: 'allow' | 'deny') => void;
    const permission = new Promise<'allow' | 'deny'>((r) => { answerPermission = r; });
    const turn = permission.then((decision) => events.push(`permission:${decision}`));
    const chat: LifecycleStep = {
      name: 'chat',
      run: async () => {
        answerPermission('deny');
        await turn;
        events.push('chat:session_ended');
      },
    };
    const { lifecycle } = setup({ events, runtimes: [chat] });

    await lifecycle.shutdown({ reason: 'quit' });

    expect(events.indexOf('permission:deny')).toBeLessThan(events.indexOf('chat:session_ended'));
    expect(events.indexOf('chat:session_ended')).toBeLessThan(events.indexOf('restore'));
  });

  it('a runtime stuck on a permission wait times out without blocking the others', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const neverAnswered = new Promise<void>(() => {});
    const { lifecycle, onStepError } = setup({
      events,
      runtimes: [fakeRuntime('pty', events, neverAnswered), fakeRuntime('chat', events), fakeRuntime('headless', events)],
      timeouts: { stopMs: 1_000 },
    });

    let finished = false;
    const done = lifecycle.shutdown({ reason: 'quit' }).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(finished).toBe(false);
    expect(events).not.toContain('restore');

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(onStepError).toHaveBeenCalledWith('stop', 'pty', expect.any(LifecycleTimeoutError));
    expect(events).toEqual(expect.arrayContaining(['chat:stopped', 'headless:stopped', 'drain:checkpoints', 'restore']));
  });

  it('bounds every phase: stuck capture, drain and restore each time out in turn', async () => {
    vi.useFakeTimers();
    const never = (): Promise<void> => new Promise(() => {});
    const { lifecycle, onStepError } = setup({
      drains: [{ name: 'checkpoints', run: never }],
      restoreConfig: never,
      timeouts: { captureMs: 100, stopMs: 100, drainMs: 200, restoreMs: 300 },
    });

    let finished = false;
    const done = lifecycle.shutdown({ reason: 'update', captureResumeState: never }).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(100 + 200 + 299);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(onStepError.mock.calls.map(([phase, name]) => `${phase}:${name}`)).toEqual([
      'capture:resume state', 'drain:checkpoints', 'restore:config restore',
    ]);
  });

  it('repeated quit shares one shutdown: runtimes stop once and every caller waits for restore', async () => {
    const restore = deferred();
    const events: string[] = [];
    const { lifecycle, pty, chat, headless } = setup({ events, restoreConfig: () => restore.promise.then(() => { events.push('restore'); }) });

    const first = lifecycle.shutdown({ reason: 'quit' });
    const second = lifecycle.shutdown({ reason: 'quit' });
    expect(second).toBe(first);
    expect(lifecycle.isShuttingDown()).toBe(true);

    let secondDone = false;
    void second.then(() => { secondDone = true; });
    await flush();
    expect(secondDone).toBe(false);

    restore.resolve();
    await Promise.all([first, second]);
    // And again after it finished: still the same, completed shutdown.
    await lifecycle.shutdown({ reason: 'quit' });

    expect(pty.stop).toHaveBeenCalledOnce();
    expect(chat.stop).toHaveBeenCalledOnce();
    expect(headless.stop).toHaveBeenCalledOnce();
    expect(events.filter((e) => e === 'restore')).toHaveLength(1);
  });

  it('update-triggered exit: capture sees live runtimes, the updater hook joins the same shutdown, exit comes last', async () => {
    const events: string[] = [];
    const { lifecycle, pty, chat, headless } = setup({ events });
    const capture = vi.fn(async () => {
      // Resume capture reads native session ids, so runtimes must still be live.
      events.push(`capture:${[pty, chat, headless].every((r) => r.isLive()) ? 'live' : 'stopped'}`);
    });

    // CONFIRM_UPDATE_RESTART: capture + drain, then applyUpdate...
    await lifecycle.shutdown({ reason: 'update', captureResumeState: capture });
    // ...whose beforeApply hook (setApplyLifecycle) awaits the same shutdown
    // right before the platform handler calls app.exit.
    await lifecycle.shutdown({ reason: 'update' }).then(() => events.push('app.exit'));

    expect(capture).toHaveBeenCalledOnce();
    expect(events.indexOf('launches:blocked')).toBeLessThan(events.indexOf('capture:live'));
    expect(events.indexOf('capture:live')).toBeLessThan(events.indexOf('pty:stop'));
    expect(events.slice(-2)).toEqual(['restore', 'app.exit']);
    expect(pty.stop).toHaveBeenCalledOnce();
  });

  it('an aborted update reopens launches, and a later quit shuts down again', async () => {
    const { lifecycle, events, pty, setLaunchesBlocked } = setup();

    await lifecycle.shutdown({ reason: 'update' });
    lifecycle.abort();
    expect(setLaunchesBlocked).toHaveBeenLastCalledWith(false);
    expect(lifecycle.isShuttingDown()).toBe(false);

    await lifecycle.shutdown({ reason: 'quit' });
    expect(pty.stop).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e === 'launches:blocked')).toHaveLength(2);
  });

  it('never rejects, even when the reporting hooks throw', async () => {
    const { lifecycle } = setup({
      setLaunchesBlocked: () => { throw new Error('a'); },
      onStepError: () => { throw new Error('b'); },
      onPhase: () => { throw new Error('c'); },
      restoreConfig: async () => { throw new Error('restore failed'); },
    });

    await expect(lifecycle.shutdown({ reason: 'quit' })).resolves.toBeUndefined();
  });
});
