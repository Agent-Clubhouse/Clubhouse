/** Test-only, best-effort observations. These records never own/cancel native work. */
export type FixtureTag = 'auto-seed' | 'pages-large';
export type ObservationSlot = 'entry' | 'pre-deadline' | 'body-settlement' | 'cleanup-boundary' | 'cleanup-entry' | 'cleanup-settlement';
export type ObservationFacet = 'body' | 'ensure' | 'install' | 'catalog' | 'revision' | 'cleanup' | 'aggregate';
type State = 'none' | 'entered' | 'pending' | 'fulfilled' | 'rejected' | 'thrown' | 'unavailable';
type Kind = 'block' | 'skill' | 'mcp' | 'subagent' | 'template' | 'unknown';
type Category = 'none' | 'catalog-error' | 'native-denied' | 'native-busy' | 'native-space' | 'native-missing' | 'native-other' | 'unknown';
type Primitive = string | number | boolean;
export type ObservationRow = Readonly<Record<string, Primitive>>;
export interface ObservationDependencies {
  clock(): number;
  sink(line: string): void;
  serialize(row: ObservationRow): string;
  classify(error: unknown): unknown;
  beforeBuild(): void;
  setTimer(callback: () => void, ms: number): unknown;
  unrefTimer(handle: unknown): void;
  clearTimer(handle: unknown): void;
}
const slots: ObservationSlot[] = ['entry', 'pre-deadline', 'body-settlement', 'cleanup-boundary', 'cleanup-entry', 'cleanup-settlement'];
const facets: ObservationFacet[] = ['body', 'ensure', 'install', 'catalog', 'revision', 'cleanup', 'aggregate'];
const kinds: Kind[] = ['block', 'skill', 'mcp', 'subagent', 'template', 'unknown'];
const categories: Category[] = ['none', 'catalog-error', 'native-denied', 'native-busy', 'native-space', 'native-missing', 'native-other', 'unknown'];
const phases = ['unknown', 'setup', 'ensure', 'home', 'open', 'updates', 'pre-flush-check', 'flush', 'post-flush-checks', 'manifest-check', 'reopen', 'cold-cache-check', 'cold-get', 'cold-get-budget', 'cold-list', 'cold-list-checks', 'cold-miss', 'size-checks', 'body-complete'] as const;
export type ObservationPhase = typeof phases[number];
const PREFIX = 'CLUBHOUSE_FIXTURE_OBS_V1 ';
const MAX_BYTES = 1536;
const MAX_COUNT = 65535;
const stringify = JSON.stringify;

function classify(error: unknown): Category {
  if (!error || typeof error !== 'object') return 'unknown';
  // No getters, arbitrary messages, details, stacks or stringification.
  const code = Object.getOwnPropertyDescriptor(error, 'code');
  if (!code || !('value' in code) || typeof code.value !== 'string') return 'unknown';
  switch (code.value) {
    case 'EACCES': case 'EPERM': case 'EROFS': return 'native-denied';
    case 'EBUSY': return 'native-busy';
    case 'ENOSPC': return 'native-space';
    case 'ENOENT': return 'native-missing';
    case 'EIO': case 'EMFILE': case 'ENFILE': case 'EEXIST': return 'native-other';
    // Closed catalog codes; no automatic serialization of unknown code strings.
    case 'invalid_payload': case 'invalid_reference': case 'stale_revision':
    case 'catalog_corrupt': case 'catalog_version_unsupported': case 'payload_corrupt': return 'catalog-error';
    default: return 'unknown';
  }
}
const defaults: ObservationDependencies = {
  clock: () => performance.now(),
  sink: (line) => { console.info(line.slice(0, -1)); },
  serialize: (row) => stringify(row),
  classify,
  beforeBuild: () => {},
  setTimer: (callback, ms) => setTimeout(callback, ms),
  unrefTimer: (handle) => { (handle as ReturnType<typeof setTimeout>).unref(); },
  clearTimer: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

/** Claim before any optional clock/formatter/sink can reenter. Never replaces its first scope. */
export class FixtureObservationSelection {
  private first: FixtureObservation | undefined;
  constructor(private readonly tag: FixtureTag, private readonly dependencies: Partial<ObservationDependencies> = {}) {}
  claim(): FixtureObservation | undefined {
    if (this.first) { this.first.noteExtraInvocation(); return undefined; }
    const scope = new FixtureObservation(this.tag, this.dependencies);
    this.first = scope;
    return scope;
  }
  get selected(): FixtureObservation | undefined { return this.first; }
}

export class FixtureObservation {
  private readonly states = Object.fromEntries(facets.map((key) => [key, { state: 'none' as State, owner: undefined as symbol | undefined }])) as Record<ObservationFacet, { state: State; owner?: symbol }>;
  private readonly used = new Set<ObservationSlot>();
  private readonly singleCalls = new Set<ObservationFacet>();
  private sequence = 0;
  private publishing = false;
  private fault = false;
  private overlap = false;
  private extraInvocation = false;
  private overflow = false;
  private baseline: number | undefined;
  private timerClaimed = false;
  private timerClearClaimed = false;
  private timerHandle: unknown;
  private phase: ObservationPhase = 'unknown';
  private lastPhase: ObservationPhase = 'unknown';
  private enteredInstalls = 0;
  private fulfilledInstalls = 0;
  private rejectedInstalls = 0;
  private installKind: Kind = 'unknown';
  private completedUpdates = 0;
  private startedUpdate = 0;
  private checkedFiles = 0;
  private lastError: Category = 'none';
  private task: object | undefined;
  private store: object | undefined;
  private directory: string | undefined;
  private cleanupMatch: 'unknown' | 'matched' | 'not-known' | 'not-in-batch' | 'mismatch' = 'unknown';
  private signal: (() => unknown) | undefined;

  private readonly tag: FixtureTag | 'unknown';
  private mutation = Symbol();
  constructor(tag: FixtureTag, private readonly dependencies: Partial<ObservationDependencies>) {
    this.tag = tag === 'auto-seed' || tag === 'pages-large' ? tag : 'unknown';
    if (this.tag === 'unknown') this.noteFault();
  }
  noteExtraInvocation(): void { this.extraInvocation = true; this.overlap = true; }
  noteFault(): void { this.fault = true; }
  bindStore(store: object): void {
    if (!store || typeof store !== 'object') { this.noteFault(); return; }
    if (this.store && this.store !== store) { this.noteExtraInvocation(); return; }
    this.store = store;
  }
  ownsStore(store: object): boolean { return this.store !== undefined && this.store === store; }
  bindTask(task: object | undefined, signal?: () => unknown): void {
    if (!task) { this.noteFault(); return; }
    if (this.task && this.task !== task) { this.noteExtraInvocation(); return; }
    this.task = task; this.signal = signal;
  }
  ownsTask(task: object | undefined): boolean { return task !== undefined && task === this.task; }
  bindDirectory(directory: string): void {
    if (this.directory !== undefined && this.directory !== directory) { this.noteExtraInvocation(); return; }
    this.directory = directory;
  }
  ownsDirectory(directory: unknown): boolean { return this.directory !== undefined && this.directory === directory; }
  cleanupBoundary(batch: readonly unknown[]): boolean {
    if (this.used.has('cleanup-boundary')) return false;
    this.cleanupMatch = this.directory === undefined ? 'not-known' : batch.includes(this.directory) ? 'matched' : 'not-in-batch';
    this.publish('cleanup-boundary');
    return true;
  }
  cleanupMismatch(): void { this.cleanupMatch = 'mismatch'; this.noteFault(); this.publish('cleanup-boundary'); }
  setPhase(phase: ObservationPhase): void {
    if (!phases.includes(phase)) { this.noteFault(); this.phase = 'unknown'; return; }
    this.phase = phase;
  }
  completePhase(): void { this.lastPhase = this.phase; }
  updateStarted(ordinal: number): void {
    if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 1024) { this.noteFault(); return; }
    this.startedUpdate = ordinal;
  }
  updateCompleted(ordinal: number): void {
    if (ordinal !== this.completedUpdates + 1 || ordinal !== this.startedUpdate) { this.noteFault(); return; }
    this.completedUpdates = ordinal;
  }
  fileChecked(): void { this.checkedFiles = this.increment(this.checkedFiles); }
  private increment(value: number): number {
    if (value === MAX_COUNT) { this.overflow = true; return value; }
    return value + 1;
  }
  private error(error: unknown): void {
    try {
      const version = this.mutation;
      const category = (this.dependencies.classify ?? defaults.classify)(error);
      if (version !== this.mutation) { this.noteFault(); return; }
      if (!categories.includes(category as Category)) { this.noteFault(); this.lastError = 'unknown'; }
      else this.lastError = category as Category;
    } catch { this.noteFault(); this.lastError = 'unknown'; }
  }

  /** Original return (including its exact Promise) and errors are never replaced. */
  call<T>(facet: ObservationFacet, invoke: () => T, kind: unknown = 'unknown'): T {
    this.mutation = Symbol();
    const state = this.states[facet];
    const owner = Symbol();
    const single = ['body', 'ensure', 'cleanup', 'aggregate'].includes(facet);
    const tracked = state.owner === undefined && (!single || !this.singleCalls.has(facet));
    if (single) this.singleCalls.add(facet);
    if (tracked) { state.owner = owner; state.state = 'entered'; }
    else this.overlap = true;
    if (facet === 'install') {
      this.enteredInstalls = this.increment(this.enteredInstalls);
      if (tracked) this.installKind = kinds.includes(kind as Kind) ? kind as Kind : 'unknown';
    }
    if (facet === 'body' && tracked) { this.publish('entry'); this.armTimer(); }
    if (facet === 'cleanup' && tracked) { this.cleanupMatch = 'matched'; this.publish('cleanup-entry'); }
    let result: T;
    try { result = invoke(); }
    catch (error) { this.finish(facet, owner, 'thrown', error); throw error; }
    try {
      if (result instanceof Promise) {
        if (tracked && state.owner === owner) state.state = 'pending';
        // Both observer handlers fulfill. The actual original promise is returned below.
        void Promise.prototype.then.call(result,
          () => { this.finish(facet, owner, 'fulfilled'); },
          (error: unknown) => { this.finish(facet, owner, 'rejected', error); });
      } else this.finish(facet, owner, 'fulfilled');
    } catch { this.noteFault(); if (state.owner === owner) state.state = 'unavailable'; }
    return result;
  }
  private finish(facet: ObservationFacet, owner: symbol, outcome: 'fulfilled' | 'rejected' | 'thrown', error?: unknown): void {
    // Commit independent own state/counts before optional classification/publication reentry.
    this.mutation = Symbol();
    const state = this.states[facet];
    const owned = state.owner === owner;
    if (owned) { state.owner = undefined; state.state = outcome; }
    if (facet === 'install') {
      if (outcome === 'fulfilled') this.fulfilledInstalls = this.increment(this.fulfilledInstalls);
      else this.rejectedInstalls = this.increment(this.rejectedInstalls);
    }
    if (outcome !== 'fulfilled') this.error(error);
    if (facet === 'body' && owned) { this.clearTimer(); this.publish('body-settlement'); }
    if (facet === 'cleanup' && owned) this.publish('cleanup-settlement');
  }
  private armTimer(): void {
    if (this.timerClaimed) return;
    this.timerClaimed = true;
    try {
      const handle = (this.dependencies.setTimer ?? defaults.setTimer)(() => {
        if (['entered', 'pending'].includes(this.states.body.state)) this.publish('pre-deadline');
      }, this.tag === 'auto-seed' ? 9000 : 29000);
      this.timerHandle = handle;
      try { (this.dependencies.unrefTimer ?? defaults.unrefTimer)(handle); }
      catch { this.noteFault(); this.clearTimer(); }
    } catch { this.noteFault(); }
  }
  private clearTimer(): void {
    if (this.timerClearClaimed || this.timerHandle === undefined) return;
    this.timerClearClaimed = true;
    const handle = this.timerHandle;
    this.timerHandle = undefined;
    try { (this.dependencies.clearTimer ?? defaults.clearTimer)(handle); } catch { this.noteFault(); }
  }
  private elapsed(slot: ObservationSlot): number | 'unavailable' {
    try {
      const now = (this.dependencies.clock ?? defaults.clock)();
      if (!Number.isFinite(now) || now < 0) throw new Error('invalid observation clock');
      if (slot === 'entry' && this.baseline === undefined) this.baseline = now;
      if (this.baseline === undefined || now < this.baseline) throw new Error('unavailable observation clock');
      return Math.min(600000, Math.floor(now - this.baseline));
    } catch { this.noteFault(); return 'unavailable'; }
  }
  private snapshot(slot: ObservationSlot, sequence: number): Record<string, Primitive> {
    // Null prototype prevents an inherited toJSON/getter from seeing native values.
    return Object.assign(Object.create(null), {
      schema: 1, fixture: this.tag, invocation: 1, sequence, event: slot,
      observerFault: this.fault, overlap: this.overlap, extraInvocation: this.extraInvocation, overflow: this.overflow,
      phase: this.phase, lastCompletedPhase: this.lastPhase, cleanupMatch: this.cleanupMatch,
      body: this.states.body.state, ensure: this.states.ensure.state, install: this.states.install.state,
      catalog: this.states.catalog.state, revision: this.states.revision.state,
      cleanup: this.states.cleanup.state, aggregate: this.states.aggregate.state,
      installKind: this.installKind, enteredInstalls: this.enteredInstalls,
      fulfilledInstalls: this.fulfilledInstalls, rejectedInstalls: this.rejectedInstalls,
      startedUpdate: this.startedUpdate, completedUpdates: this.completedUpdates, checkedFiles: this.checkedFiles,
      errorCategory: this.lastError,
    });
  }
  publish(slot: ObservationSlot): void {
    if (!slots.includes(slot)) { this.noteFault(); return; }
    if (this.used.has(slot)) return;
    this.used.add(slot);
    const sequence = ++this.sequence; // claim BEFORE every optional callback
    if (this.publishing) { this.noteFault(); this.overlap = true; return; }
    this.publishing = true;
    try {
      const fields = this.snapshot(slot, sequence);
      const elapsed = this.elapsed(slot);
      let signal = 'unavailable';
      if (this.signal) {
        try { const sampled = this.signal(); signal = sampled === true ? 'aborted' : sampled === false ? 'not-aborted' : 'unavailable'; }
        catch { this.noteFault(); }
      }
      const row: ObservationRow = Object.freeze(Object.assign(Object.create(null), fields, {
        elapsedMs: elapsed, sampleLate: typeof elapsed === 'number' && elapsed >= (this.tag === 'auto-seed' ? 10000 : 30000),
        runnerSignal: signal, observerFault: this.fault,
      }));
      (this.dependencies.beforeBuild ?? defaults.beforeBuild)();
      const canonical = stringify(row);
      const serialized = (this.dependencies.serialize ?? defaults.serialize)(row);
      if (this.sequence !== sequence) { this.noteFault(); return; }
      if (serialized !== canonical) { this.noteFault(); return; }
      const line = PREFIX + serialized + '\n';
      if (Buffer.byteLength(line, 'utf8') > MAX_BYTES) { this.noteFault(); return; }
      (this.dependencies.sink ?? defaults.sink)(line);
    } catch { this.noteFault(); }
    finally { this.publishing = false; }
  }
  /** Fixed primitive readback for tests; never contains captured task/store/path/arguments. */
  read(): ObservationRow { return Object.freeze(this.snapshot('entry', this.sequence)); }
}

/** Caller captures seed/native receiver/options in invoke BEFORE this optional publication. */
export function observeSeedCleanup<T>(selection: FixtureObservationSelection, capturedSeed: unknown, invoke: () => T): T {
  const scope = selection.selected;
  if (!scope) return invoke();
  if (!scope.ownsDirectory(capturedSeed)) { scope.cleanupMismatch(); return invoke(); }
  scope.cleanupBoundary([capturedSeed]);
  return scope.call('cleanup', invoke);
}

/** The caller already performed its ONE original splice and captured the native rm binding. */
export function observeCleanupBatch<T>(selection: FixtureObservationSelection, task: object | undefined, batch: readonly T[], capture: (directory: T) => () => Promise<void>): Promise<void[]> {
  const scope = selection.selected;
  const linked = scope?.ownsTask(task) && scope.cleanupBoundary(batch);
  const operations = batch.map((directory) => {
    const invoke = capture(directory); // functional receiver/args/options precede selected-entry output
    return scope?.ownsDirectory(directory) ? scope.call('cleanup', invoke) : invoke();
  });
  const aggregate = Promise.all(operations);
  return linked ? scope!.call('aggregate', () => aggregate) : aggregate;
}

/** A validator for captured own rows only; absence is unavailable, never functional success. */
export function readObservationLines(text: string, tag: FixtureTag, required: readonly ObservationSlot[] = ['entry', 'body-settlement', 'cleanup-boundary', 'cleanup-entry', 'cleanup-settlement']): { rows: ObservationRow[]; available: boolean } {
  const rows: ObservationRow[] = [];
  let invalid = false;
  for (const line of text.split('\n')) {
    const start = line.indexOf(PREFIX);
    if (start < 0) continue;
    const raw = line.slice(start + PREFIX.length);
    try {
      const row = JSON.parse(raw);
      if (!row || typeof row !== 'object') { invalid = true; continue; }
      if (row.fixture !== tag) continue;
      if (Buffer.byteLength(PREFIX + raw + '\n') > MAX_BYTES || row.schema !== 1 || row.invocation !== 1
        || !slots.includes(row.event) || !Number.isInteger(row.sequence) || row.sequence < 1 || row.sequence > 6
        || Object.values(row).some((value) => !['string', 'number', 'boolean'].includes(typeof value))
        || facets.some((facet) => !['none', 'entered', 'pending', 'fulfilled', 'rejected', 'thrown', 'unavailable'].includes(row[facet]))
        || !phases.includes(row.phase) || !phases.includes(row.lastCompletedPhase) || !kinds.includes(row.installKind)
        || !categories.includes(row.errorCategory) || !['unknown', 'matched', 'not-known', 'not-in-batch', 'mismatch'].includes(row.cleanupMatch)
        || !['aborted', 'not-aborted', 'unavailable'].includes(row.runnerSignal)
        || ['observerFault', 'overlap', 'extraInvocation', 'overflow', 'sampleLate'].some((key) => typeof row[key] !== 'boolean')
        || ['enteredInstalls', 'fulfilledInstalls', 'rejectedInstalls', 'startedUpdate', 'completedUpdates', 'checkedFiles'].some((key) => !Number.isInteger(row[key]) || row[key] < 0 || row[key] > MAX_COUNT)
        || !(row.elapsedMs === 'unavailable' || (Number.isInteger(row.elapsedMs) && row.elapsedMs >= 0 && row.elapsedMs <= 600000))
        || Object.keys(row).length !== 30) { invalid = true; continue; }
      rows.push(row);
    } catch { invalid = true; }
  }
  const events = new Set(rows.map((row) => row.event));
  const sequences = new Set(rows.map((row) => row.sequence));
  const contiguous = [...sequences].sort((a, b) => Number(a) - Number(b)).every((value, index) => value === index + 1);
  return { rows, available: !invalid && rows.length > 0 && rows.length <= 6 && events.size === rows.length
    && sequences.size === rows.length && contiguous && required.every((slot) => events.has(slot)) && rows.every((row) => !row.observerFault && !row.overlap && !row.overflow && !row.extraInvocation) };
}
