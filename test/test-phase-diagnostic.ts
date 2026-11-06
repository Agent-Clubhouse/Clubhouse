import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

interface TestContext {
  signal: AbortSignal;
  onTestFailed(handler: () => void): void;
  onTestFinished(handler: () => void): void;
}

type Counter = 'polls' | 'reports' | 'receipts' | 'outboxItems' | 'outboxBlocked'
  | 'outboxHeld' | 'correlationWaiting' | 'accessConnected' | 'canCapture'
  | 'ordinaryReported' | 'incidentReported' | 'receivedWithShot' | 'receivedTextOnly' | 'pending';
const COUNTERS = new Set<Counter>(['polls', 'reports', 'receipts', 'outboxItems', 'outboxBlocked',
  'outboxHeld', 'correlationWaiting', 'accessConnected', 'canCapture', 'ordinaryReported',
  'incidentReported', 'receivedWithShot', 'receivedTextOnly', 'pending']);
const FS_TYPES = new Set(['FSREQPROMISE', 'FSREQCALLBACK', 'FILEHANDLECLOSEREQ']);
const ERRNOS = new Set(['ENOENT', 'EEXIST', 'EPERM', 'EACCES', 'EBUSY', 'EIO', 'EMFILE', 'ENFILE', 'ENOSPC', 'ETIMEDOUT']);
const LIMITS = { recent: 32, phases: 64, fs: 128, shownFs: 32 } as const;
const scope = new AsyncLocalStorage<{ diagnostic: TestPhaseDiagnostic; phase: string }>();
type Phase = { phase: string; at: number };
type CaseId = 'catalog-builder' | 'sdk-incident' | 'sdk-send' | 'fixture';

export type TestPhaseDiagnostic = ReturnType<typeof startTestPhaseDiagnostic>;

/** Observer only. Labels are fixed test-source strings; no operation arguments/results are retained. */
export function startTestPhaseDiagnostic(
  context: TestContext,
  caseId: CaseId,
  emit: (line: string) => void = (line) => console.error(line),
) {
  const started = performance.now();
  const live = new Map<number, Phase>();
  const fs = new Map<number, Phase & { kind: string }>();
  const recent: Array<Phase & { event: 'begin' | 'done' | 'rejected'; code?: string }> = [];
  const counters: Partial<Record<Counter, number | boolean>> = {};
  let next = 0, droppedPhases = 0, droppedFs = 0, observerErrors = 0;
  let closed = false, emitted = false;
  const elapsed = () => Math.round(performance.now() - started);
  const label = (value: string) => /^[a-z][a-z0-9.-]{0,63}$/.test(value) ? value : 'invalid-phase';
  let frozen: ReturnType<typeof snapshot> | undefined;
  function snapshot() {
    const at = elapsed();
    return Object.freeze({ caseId, atMs: at, droppedPhases, droppedFs, observerErrors,
      live: Object.freeze([...live.values()].map((p) => Object.freeze({ phase: p.phase, ageMs: at - p.at }))),
      // These are observed native request lifetimes, not filenames or exact I/O operation names.
      pendingFs: Object.freeze([...fs.values()].slice(0, LIMITS.shownFs).map((p) => Object.freeze({ phase: p.phase, kind: p.kind, ageMs: at - p.at }))),
      pendingFsCount: fs.size,
      recent: Object.freeze(recent.map((p) => Object.freeze({ ...p }))),
      counters: Object.freeze({ ...counters }),
    });
  }
  // async_hooks callbacks must never throw: even a diagnostic failure cannot fail the worker.
  function observe(fn: () => void) {
    try { fn(); } catch {
      // telemetry-exempt: test-only observer failure, with no raw error or payload logging.
      observerErrors++;
      try { hook.disable(); } catch {
        // telemetry-exempt: a diagnostic callback must not replace the test's error, even during teardown.
        observerErrors++;
      }
    }
  }
  const hook = createHook({
    init(id, kind) {
      observe(() => {
        const current = scope.getStore();
        if (closed || current?.diagnostic !== diagnostic || !FS_TYPES.has(kind)) return;
        if (fs.size >= LIMITS.fs) { droppedFs++; return; }
        fs.set(id, { phase: current.phase, kind, at: elapsed() });
      });
    },
    destroy(id) { observe(() => { fs.delete(id); }); },
  });
  const remember = (entry: typeof recent[number]) => {
    recent.push(entry);
    if (recent.length > LIMITS.recent) recent.shift();
  };
  function stop() {
    if (closed) return;
    frozen = snapshot();
    closed = true;
    hook.disable();
    context.signal.removeEventListener('abort', aborted);
  }
  function report() {
    if (emitted) return;
    emitted = true;
    observe(() => emit(`[test-phase-diagnostic] ${JSON.stringify(frozen ?? snapshot())}`));
  }
  function aborted() { observe(() => { stop(); report(); }); }
  const diagnostic = {
    async step<T>(phase: string, fn: () => T | Promise<T>): Promise<T> {
      if (closed) return fn();
      const id = ++next, name = label(phase);
      observe(() => {
        if (live.size < LIMITS.phases) live.set(id, { phase: name, at: elapsed() });
        else droppedPhases++;
        remember({ phase: name, at: elapsed(), event: 'begin' });
      });
      try {
        const result = await scope.run({ diagnostic, phase: name }, fn);
        if (!closed) observe(() => { remember({ phase: name, at: elapsed(), event: 'done' }); });
        return result;
      } catch (error) {
        if (!closed) observe(() => {
          const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
          remember({ phase: name, at: elapsed(), event: 'rejected', code: typeof code === 'string' && ERRNOS.has(code) ? code : 'other' });
        });
        throw error;
      } finally {
        if (!closed) observe(() => { live.delete(id); });
      }
    },
    note(key: Counter, value: number | boolean) {
      if (!closed) observe(() => {
        if (COUNTERS.has(key) && (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) counters[key] = value;
      });
    },
    increment(key: Counter) {
      if (!closed) observe(() => {
        if (COUNTERS.has(key)) counters[key] = Number(counters[key] ?? 0) + 1;
      });
    },
    snapshot: () => frozen ?? snapshot(),
    dispose: () => observe(stop),
  };
  hook.enable();
  context.signal.addEventListener('abort', aborted, { once: true });
  context.onTestFinished(() => observe(stop));
  // Vitest runs this after afterEach/onTestFinished. Timeout evidence was frozen on abort.
  context.onTestFailed(() => observe(() => { stop(); report(); }));
  if (context.signal.aborted) aborted();
  return diagnostic;
}

/** Uses the current test's observer only; ordinary tests call the original function directly. */
export function traceTestPhase<T>(phase: string, fn: () => T | Promise<T>): T | Promise<T> {
  const current = scope.getStore();
  return current ? current.diagnostic.step(phase, fn) : fn();
}

export function withTestPhaseDiagnostic(caseId: CaseId, test: (diagnostic: TestPhaseDiagnostic) => Promise<void>) {
  return (context: TestContext) => {
    const diagnostic = startTestPhaseDiagnostic(context, caseId);
    return diagnostic.step('case.root', () => test(diagnostic)).finally(diagnostic.dispose);
  };
}
