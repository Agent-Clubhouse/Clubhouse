/**
 * Test-only inventory for checkpoint-tracker's serial, plain-test fixture.
 * This observes explicit producers, not arbitrary asynchronous work or OS quiescence.
 */
export type CheckpointPhase = 'setup' | 'capture' | 'start' | 'end' | 'diff' | 'revert' | 'undo' | 'teardown';
const PHASES: readonly CheckpointPhase[] = ['setup', 'capture', 'start', 'end', 'diff', 'revert', 'undo', 'teardown'];
const GIT_VERBS = ['rev-parse', 'read-tree', 'ls-files', 'add', 'write-tree', 'commit-tree', 'update-ref',
  'show', 'diff', 'ls-tree', 'checkout-index', 'for-each-ref'] as const;
type GitVerb = typeof GIT_VERBS[number] | 'other';
const CHILD_DIAGNOSTIC_LIMIT = 16;
/** Fixed labels and monotonic offsets from fixture creation, never command arguments. */
type ChildTiming = {
  ordinal: number; verb: GitVerb; phase: CheckpointPhase; createdAtMs: number;
  spawnAtMs?: number; exitAtMs?: number; callbackAtMs?: number; closeAtMs?: number;
  timingKnown: boolean;
};
type PhaseTiming = { completedCount: number; completedMs: number; childrenStarted: number; childrenCompleted: number };

function gitVerb(args: unknown[]): GitVerb {
  const verb: unknown = Array.isArray(args[1]) ? args[1][0] : undefined;
  return args[0] === 'git' ? GIT_VERBS.find((allowed) => allowed === verb) ?? 'other' : 'other';
}

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
  private phaseStartedAtMs = 0;
  private phaseFinishedAtMs: number | undefined;
  private phaseTimings = new Map<CheckpointPhase, PhaseTiming>(PHASES.map((phase) =>
    [phase, { completedCount: 0, completedMs: 0, childrenStarted: 0, childrenCompleted: 0 }]));
  private childOrdinal = 0;
  private childTimingOutstanding = 0;
  private childTimings = new Map<number, ChildTiming>();
  private recentChildren: ChildTiming[] = [];
  private failureChildren: ChildTiming[] = [];
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
  child(callbackExpected: boolean, verb: GitVerb = 'other'): {
    callback(): void; close(): void; unknown(): void; spawn(): void; exit(): void; timingUnknown(): void;
  } {
    this.admitted();
    const release = this.children.add();
    const phaseTiming = this.phaseTimings.get(this.phase)!;
    phaseTiming.childrenStarted++;
    this.childTimingOutstanding++;
    const timing: ChildTiming = { ordinal: ++this.childOrdinal, verb, phase: this.phase,
      createdAtMs: this.elapsed(), timingKnown: true };
    if (this.childTimings.size < CHILD_DIAGNOSTIC_LIMIT) this.childTimings.set(timing.ordinal, timing);
    let callbackDone = !callbackExpected;
    let closeDone = false;
    let ended = false;
    if (callbackExpected) this.callbacks++;
    this.closes++;
    const finish = () => {
      if (!ended && callbackDone && closeDone) {
        ended = true;
        this.childTimingOutstanding--;
        phaseTiming.childrenCompleted++;
        this.childTimings.delete(timing.ordinal);
        this.recentChildren.push(timing);
        if (this.recentChildren.length > CHILD_DIAGNOSTIC_LIMIT) this.recentChildren.shift();
        release();
      }
    };
    return {
      spawn: () => { timing.spawnAtMs ??= this.elapsed(); },
      exit: () => { timing.exitAtMs ??= this.elapsed(); },
      timingUnknown: () => { timing.timingKnown = false; },
      callback: () => {
        if (!callbackDone) { callbackDone = true; timing.callbackAtMs = this.elapsed(); this.callbacks--; }
        finish();
      },
      close: () => {
        if (!closeDone) { closeDone = true; timing.closeAtMs = this.elapsed(); this.closes--; }
        finish();
      },
      unknown: () => {
        // Unknown spawn/observation completion is NOT a close receipt. Retain the
        // counts and fail closed, but let the controller report incomplete accounting.
        this.incomplete = true;
        timing.timingKnown = false;
        if (!ended) { ended = true; release(); }
      },
    };
  }

  private elapsed(): number { return Math.max(0, Math.floor(performance.now() - this.origin)); }
  phaseStarted(phase: CheckpointPhase): void {
    this.phase = phase; this.phaseComplete = false; this.phaseStartedAtMs = this.elapsed(); this.phaseFinishedAtMs = undefined;
  }
  phaseFinished(): void {
    if (!this.phaseComplete) {
      const timing = this.phaseTimings.get(this.phase)!;
      this.phaseFinishedAtMs = this.elapsed();
      timing.completedCount++;
      timing.completedMs += this.phaseFinishedAtMs - this.phaseStartedAtMs;
    }
    this.phaseComplete = true;
  }
  private snapshot(reason: 'abort' | 'rejection' | 'failed-case' | 'teardown-error' | 'teardown') {
    const bounded = (count: number) => Math.min(count, 1000);
    const copyChildren = (children: Iterable<ChildTiming>) => Object.freeze(Array.from(children, (child) => Object.freeze({ ...child })));
    return Object.freeze({ reason, phase: this.phase, phaseComplete: this.phaseComplete,
      elapsedMs: this.elapsed(), phaseElapsedMs: (this.phaseFinishedAtMs ?? this.elapsed()) - this.phaseStartedAtMs,
      phases: Object.freeze(Array.from(this.phaseTimings, ([phase, timing]) => Object.freeze({ phase, ...timing }))),
      gitChildren: Object.freeze({ started: this.childOrdinal,
        outstandingDropped: Math.max(0, this.childTimingOutstanding - this.childTimings.size),
        outstanding: copyChildren(this.childTimings.values()), recent: copyChildren(this.recentChildren),
        failureChildren: copyChildren(this.failureChildren) }),
      rawPending: bounded(this.raw.size), directPending: bounded(this.direct.size),
      childPending: bounded(this.children.size), callbackPending: bounded(this.callbacks),
      closePending: bounded(this.closes), accountingKnown: !this.incomplete,
      closing: this.closing, retired: this.retired, teardownOutcome: this.teardownOutcome });
  }
  freezeFailure(reason: 'abort' | 'rejection' | 'failed-case' | 'teardown-error'): void {
    try {
      if (!this.failure) {
        this.failureChildren = [...this.childTimings.values()];
        this.failure = this.snapshot(reason);
      }
    } catch { /* Fixed-metadata observation is best effort. */ }
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
 * Only the supplied callback is proxied; file/args/options/input are unchanged.
 * Callback completion and child close are separate receipts (error may precede close).
 * No error listener, signals, timeout changes, or promisify replacement are added.
 * This fixture's source calls execFile directly, never its custom promisify property.
 */
export function ownCheckpointExecFile<T extends object>(delegate: T, owner: () => CheckpointFixtureLifetime | undefined): T {
  return new Proxy(delegate, {
    apply(target, receiver, args: unknown[]) {
      if (typeof target !== 'function') throw new Error('Checkpoint execFile delegate must be callable');
      const fixture = owner();
      if (!fixture) return Reflect.apply(target, receiver, args);
      const callback = args[args.length - 1];
      const reservation = fixture.child(typeof callback === 'function', gitVerb(args));
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
      try {
        if (!child || typeof child !== 'object' || !('once' in child) || typeof child.once !== 'function') reservation.unknown();
        else {
          Reflect.apply(child.once, child, ['close', () => { reservation.close(); }]);
          try {
            Reflect.apply(child.once, child, ['spawn', () => { reservation.spawn(); }]);
            Reflect.apply(child.once, child, ['exit', () => { reservation.exit(); }]);
          } catch { reservation.timingUnknown(); }
        }
      } catch { reservation.unknown(); } // Observation must not replace the handle/return.
      return child;
    },
  });
}
