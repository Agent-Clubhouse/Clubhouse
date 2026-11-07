import { describe, expect, it, vi } from 'vitest';
import { AcceptedWork, FixtureWork, ownedRegistration, preservingFailure, withFixtureWork } from '../../../test/dispatcher-work-owner';

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


describe('serial Dispatcher harness registration ownership', () => {
  it('preserves raw callback identity metadata, receiver, arguments, return and plain/each registration options', async () => {
    const raw = deferred<void>();
    const rawResult = observed(raw.promise);
    const receiver = {};
    let registered!: (this: object, value: string) => Promise<void>;
    let optionsSeen: unknown;
    let nameSeen = '';
    const options = { timeout: 1234 };
    const rows = ['row'];
    let rowsSeen: unknown;
    function register(name: string, callback: typeof registered, config: typeof options) {
      nameSeen = name;
      registered = callback;
      optionsSeen = config;
    }
    const registrar = Object.assign(register, { each: (cases: typeof rows) => { rowsSeen = cases; return register; } });
    const accept = vi.fn();
    const wrapped = ownedRegistration(registrar, 1, accept);
    function original(this: object, value: string) {
      expect(this).toBe(receiver);
      expect(value).toBe('argument');
      return raw.promise;
    }
    await preservingFailure(async () => {
      expect(wrapped('plain', original, options)).toBeUndefined();
      expect(nameSeen).toBe('plain');
      expect(optionsSeen).toBe(options);
      expect(registered.name).toBe(original.name);
      expect(registered.length).toBe(original.length);
      expect(registered.call(receiver, 'argument')).toBe(raw.promise);
      expect(accept).toHaveBeenLastCalledWith(raw.promise);
      wrapped.each(rows)('each %s', original, options);
      expect(rowsSeen).toBe(rows);
      expect(nameSeen).toBe('each %s');
      expect(optionsSeen).toBe(options);
      expect(registered.call(receiver, 'argument')).toBe(raw.promise);
      const throwsUndefined = () => { throw undefined; };
      wrapped('throws', throwsUndefined, options);
      let thrown = false;
      let error: unknown;
      try { registered.call(receiver, 'argument'); } catch (caught) { thrown = true; error = caught; }
      expect(thrown).toBe(true);
      expect(error).toBeUndefined();
      expect(accept).toHaveBeenCalledTimes(2);
    }, async () => { raw.resolve(); await rawResult.result; });
  });

  it('a simulated outer timeout cannot admit mutation while the raw body and its late restart remain live', async () => {
    const fixture = new FixtureWork();
    const epoch = fixture.epoch(vi.fn());
    const bodyGate = deferred<void>();
    const childGate = deferred<void>();
    const childStarted = deferred<void>();
    const timeout = deferred<void>();
    let callback!: () => Promise<void>;
    const register = ownedRegistration((body: typeof callback) => { callback = body; }, 0, (promise) => { fixture.roots.observe(promise); });
    const mutateBase = vi.fn();
    register(async () => {
      await bodyGate.promise;
      epoch.work.observe(childGate.promise);
      childStarted.resolve();
      await fixture.restart(epoch, mutateBase);
    });
    const raw = observed(callback()); // Immediate observation before any rejection can run.
    const outer = observed(Promise.race([raw.promise, timeout.promise]));
    const close = observed(fixture.close()); // Deliberately NOT a root it would await.
    await preservingFailure(async () => {
      timeout.reject(undefined);
      expect(await outer.result).toEqual({ ok: false, error: undefined });
      expect(() => fixture.admitNext(mutateBase)).toThrow(/incomplete/);
      expect(() => fixture.start(mutateBase)).toThrow(/cannot start/);
      bodyGate.resolve();
      expect(await Promise.race([childStarted.promise.then(() => true), raw.result.then(() => false)])).toBe(true);
      expect(() => fixture.admitNext(mutateBase)).toThrow(/incomplete/);
      childGate.resolve();
      expect((await raw.result).ok).toBe(false); // Closing refuses the late restart.
      expect((await close.result).ok).toBe(true); // Rejection is accounted settlement.
      expect(mutateBase).not.toHaveBeenCalled();
      fixture.admitNext(mutateBase);
      expect(mutateBase).toHaveBeenCalledTimes(1);
    }, async () => {
      timeout.resolve();
      bodyGate.resolve();
      childGate.resolve();
      await outer.result;
      await raw.result;
      await close.result;
    });
  });

  it('a rejected setup root keeps its accepted epoch descendant alive before teardown admission', async () => {
    const fixture = new FixtureWork();
    const epoch = fixture.epoch(vi.fn());
    const childGate = deferred<void>();
    let setup!: () => Promise<void>;
    const registerSetup = ownedRegistration((body: typeof setup) => { setup = body; }, 0, (promise) => { fixture.roots.observe(promise); });
    registerSetup(async () => {
      epoch.work.observe(childGate.promise);
      throw undefined;
    });
    const result = observed(setup());
    const close = observed(fixture.close());
    const mutateBase = vi.fn();
    await preservingFailure(async () => {
      expect(await result.result).toEqual({ ok: false, error: undefined });
      expect(() => fixture.admitNext(mutateBase)).toThrow(/incomplete/);
      expect(mutateBase).not.toHaveBeenCalled();
      childGate.resolve();
      expect((await close.result).ok).toBe(true);
      fixture.admitNext(mutateBase);
      expect(mutateBase).toHaveBeenCalledTimes(1);
    }, async () => {
      childGate.resolve();
      await result.result;
      await close.result;
    });
  });
});
