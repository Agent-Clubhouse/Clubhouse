import { describe, expect, it, vi } from 'vitest';
import { AcceptedWork, FixtureWork, preservingFailure, withFixtureWork } from '../../../test/dispatcher-work-owner';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Attach both handlers before returning a directly owned test operation. */
function observed<T>(promise: Promise<T>) {
  const result = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { promise, result };
}

describe('isolated Dispatcher ownership groundwork', () => {
  it('keeps full roots and a later descendant pending without polling or fixed microtask counts', async () => {
    const owner = new AcceptedWork();
    const parentGate = deferred<void>();
    const childGate = deferred<void>();
    const childStarted = deferred<void>();
    const parent = observed(owner.observe((async () => {
      await parentGate.promise;
      owner.observe(childGate.promise); // Detached but registered before parent completes.
      childStarted.resolve();
    })()));
    const drain = observed(owner.settle());
    await preservingFailure(async () => {
      expect(() => owner.assertSettled()).toThrow(/incomplete/);
      parentGate.resolve();
      expect(await Promise.race([childStarted.promise.then(() => true), parent.result.then(() => false)])).toBe(true);
      expect((await parent.result).ok).toBe(true);
      expect(() => owner.assertSettled()).toThrow(/incomplete/);
      childGate.resolve();
      expect((await drain.result).ok).toBe(true);
      owner.assertSettled();
    }, async () => {
      parentGate.resolve();
      childGate.resolve();
      await parent.result;
      await drain.result;
    });
  });

  it('returns the exact rejected promise and treats an expected undefined rejection as settlement', async () => {
    const owner = new AcceptedWork();
    const gate = deferred<void>();
    const original = gate.promise;
    expect(owner.observe(original)).toBe(original);
    const caller = observed(original);
    await preservingFailure(async () => {
      gate.reject(undefined);
      expect(await caller.result).toEqual({ ok: false, error: undefined });
      await owner.settle();
      expect(owner.rejected).toBe(1);
      owner.assertSettled();
    }, async () => {
      gate.resolve();
      await caller.result;
      await owner.settle();
    });
  });

  it('retires only the epoch so body and setup roots awaiting restart never await themselves', async () => {
    const fixture = new FixtureWork();
    const stopped = vi.fn();
    const epoch = fixture.epoch(stopped);
    const gate = deferred<void>();
    epoch.work.observe(gate.promise);
    const mutation = vi.fn();
    const setup = fixture.roots.observe(fixture.restart(epoch, mutation));
    const setupResult = observed(setup);
    await preservingFailure(async () => {
      expect(mutation).not.toHaveBeenCalled();
      gate.resolve();
      expect((await setupResult.result).ok).toBe(true);
      expect(mutation).toHaveBeenCalledTimes(1);
      expect(stopped).toHaveBeenCalledTimes(1);
    }, async () => {
      gate.resolve();
      await setupResult.result;
      await fixture.close();
    });
  });

  it('closing blocks a late restart/new epoch and mutation until all setup descendants settle', async () => {
    const fixture = new FixtureWork();
    const epoch = fixture.epoch(vi.fn());
    const gate = deferred<void>();
    epoch.work.observe(gate.promise);
    fixture.releaseOnClose(() => gate.resolve());
    const mutation = vi.fn();
    const setup = observed(fixture.roots.observe(fixture.restart(epoch, mutation)));
    const close = observed(fixture.close());
    await preservingFailure(async () => {
      expect(() => fixture.epoch(vi.fn())).toThrow(/closing/);
      expect(() => fixture.admitNext(mutation)).toThrow(/incomplete/);
      expect((await setup.result).ok).toBe(false);
      expect((await close.result).ok).toBe(true); // Setup rejection is not lost accounting.
      expect(mutation).not.toHaveBeenCalled();
      fixture.admitNext(mutation);
      expect(mutation).toHaveBeenCalledTimes(1);
    }, async () => {
      gate.resolve();
      await setup.result;
      await close.result;
    });
  });

  it('refuses admission before mutation when an observer cannot account for a promise', async () => {
    const fixture = new FixtureWork();
    const epoch = fixture.epoch(vi.fn());
    const broken = Object.defineProperty({}, 'then', { get() { throw undefined; } }) as Promise<void>;
    expect(epoch.work.observe(broken)).toBe(broken);
    const close = observed(fixture.close());
    const mutateBase = vi.fn();
    expect((await close.result).ok).toBe(false);
    expect(() => fixture.admitNext(mutateBase)).toThrow(/incomplete/);
    expect(mutateBase).not.toHaveBeenCalled();
  });

  it('keeps an empty epoch open for descendants of a still-running case root during close', async () => {
    const fixture = new FixtureWork();
    const epoch = fixture.epoch(vi.fn());
    const parentGate = deferred<void>();
    const childGate = deferred<void>();
    const childStarted = deferred<void>();
    fixture.releaseOnClose(() => parentGate.resolve());
    const root = observed(fixture.roots.observe((async () => {
      await parentGate.promise;
      epoch.work.observe(childGate.promise);
      childStarted.resolve();
    })()));
    const close = observed(fixture.close());
    await preservingFailure(async () => {
      expect(await Promise.race([childStarted.promise.then(() => true), root.result.then(() => false)])).toBe(true);
      expect((await root.result).ok).toBe(true);
      expect(() => fixture.admitNext(vi.fn())).toThrow(/incomplete/);
      childGate.resolve();
      expect((await close.result).ok).toBe(true);
      fixture.assertSettled();
    }, async () => {
      parentGate.resolve();
      childGate.resolve();
      await root.result;
      await close.result;
    });
  });

  it('preserves thrown undefined ahead of a stop failure and still releases owned gates', async () => {
    const release = vi.fn();
    const operation = observed(withFixtureWork(async (fixture) => {
      const epoch = fixture.epoch(() => { throw new Error('stop failure'); });
      const gate = deferred<void>();
      epoch.work.observe(gate.promise);
      fixture.releaseOnClose(() => { release(); gate.resolve(); });
      throw undefined;
    }));
    expect(await operation.result).toEqual({ ok: false, error: undefined });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
