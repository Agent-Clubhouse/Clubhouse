/** Test-only ownership. Never imported by production; requires an explicit producer inventory. */
export class AcceptedWork {
  private pending = new Map<object, Promise<void>>();
  private ended = false;
  private incomplete = false;
  rejected = 0;

  /** Preserve the original promise. Rejection is settlement, not an accounting failure. */
  observe<T>(promise: Promise<T>): Promise<T> {
    if (this.ended) this.incomplete = true;
    const token = {};
    let release!: () => void;
    const terminal = new Promise<void>((resolve) => { release = resolve; });
    this.pending.set(token, terminal);
    const complete = () => { this.pending.delete(token); release(); };
    try {
      // Both handlers are attached immediately. Their bodies cannot throw:
      // private native Map/number fields and a native void resolver only.
      void promise.then(complete, () => { this.rejected++; complete(); });
    } catch {
      // A broken observer/then property is incomplete accounting, never proof
      // that the underlying operation finished. Admission must remain closed.
      this.incomplete = true;
      complete();
    }
    return promise;
  }

  /**
   * Caller must first stop external producers and own FULL causal roots.
   * Children may register while a parent is pending. This does not discover
   * unobserved callbacks, cancel work, or establish general process quiescence.
   */
  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending.values()]);
    this.ended = true;
    this.assertSettled();
  }

  assertSettled(): void {
    if (!this.ended || this.incomplete || this.pending.size > 0) throw new Error('Accepted work accounting is incomplete');
  }
}

interface Epoch {
  work: AcceptedWork;
  stop(): void;
}

/** Separate case roots from epochs so a body awaiting restart never awaits itself. */
export class FixtureWork {
  readonly roots = new AcceptedWork();
  private epochs: Epoch[] = [];
  private releases: Array<() => void> = [];
  private closing = false;
  private incomplete = false;
  private finished = false;
  private completion: Promise<void> | undefined;

  epoch(stop: () => void): Epoch {
    if (this.closing) throw new Error('Fixture is closing');
    let stopped = false;
    const epoch = {
      work: new AcceptedWork(),
      stop: () => {
        if (stopped) return;
        stopped = true;
        try { stop(); } catch { this.incomplete = true; }
      },
    };
    this.epochs.push(epoch);
    return epoch;
  }

  releaseOnClose(release: () => void): void {
    if (!this.closing) this.releases.push(release);
    else { try { release(); } catch { this.incomplete = true; } }
  }

  /** Lifecycle controller is NOT an epoch root; only its caller belongs to roots. */
  async restart(epoch: Epoch, start: () => undefined): Promise<void> {
    epoch.stop();
    await epoch.work.settle();
    this.start(start);
  }

  /** Synchronous guard before bootstrap/reset/replay mutations, also on the first epoch. */
  start(start: () => undefined): void {
    if (this.closing || this.incomplete) throw new Error('Fixture cannot start another epoch');
    start(); // No await gap between the guard and this fixture mutation.
  }

  close(): Promise<void> {
    if (this.completion) return this.completion;
    this.closing = true; // Synchronous, before any await or late restart continuation.
    for (const epoch of this.epochs) epoch.stop();
    // A stop failure cannot prevent any gate from being released.
    for (const release of this.releases) {
      try { release(); } catch { this.incomplete = true; }
    }
    this.completion = (async () => {
      // Even rejected bodies/setup roots may own unfinished epoch descendants.
      // Collect all settlements before deciding whether admission is safe.
      // Case/setup continuations can still register descendants in an existing
      // epoch. Do not seal an empty epoch before those roots have ended.
      const roots = await Promise.allSettled([this.roots.settle()]);
      const epochs = await Promise.allSettled(this.epochs.map((epoch) => epoch.work.settle()));
      if ([...roots, ...epochs].some((outcome) => outcome.status === 'rejected')) this.incomplete = true;
      this.finished = true;
      this.assertSettled();
    })();
    return this.completion;
  }

  assertSettled(): void {
    if (!this.finished || this.incomplete) throw new Error('Fixture work is incomplete');
    this.roots.assertSettled();
    for (const epoch of this.epochs) epoch.work.assertSettled();
  }

  /** This guard must precede mkdtemp/base assignment/reset/delete in a future harness. */
  admitNext(mutate: () => undefined): void { this.assertSettled(); mutate(); }
}

/** Original failure (including thrown undefined) takes precedence; no throw in finally. */
export async function preservingFailure(body: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
  let failed = false;
  let error: unknown;
  let cleanupFailed = false;
  let cleanupError: unknown;
  try { await body(); } catch (caught) { failed = true; error = caught; }
  finally { try { await cleanup(); } catch (caught) { cleanupFailed = true; cleanupError = caught; } }
  if (failed) throw error;
  if (cleanupFailed) throw cleanupError;
}

export function withFixtureWork(body: (fixture: FixtureWork) => Promise<void>): Promise<void> {
  const fixture = new FixtureWork();
  return preservingFailure(() => fixture.roots.observe(body(fixture)), () => fixture.close());
}

/**
 * This fixture uses only plain tests, .each and argument-free setup hooks, with
 * no custom Vitest fixtures/concurrent chains. Capture the RAW callback result,
 * before Vitest's outer timeout/cancellation wrapper can abandon it. Proxies
 * retain callback name/arity/this/args and the exact return value; they do not
 * synthesize an async callback or change registration options/deadlines.
 */
export function ownedRegistration<T extends object>(registration: T, callbackIndex: number, observe: (promise: Promise<unknown>) => void): T {
  if (typeof registration !== 'function') throw new Error('Owned registration must be callable');
  const accept = (result: unknown) => {
    if (result && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') observe(result as Promise<unknown>);
    return result;
  };
  return new Proxy(registration, {
    apply(target, receiver, args: unknown[]) {
      const callback = args[callbackIndex];
      if (typeof callback === 'function') {
        args = [...args];
        args[callbackIndex] = new Proxy(callback, {
          apply(body, bodyThis, values: unknown[]) { return accept(Reflect.apply(body, bodyThis, values)); },
        });
      }
      if (typeof target !== 'function') throw new Error('Owned registration must be callable');
      return accept(Reflect.apply(target, receiver, args));
    },
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (key === 'each' && typeof value === 'function') {
        return (...cases: unknown[]) => ownedRegistration(Reflect.apply(value, target, cases), callbackIndex, observe);
      }
      if (typeof value === 'function' && key !== 'toString') throw new Error('Unsupported owned registration chain');
      return value;
    },
  });
}
