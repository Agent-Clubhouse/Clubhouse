import { promisify } from 'node:util';

/**
 * Test-only inventory for checkpoint-tracker's serial, plain-test fixture.
 * This observes explicit producers, not arbitrary asynchronous work or OS quiescence.
 */
export type CheckpointPhase = 'setup' | 'capture' | 'start' | 'end' | 'diff' | 'revert' | 'undo' | 'teardown';

class Receipts {
  private pending = new Set<Promise<void>>();
  add(): () => void {
    let release!: () => void;
    const receipt = new Promise<void>((resolve) => { release = resolve; });
    this.pending.add(receipt);
    return () => { this.pending.delete(receipt); release(); };
  }
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
  get size(): number { return this.pending.size; }
}

export class CheckpointFixtureLifetime {
  private raw = new Receipts();
  private direct = new Receipts();
  private children = new Receipts();
  private callbacks = 0;
  private closes = 0;
  private version = 0;
  private settledVersion = -1;
  private incomplete = false;
  private closing = false;
  private retired = false;
  private phase: CheckpointPhase = 'setup';
  private phaseComplete = false;
  private readonly origin = performance.now();
  private failure: ReturnType<CheckpointFixtureLifetime['snapshot']> | undefined;
  private closeWork: Promise<void> | undefined;
  private teardownOutcome: 'not-started' | 'pending' | 'retired' | 'failed' = 'not-started';

  private observe<T>(promise: Promise<T>, receipts: Receipts, raw = false): Promise<T> {
    this.admitted();
    const release = receipts.add();
    try {
      // Settlement (including expected rejection) is not lost accounting.
      // Native receipt bookkeeping cannot throw; the returned promise is unchanged.
      void promise.then(release, () => { if (raw) this.freezeFailure('rejection'); release(); });
    } catch { this.incomplete = true; release(); }
    return promise;
  }
  observeRaw<T>(promise: Promise<T>): Promise<T> { return this.observe(promise, this.raw, true); }
  observeDirect<T>(promise: Promise<T>): Promise<T> { return this.observe(promise, this.direct); }
  event(): void { this.admitted(); }
  private admitted(): void { this.version++; if (this.retired) this.incomplete = true; }

  /** Reserve before execFile can invoke a callback, including a synchronous fake. */
  child(callbackExpected: boolean): { callback(): void; close(): void; unknown(): void } {
    this.admitted();
    const release = this.children.add();
    let callbackDone = !callbackExpected;
    let closeDone = false;
    let ended = false;
    if (callbackExpected) this.callbacks++;
    this.closes++;
    const finish = () => {
      if (!ended && callbackDone && closeDone) { ended = true; release(); }
    };
    return {
      callback: () => {
        if (!callbackDone) { callbackDone = true; this.callbacks--; }
        finish();
      },
      close: () => {
        if (!closeDone) { closeDone = true; this.closes--; }
        finish();
      },
      unknown: () => {
        // Unknown spawn/observation completion is NOT a close receipt. Retain the
        // counts and fail closed, but let the controller report incomplete accounting.
        this.incomplete = true;
        if (!ended) { ended = true; release(); }
      },
    };
  }

  phaseStarted(phase: CheckpointPhase): void { this.phase = phase; this.phaseComplete = false; }
  phaseFinished(): void { this.phaseComplete = true; }
  private snapshot(reason: 'abort' | 'rejection' | 'failed-case' | 'teardown-error' | 'teardown') {
    const bounded = (count: number) => Math.min(count, 1000);
    return Object.freeze({ reason, phase: this.phase, phaseComplete: this.phaseComplete,
      elapsedMs: Math.max(0, Math.floor(performance.now() - this.origin)),
      rawPending: bounded(this.raw.size), directPending: bounded(this.direct.size),
      childPending: bounded(this.children.size), callbackPending: bounded(this.callbacks),
      closePending: bounded(this.closes), accountingKnown: !this.incomplete,
      closing: this.closing, retired: this.retired, teardownOutcome: this.teardownOutcome });
  }
  freezeFailure(reason: 'abort' | 'rejection' | 'failed-case' | 'teardown-error'): void {
    try { this.failure ??= this.snapshot(reason); } catch { /* Fixed-metadata observation is best effort. */ }
  }
  evidence() { return Object.freeze({ failure: this.failure, teardown: this.snapshot('teardown') }); }

  private assertIdle(): void {
    if (this.incomplete || this.direct.size || this.children.size) throw new Error('Checkpoint fixture accounting is incomplete');
  }
  /**
   * Explicit mid-body cwd/cache boundary: EXCLUDES the raw body awaiting this
   * controller. Only this fixture's inventoried direct/event/child work is covered.
   * If eventIdle rejects, children remain owned and the failed close cannot retire;
   * it is not evidence that their receipts drained. The real tracker idle uses allSettled.
   */
  async settleEpoch(eventIdle: () => Promise<void>): Promise<void> {
    let version: number;
    do {
      version = this.version;
      await this.direct.settle();
      await eventIdle();
      await this.children.settle();
    } while (version !== this.version);
    this.assertIdle();
    this.settledVersion = this.version;
  }
  mutateEpoch(mutate: () => void): void {
    if (this.closing || this.retired) throw new Error('Checkpoint fixture is closing');
    this.assertIdle();
    if (this.version !== this.settledVersion) throw new Error('Checkpoint fixture admitted late work');
    mutate(); // No await gap between admission and fixture mutation.
  }
  /** Kept separate from the raw roots it awaits, so teardown never awaits itself. */
  close(eventIdle: () => Promise<void>, retire: () => void): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.closing = true;
    this.teardownOutcome = 'pending';
    this.closeWork = (async () => {
      try {
        await this.raw.settle();
        this.phaseStarted('teardown');
        // Collection remains open through late admissions from raw/direct/event work.
        await this.settleEpoch(eventIdle);
        this.assertIdle();
        if (this.version !== this.settledVersion) throw new Error('Checkpoint fixture admitted late work');
        retire();
        this.retired = true; // A failed deletion never authorizes the next setup.
        this.phaseFinished();
        this.teardownOutcome = 'retired';
      } catch (error) {
        this.teardownOutcome = 'failed';
        throw error; // Includes thrown undefined; neither failure nor close is synthesized.
      }
    })();
    return this.closeWork;
  }
  assertRetired(): void {
    if (!this.retired || this.incomplete || this.raw.size) throw new Error('Previous checkpoint fixture is not retired');
    this.assertIdle();
  }
}

/**
 * Preserve execFile's overload/property surface and the actual returned handle.
 * Direct calls proxy only the supplied callback; file/args/options/input are unchanged.
 * Callback completion and child close are separate receipts (error may precede close).
 * Native custom promisify calls bypass execFile's apply trap. Observe their
 * unchanged promise and its actual .child until BOTH settlement and close.
 * No error listener, signals, timeout changes, or promisify replacement are added.
 */
export function ownCheckpointExecFile<T extends object>(delegate: T, owner: () => CheckpointFixtureLifetime | undefined): T {
  const observeChild = (child: unknown, reservation: ReturnType<CheckpointFixtureLifetime['child']>) => {
    try {
      if (!child || typeof child !== 'object' || !('once' in child) || typeof child.once !== 'function') reservation.unknown();
      else Reflect.apply(child.once, child, ['close', () => { reservation.close(); }]);
    } catch { reservation.unknown(); } // Observation must not replace the handle/return.
  };
  // The native custom property is non-configurable/read-only. A callable
  // surface retains its descriptors without violating Proxy get invariants.
  const surface = Object.assign(() => undefined, delegate);
  const descriptors = Object.getOwnPropertyDescriptors(delegate);
  const custom: unknown = Reflect.get(delegate, promisify.custom);
  const customDescriptor = Object.getOwnPropertyDescriptor(delegate, promisify.custom);
  if (typeof custom === 'function' && customDescriptor) {
    Reflect.deleteProperty(descriptors, promisify.custom);
    Object.defineProperty(surface, promisify.custom, {
      ...customDescriptor,
      value: new Proxy(custom, {
        apply(body, bodyThis, args: unknown[]) {
          const fixture = owner();
          if (!fixture) return Reflect.apply(body, bodyThis, args);
          const reservation = fixture.child(true);
          let result: unknown;
          try { result = Reflect.apply(body, bodyThis, args); }
          catch (error) { reservation.unknown(); throw error; }
          try {
            if (!result || typeof result !== 'object' || !('then' in result) || typeof result.then !== 'function') reservation.unknown();
            else {
              void result.then(() => { reservation.callback(); }, () => { reservation.callback(); });
              observeChild('child' in result ? result.child : undefined, reservation);
            }
          } catch { reservation.unknown(); }
          return result;
        },
      }),
    });
  }
  Object.defineProperties(surface, descriptors);
  return new Proxy(surface, {
    apply(_target, receiver, args: unknown[]) {
      const target = delegate;
      if (typeof target !== 'function') throw new Error('Checkpoint execFile delegate must be callable');
      const fixture = owner();
      if (!fixture) return Reflect.apply(target, receiver, args);
      const callback = args[args.length - 1];
      const reservation = fixture.child(typeof callback === 'function');
      if (typeof callback === 'function') {
        args = [...args];
        args[args.length - 1] = new Proxy(callback, {
          apply(body, bodyThis, values: unknown[]) {
            try { return Reflect.apply(body, bodyThis, values); }
            finally { reservation.callback(); }
          },
        });
      }
      let child: unknown;
      try { child = Reflect.apply(target, receiver, args); }
      catch (error) { reservation.unknown(); throw error; }
      observeChild(child, reservation);
      return child;
    },
  });
}
