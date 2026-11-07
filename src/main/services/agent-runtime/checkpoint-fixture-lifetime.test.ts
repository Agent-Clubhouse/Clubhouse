import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { CheckpointFixtureLifetime, ownCheckpointExecFile } from '../../../../test/checkpoint-fixture-lifetime';
import { preservingFailure } from '../../../../test/dispatcher-work-owner';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
function observed<T>(promise: Promise<T>): Promise<Outcome<T>> {
  // Observe rejection immediately, including undefined; cleanup can await this
  // receipt even when an earlier assertion fails before the intended await.
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}


/** No entry-only wait may strand the cleanup body when its producer fails early. */
async function enteredOrSettled(entry: Promise<void>, owner: Promise<Outcome<unknown>>): Promise<void> {
  const first = await Promise.race([
    entry.then(() => ({ entered: true as const })),
    owner.then((outcome) => ({ entered: false as const, outcome })),
  ]);
  if (first.entered === false) {
    if (first.outcome.ok === false) throw first.outcome.error; // Preserve thrown undefined.
    throw new Error('Owned producer settled before gate entry');
  }
}

describe('checkpoint fixture lifetime (fake producers only)', () => {
  it('retains late raw/direct/event admissions until callback AND close, before retiring the captured fixture', async () => {
    const owner = new CheckpointFixtureLifetime();
    const rawGate = gate();
    const directGate = gate();
    const idleEntered = gate();
    let cleanup = false;
    let retired = false;
    let base = 'captured-old';
    const nextFixture = () => { owner.assertRetired(); base = 'new'; };
    let idleCalls = 0;
    let child: ReturnType<CheckpointFixtureLifetime['child']> | undefined;
    let direct: Promise<unknown> | undefined;
    const raw = observed(owner.observeRaw((async () => {
      await rawGate.promise;
      direct = observed(owner.observeDirect((async () => {
        await directGate.promise;
        owner.event();
      })()));
    })()));
    const closed = observed(owner.close(() => {
      idleCalls++;
      if (!child) {
        child = owner.child(true);
        if (cleanup) { child.callback(); child.close(); }
      }
      idleEntered.release();
      return Promise.resolve();
    }, () => { retired = true; }));
    await preservingFailure(async () => {
      expect(idleCalls).toBe(0); // Cannot skip a still-held raw body.
      // Models a runner abandoning the closing hook and attempting next setup;
      // it does not execute a real framework timeout or change its deadline.
      expect(nextFixture).toThrow();
      expect(base).toBe('captured-old');
      expect(() => owner.assertRetired()).toThrow();
      rawGate.release();
      await raw;
      expect(owner.evidence().teardown.directPending).toBe(1);
      directGate.release();
      await enteredOrSettled(idleEntered.promise, closed);
      expect(retired).toBe(false);
      expect(owner.evidence().teardown.childPending).toBe(1);
      child!.callback();
      expect(owner.evidence().teardown.callbackPending).toBe(0);
      expect(owner.evidence().teardown.closePending).toBe(1);
      expect(() => owner.assertRetired()).toThrow();
      child!.close();
      expect((await closed).ok).toBe(true);
      expect(retired).toBe(true);
      nextFixture();
      expect(base).toBe('new');
      owner.assertRetired();
    }, async () => {
      cleanup = true;
      idleEntered.release();
      rawGate.release();
      directGate.release();
      child?.callback();
      child?.close();
      await raw;
      await direct;
      await closed;
    });
  });

  it('keeps fail-fast siblings reserved after direct rejection, including close before callback', async () => {
    const owner = new CheckpointFixtureLifetime();
    const child = owner.child(true);
    const direct = observed(owner.observeDirect(Promise.reject(undefined)));
    const idleEntered = gate();
    let retired = false;
    const closed = observed(owner.close(() => { idleEntered.release(); return Promise.resolve(); }, () => { retired = true; }));
    await preservingFailure(async () => {
      expect(await direct).toEqual({ ok: false, error: undefined });
      await enteredOrSettled(idleEntered.promise, closed);
      child.close();
      expect(owner.evidence().teardown.closePending).toBe(0);
      expect(owner.evidence().teardown.callbackPending).toBe(1);
      expect(() => owner.assertRetired()).toThrow();
      expect(retired).toBe(false);
      child.callback();
      expect((await closed).ok).toBe(true);
      owner.assertRetired();
    }, async () => { idleEntered.release(); child.callback(); child.close(); await direct; await closed; });
  });

  it('excludes the raw body from its epoch controller and refuses late cwd/cache mutation after closing', async () => {
    const owner = new CheckpointFixtureLifetime();
    const ready = gate();
    const resume = gate();
    let mutation = false;
    const raw = observed(owner.observeRaw((async () => {
      await owner.settleEpoch(() => Promise.resolve());
      ready.release();
      await resume.promise;
      owner.mutateEpoch(() => { mutation = true; });
    })()));
    let closed: Promise<Outcome<void>> | undefined;
    await preservingFailure(async () => {
      await enteredOrSettled(ready.promise, raw); // Reaching here proves there was no raw self-await.
      closed = observed(owner.close(() => Promise.resolve(), () => {}));
      expect(() => owner.assertRetired()).toThrow();
      resume.release();
      const result = await raw;
      expect(result.ok).toBe(false);
      if (result.ok === false) expect(result.error).toEqual(new Error('Checkpoint fixture is closing'));
      expect(mutation).toBe(false);
      await closed;
      owner.assertRetired();
    }, async () => {
      ready.release();
      resume.release();
      await raw;
      closed ??= observed(owner.close(() => Promise.resolve(), () => {}));
      await closed;
    });
  });

  it('invalidates a completed epoch boundary when another event is admitted before mutation', async () => {
    const owner = new CheckpointFixtureLifetime();
    await preservingFailure(async () => {
      await owner.settleEpoch(() => Promise.resolve());
      owner.event();
      expect(() => owner.mutateEpoch(() => { throw new Error('must not mutate'); })).toThrow('admitted late work');
      await owner.settleEpoch(() => Promise.resolve());
      let mutated = false;
      owner.mutateEpoch(() => { mutated = true; });
      expect(mutated).toBe(true);
    }, async () => { await observed(owner.close(() => Promise.resolve(), () => {})); });
  });

  it('preserves delegated handle/property/overload shape, receiver/arguments and callback return/throw behavior', async () => {
    const owner = new CheckpointFixtureLifetime();
    const child = new EventEmitter();
    const receiver = {};
    const callbackThis = {};
    const args = ['arg'];
    const options = { encoding: 'utf8' };
    let callback: ((...values: unknown[]) => unknown) | undefined;
    let actualReceiver: unknown;
    let actualArgs: unknown[] = [];
    function delegate(file: string, cb: (...values: unknown[]) => unknown): EventEmitter;
    function delegate(file: string, args: string[], options: object, cb: (...values: unknown[]) => unknown): EventEmitter;
    function delegate(this: unknown, ...values: unknown[]): EventEmitter {
      actualReceiver = this;
      actualArgs = values;
      const last = values[values.length - 1];
      if (typeof last === 'function') callback = (...values) => Reflect.apply(last, callbackThis, values);
      return child;
    }
    const property = Symbol('fixture-property');
    Object.defineProperty(delegate, property, { value: options });
    const wrapped = ownCheckpointExecFile(delegate, () => owner);
    const cb = function (this: unknown, ...values: unknown[]): object {
      expect(this).toBe(callbackThis);
      expect(values).toEqual([undefined, 'stdout', 'stderr']);
      return options;
    };
    await preservingFailure(async () => {
      expect(Reflect.get(wrapped, property)).toBe(options);
      expect(wrapped.name).toBe(delegate.name);
      expect(wrapped.length).toBe(delegate.length);
      expect(wrapped.call(receiver, 'git', args, options, cb)).toBe(child);
      expect(actualReceiver).toBe(receiver);
      expect(actualArgs.slice(0, 3)).toEqual(['git', args, options]);
      expect(actualArgs[1]).toBe(args);
      expect(actualArgs[2]).toBe(options);
      expect(callback?.(undefined, 'stdout', 'stderr')).toBe(options);
      expect(owner.evidence().teardown.closePending).toBe(1);
      child.emit('close');
      // Exercise the other declared overload; original thrown undefined survives.
      expect(wrapped('git', () => { throw undefined; })).toBe(child);
      let threw = false;
      let error: unknown = 'unset';
      try { callback?.(); } catch (caught) { threw = true; error = caught; }
      expect(threw).toBe(true);
      expect(error).toBeUndefined();
      expect(owner.evidence().teardown.callbackPending).toBe(0);
      expect(owner.evidence().teardown.closePending).toBe(1);
    }, async () => {
      // Release either callback even on an earlier assertion failure; its original
      // throw remains observable to the caller, not a rejected bookkeeping chain.
      try { callback?.(undefined, 'stdout', 'stderr'); } catch { /* Original callback may throw. */ }
      child.emit('close');
      await observed(owner.close(() => Promise.resolve(), () => {}));
    });
    owner.assertRetired();
  });

  it('reserves before a synchronous fake callback, and keeps exit without close pending', async () => {
    const owner = new CheckpointFixtureLifetime();
    const child = new EventEmitter();
    const wrapped = ownCheckpointExecFile((cb: () => void) => {
      expect(owner.evidence().teardown.callbackPending).toBe(1);
      cb();
      return child;
    }, () => owner);
    const idleEntered = gate();
    let retired = false;
    let closed: Promise<Outcome<void>> | undefined;
    await preservingFailure(async () => {
      expect(wrapped(() => {})).toBe(child);
      child.emit('exit');
      closed = observed(owner.close(() => { idleEntered.release(); return Promise.resolve(); }, () => { retired = true; }));
      await enteredOrSettled(idleEntered.promise, closed);
      expect(owner.evidence().teardown.callbackPending).toBe(0);
      expect(owner.evidence().teardown.closePending).toBe(1);
      expect(retired).toBe(false);
      expect(() => owner.assertRetired()).toThrow();
      child.emit('close');
      await closed;
      owner.assertRetired();
    }, async () => {
      idleEntered.release();
      child.emit('close');
      closed ??= observed(owner.close(() => Promise.resolve(), () => {}));
      await closed;
    });
  });

  it('treats spawn/observer failure as incomplete accounting, preserves throw/return and refuses retirement', async () => {
    const owner = new CheckpointFixtureLifetime();
    const spawn = ownCheckpointExecFile(() => { throw undefined; }, () => owner);
    const badObserver = { once: () => { throw new Error('fake observation failure'); } };
    const spawnWithHandle = ownCheckpointExecFile(() => badObserver, () => owner);
    let threw = false;
    let error: unknown = 'unset';
    try { spawn(); } catch (caught) { threw = true; error = caught; }
    expect(threw).toBe(true);
    expect(error).toBeUndefined();
    expect(spawnWithHandle()).toBe(badObserver);
    const closed = observed(owner.close(() => Promise.resolve(), () => { throw new Error('must not delete'); }));
    expect((await closed).ok).toBe(false);
    expect(() => owner.assertRetired()).toThrow();
    expect(owner.evidence().teardown).toMatchObject({ accountingKnown: false, closePending: 2, retired: false, teardownOutcome: 'failed' });
  });

  it('retains pending child evidence after an injected event-idle rejection (actual event-idle uses allSettled)', async () => {
    const owner = new CheckpointFixtureLifetime();
    const child = owner.child(true);
    let retired = false;
    const closed = observed(owner.close(() => Promise.reject(undefined), () => { retired = true; }));
    await preservingFailure(async () => {
      expect(await closed).toEqual({ ok: false, error: undefined });
      expect(retired).toBe(false);
      expect(() => owner.assertRetired()).toThrow();
      expect(owner.evidence().teardown).toMatchObject({ childPending: 1, callbackPending: 1, closePending: 1, teardownOutcome: 'failed' });
    }, async () => {
      child.callback();
      child.close();
      await closed;
      // Injected failure abandoned that controller before children drained. Explicit
      // fixture cleanup settles their receipts, without reclassifying failed close.
      await owner.settleEpoch(() => Promise.resolve());
    });
    expect(() => owner.assertRetired()).toThrow();
  });

  it('refuses next admission after deletion throws, despite settled roots and children', async () => {
    const owner = new CheckpointFixtureLifetime();
    const child = owner.child(true);
    child.callback();
    child.close();
    const closed = observed(owner.close(() => Promise.resolve(), () => { throw undefined; }));
    expect(await closed).toEqual({ ok: false, error: undefined });
    expect(() => owner.assertRetired()).toThrow();
    expect(owner.evidence().teardown).toMatchObject({ childPending: 0, retired: false, teardownOutcome: 'failed' });
  });

  it('preserves an original raw rejection of undefined over a later deletion failure', async () => {
    const owner = new CheckpointFixtureLifetime();
    const raw = owner.observeRaw(Promise.reject(undefined));
    const rawOutcome = observed(raw);
    const result = observed(preservingFailure(() => raw, () => owner.close(() => Promise.resolve(), () => { throw new Error('fake deletion failure'); })));
    expect(await result).toEqual({ ok: false, error: undefined });
    await rawOutcome;
    expect(() => owner.assertRetired()).toThrow();
    expect(owner.evidence().teardown.teardownOutcome).toBe('failed');
  });

  it('freezes bounded abort phase evidence before late teardown without sensitive payload', async () => {
    const owner = new CheckpointFixtureLifetime();
    const hold = gate();
    const raw = observed(owner.observeRaw(hold.promise));
    owner.phaseStarted('capture');
    const controller = new AbortController();
    const abort = () => { owner.freezeFailure('abort'); };
    controller.signal.addEventListener('abort', abort, { once: true });
    controller.abort();
    const frozen = owner.evidence().failure;
    const closed = observed(owner.close(() => Promise.resolve(), () => {}));
    await preservingFailure(async () => {
      owner.phaseStarted('undo'); // Models a raw continuation after framework timeout.
      owner.freezeFailure('rejection');
      expect(owner.evidence().failure).toBe(frozen);
      expect(frozen).toMatchObject({ reason: 'abort', phase: 'capture', phaseComplete: false, rawPending: 1 });
      expect(Object.isFrozen(frozen)).toBe(true);
      expect(Object.keys(frozen ?? {}).sort()).toEqual(['accountingKnown', 'callbackPending', 'childPending', 'closePending', 'closing', 'directPending', 'elapsedMs', 'phase', 'phaseComplete', 'rawPending', 'reason', 'retired', 'teardownOutcome'].sort());
      hold.release();
      await raw;
      await closed;
      expect(owner.evidence().failure).toBe(frozen);
      expect(owner.evidence().teardown).toMatchObject({ retired: true, rawPending: 0, teardownOutcome: 'retired' });
    }, async () => {
      hold.release();
      await raw;
      await closed;
      controller.signal.removeEventListener('abort', abort);
    });
  });
});
