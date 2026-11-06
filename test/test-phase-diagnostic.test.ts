import { AsyncResource } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestPhaseDiagnostic, traceTestPhase, withTestPhaseDiagnostic } from './test-phase-diagnostic';

const hooks = vi.hoisted(() => ({ disables: 0 }));
vi.mock('node:async_hooks', async (original) => {
  const actual = await original<typeof import('node:async_hooks')>();
  return { ...actual, createHook: (options: Parameters<typeof actual.createHook>[0]) => {
    const hook = actual.createHook(options);
    const disable = hook.disable.bind(hook);
    hook.disable = () => { hooks.disables++; return disable(); };
    return hook;
  } };
});

const cleanups: Array<() => void> = [];
beforeEach(() => { hooks.disables = 0; });
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); });

function fixture(emit = vi.fn<(line: string) => void>()) {
  const controller = new AbortController();
  let finished = () => {}, failed = () => {};
  const diagnostic = startTestPhaseDiagnostic({
    signal: controller.signal,
    onTestFinished: (handler) => { finished = handler; },
    onTestFailed: (handler) => { failed = handler; },
  }, 'fixture', emit);
  cleanups.push(diagnostic.dispose);
  return { diagnostic, controller, emit, finish: () => finished(), fail: () => failed() };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('test-only stalled-phase observer', () => {
  it.each([false, true])('disables the scoped test wrapper before cleanup on rejection=%s', async (reject) => {
    const original = new Error('original');
    const wrapped = withTestPhaseDiagnostic('fixture', async () => { if (reject) throw original; });
    const operation = wrapped({ signal: new AbortController().signal, onTestFinished: () => {}, onTestFailed: () => {} });
    if (reject) await expect(operation).rejects.toBe(original);
    else await operation;
    expect(hooks.disables).toBeGreaterThan(0);
  });

  it('freezes delayed audit/FS state on abort, before simulated cleanup settles it', async () => {
    const f = fixture();
    const wait = deferred();
    let resource!: AsyncResource;
    const operation = f.diagnostic.step('catalog.audit', () => {
      resource = new AsyncResource('FSREQPROMISE');
      return wait.promise;
    });
    f.diagnostic.note('polls', 3);
    expect(() => f.controller.abort(new Error('private timeout reason'))).not.toThrow();
    const captured = f.diagnostic.snapshot();
    expect(captured.live).toEqual([{ phase: 'catalog.audit', ageMs: expect.any(Number) }]);
    expect(captured.pendingFs).toEqual([{ phase: 'catalog.audit', kind: 'FSREQPROMISE', ageMs: expect.any(Number) }]);
    resource.emitDestroy();
    wait.resolve();
    await operation;
    f.finish();
    f.fail();
    expect(f.diagnostic.snapshot()).toBe(captured);
    expect(Object.isFrozen(captured.counters)).toBe(true);
    expect(f.emit).toHaveBeenCalledTimes(1);
    expect(f.emit.mock.calls[0][0]).not.toContain('private timeout reason');
    expect(hooks.disables).toBeGreaterThan(0);
  });

  it('preserves rejection identity and finally cleanup, recording only an allowlisted errno', async () => {
    const f = fixture();
    const cleanup = vi.fn();
    const original = Object.assign(new Error('/private/fixture payload token'), { code: 'EPERM' });
    const operation = f.diagnostic.step('catalog.rename', async () => {
      try { throw original; } finally { cleanup(); }
    });
    await expect(operation).rejects.toBe(original);
    f.finish();
    f.fail();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(f.diagnostic.snapshot().recent.at(-1)).toMatchObject({ event: 'rejected', code: 'EPERM' });
    expect(f.emit.mock.calls[0][0]).not.toMatch(/private|payload|token/);
    expect(hooks.disables).toBeGreaterThan(0);
  });

  it('observes nested transport/poll metadata, preserves results and emits nothing on success', async () => {
    const f = fixture();
    const result = { sensitive: 'not part of diagnostics' };
    await expect(f.diagnostic.step('sdk.case', async () => {
      f.diagnostic.increment('polls');
      f.diagnostic.note('reports', 1);
      return traceTestPhase('transport.report', () => result);
    })).resolves.toBe(result);
    f.finish();
    expect(f.emit).not.toHaveBeenCalled();
    expect(f.diagnostic.snapshot().counters).toEqual({ polls: 1, reports: 1 });
    expect(JSON.stringify(f.diagnostic.snapshot())).not.toContain(result.sensitive);
    expect(hooks.disables).toBeGreaterThan(0);
  });

  it('caps phase history, live phases and scoped FS requests, excluding unrelated resources', async () => {
    const f = fixture();
    const wait = deferred();
    const resources: AsyncResource[] = [];
    const work: Promise<unknown>[] = [];
    new AsyncResource('FSREQPROMISE').emitDestroy(); // outside the observed scope
    await f.diagnostic.step('fixture.root', () => {
      for (let i = 0; i < 160; i++) resources.push(new AsyncResource('FSREQPROMISE'));
      resources.push(new AsyncResource('UNRELATED'));
      for (let i = 0; i < 96; i++) work.push(f.diagnostic.step('fixture.pending', () => wait.promise));
    });
    const captured = f.diagnostic.snapshot();
    expect(captured.live.length).toBeLessThanOrEqual(64);
    expect(captured.recent).toHaveLength(32);
    expect(captured.pendingFsCount).toBe(128);
    expect(captured.pendingFs).toHaveLength(32);
    expect(captured.droppedFs).toBe(32);
    expect(captured.droppedPhases).toBeGreaterThan(0);
    f.finish();
    resources.forEach((resource) => resource.emitDestroy());
    wait.resolve();
    await Promise.all(work);
    expect(hooks.disables).toBeGreaterThan(0);
  });

  it('contains sink and error-inspection failures without throwing from observer callbacks', async () => {
    const f = fixture(vi.fn(() => { throw new Error('sink failed'); }));
    const original = Object.defineProperty(new Error('secret'), 'code', { get() { throw new Error('getter failed'); } });
    await expect(f.diagnostic.step('transport.report', () => Promise.reject(original))).rejects.toBe(original);
    expect(() => f.controller.abort()).not.toThrow();
    expect(() => f.finish()).not.toThrow();
    expect(() => f.fail()).not.toThrow();
    expect(hooks.disables).toBeGreaterThan(0);
  });

  it('contains an actual async_hooks callback failure and disables that hook', async () => {
    const f = fixture();
    await f.diagnostic.step('fixture.root', () => {
      vi.spyOn(performance, 'now').mockImplementationOnce(() => { throw new Error('observer clock failed'); });
      expect(() => new AsyncResource('FSREQPROMISE').emitDestroy()).not.toThrow();
    });
    expect(f.diagnostic.snapshot().observerErrors).toBe(1);
    expect(hooks.disables).toBeGreaterThan(0);
    expect(() => f.finish()).not.toThrow();
  });
});
