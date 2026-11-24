import { execFile } from 'child_process';
import { AsyncLocalStorage } from 'async_hooks';
import { generateKeyPairSync } from 'crypto';
import * as nativeFs from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from 'vitest';
import type { GrantChangeMode } from '../../src/shared/agent-grant-changes';
import { parseHandoffManifest, summarizeHandoffManifest } from '../../src/shared/handoff-manifest';
import { parseHandoff, type Handoff, type HandoffManifestSummary } from '../../src/shared/handoffs';
import type { McpToolResult } from '../../src/main/services/clubhouse-mcp/types';
import type { DurableAgentConfig } from '../../src/shared/types';

const exec = promisify(execFile);
const caller = 'producer-sender';
const receiver = 'producer-receiver';
const contents = 'frozen producer bytes\n';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function resultValue(result: McpToolResult): unknown {
  const content = result.content[0];
  if (!content || content.type !== 'text' || typeof content.text !== 'string') throw new Error('Expected a text tool result.');
  return JSON.parse(content.text);
}

async function initializeRepository(repository: string): Promise<void> {
  await exec('git', ['init', '--quiet', '--initial-branch=fixture'], { cwd: repository });
  await fs.writeFile(path.join(repository, 'fixture.txt'), 'original\n');
  await exec('git', ['add', 'fixture.txt'], { cwd: repository });
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture'], { cwd: repository });
  await fs.writeFile(path.join(repository, 'fixture.txt'), contents);
}

async function setup(dir: string, owner: FixtureOwner) {
  const userData = path.join(dir, 'user-data');
  const repository = path.join(dir, 'repository');
  await fs.mkdir(userData);
  await fs.mkdir(repository);
  await initializeRepository(repository);
  const { desktop } = await import('./reverse-desktop-fixture');
  const machine = await desktop(userData);
  const projects = await import('../../src/main/services/project-store');
  const project = await projects.add(repository);
  const registry = await import('../../src/main/services/agent-registry');
  const gate = await import('../../src/main/services/clubhouse-mcp/mcp-call-gate');
  const binding = await import('../../src/main/services/clubhouse-mcp/binding-manager');
  const grants = await import('../../src/main/services/agent-grants-store');
  const tools = await import('../../src/main/services/clubhouse-mcp/tool-registry');
  const registration = { projectPath: repository, cwd: repository, orchestrator: 'claude-code' as const, runtime: 'headless' as const };
  for (const agent of [caller, receiver]) {
    registry.agentRegistry.register(agent, { ...registration });
    gate.setMcpCallerQuick(agent, repository);
  }
  binding.bindingManager.bind(caller, { targetKind: 'agent', targetId: receiver, label: 'Receiver' });
  const setGrant = (mode: GrantChangeMode) => grants.updateAgentGrantChanges(caller, () => ({
    changes: [
      { action: 'handoff.offer', target: { kind: 'connected' }, mode },
      { action: 'handoff.accept', target: { kind: 'connected' }, mode: 'allow' },
    ],
  }));
  await setGrant('allow');
  (await import('../../src/main/services/clubhouse-mcp/tools/handoff-tools')).registerHandoffTools();
  const hostApi = await import('../../src/main/services/handoff-host');
  owner.stop = () => hostApi.stopHandoffs();
  const requests = await import('../../src/main/services/grant-requests');
  owner.reset = () => requests._resetGrantRequestsForTesting();
  const host = hostApi.handoffHost();
  await host.ready;
  const preparation = await import('../../src/main/services/handoff-preparations');
  const source = await import('../../src/main/services/handoff-preflight-host');
  return { userData, repository, project, registry, gate, grants, tools, hostApi, host, preparation, source, requests,
    setGrant: (mode: GrantChangeMode) => ownGrantIO(owner, () => setGrant(mode)), machine, binding };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
type FailureStage = 'setup' | 'work' | 'release' | 'teardown' | 'body';
type Failure = Readonly<{ stage: FailureStage; error: unknown }>;
type Completion = Readonly<{ failures: readonly Failure[] }>;
type CoreCompletion = Completion & Readonly<{ teardown: readonly Completion[]; error?: unknown }>;
type RetirementOrigin = 'manual' | 'hook' | 'other';
type ReleaseOrigin = 'body' | 'hook' | 'core' | 'other';
type PhaseSlot = 'bodyEntry' | 'rejection' | 'sourceEntry' | 'coreEntry' | 'hookEntry' | 'releaseEntry'
  | 'releaseReturn' | 'preparation' | 'core' | 'body' | 'complete' | 'hook';
type Phase = 'body-entry' | 'rejection-fulfilled' | 'rejection-rejected' | 'source-entered'
  | `core-created-${RetirementOrigin}` | 'hook-request-fenced'
  | `hold-release-${ReleaseOrigin}-enter` | `hold-release-${ReleaseOrigin}-${'returned' | 'threw'}`
  | `${'preparation' | 'core' | 'body' | 'hook'}-${'fulfilled' | 'rejected'}` | 'owner-complete';
type PhaseRow = Readonly<{ owner: number; elapsedMs: number; phase: Phase }>;
type PhaseObserver = {
  claimed: Set<PhaseSlot>;
  rows: Partial<Record<PhaseSlot, PhaseRow>>;
  baseline?: number;
  last?: number;
  unavailable: boolean;
  noticeAttempted: boolean;
  clock: () => number;
  build: (elapsedMs: number, phase: Phase) => PhaseRow;
  serialize: (row: PhaseRow) => string;
  publish: (line: string) => void;
};
// One console channel: <=12 rows, each <=256 ASCII bytes plus this fixed prefix/newline.
// On any known observer fault, stop rich publication and attempt this one prebuilt notice.
// Console return is only an emission attempt; there is no raw mirror, retry, drain or ACK.
const phasePrefix = 'Producer fixture phase: ';
const phaseUnavailable = 'Producer fixture phase observer unavailable (owner 1; missing phases unobserved)';
let firstActualOwner: FixtureOwner | undefined;

function phaseUnavailableOnce(observer: PhaseObserver): void {
  observer.unavailable = true;
  if (observer.noticeAttempted) return;
  observer.noticeAttempted = true;
  try { observer.publish(phaseUnavailable); } catch { /* Optional status attempt, never an ACK. */ }
}

function attachPhaseObserver(owner: FixtureOwner): void {
  let observer: PhaseObserver | undefined;
  try {
    observer = {
      claimed: new Set(), rows: {}, unavailable: false, noticeAttempted: false,
      clock: () => performance.now(),
      build: (elapsedMs, phase) => Object.freeze({ owner: 1, elapsedMs, phase }),
      serialize: (row) => JSON.stringify(row),
      publish: (line) => { console.error(line); },
    };
    owner.phases = observer;
    const baseline = observer.clock();
    if (!Number.isFinite(baseline) || baseline < 0) throw new Error('Unavailable monotonic baseline.');
    observer.baseline = baseline;
    observer.last = baseline;
  } catch {
    if (observer) phaseUnavailableOnce(observer);
    else {
      // Initialization itself may be unavailable before state can be attached.
      try { console.error(phaseUnavailable); } catch { /* One optional fixed status attempt. */ }
    }
  }
}

function markPhase(owner: FixtureOwner, slot: PhaseSlot, phase: Phase): void {
  fixtureDiagnostic(() => {
    const observer = owner.phases;
    if (!observer || observer.unavailable) return;
    try {
      if (observer.claimed.has(slot)) return;
      // Reserve BEFORE any optional clock/build/publisher can synchronously reenter.
      observer.claimed.add(slot);
      const now = observer.clock();
      if (observer.baseline === undefined || observer.last === undefined || !Number.isFinite(now)
        || now < observer.last || now < observer.baseline) throw new Error('Unavailable monotonic reading.');
      observer.last = now;
      const row = Object.freeze(observer.build(now - observer.baseline, phase));
      observer.rows[slot] = row;
      const serialized = observer.serialize(row);
      if (typeof serialized !== 'string' || serialized.length > 256 || /[^\x20-\x7e]/.test(serialized)) {
        throw new Error('Unavailable bounded phase serialization.');
      }
      const line = phasePrefix + serialized;
      observer.publish(line);
    } catch { phaseUnavailableOnce(observer); }
  });
}

function observePhaseSettlement(owner: FixtureOwner, pending: Promise<unknown>, slot: 'rejection' | 'preparation' | 'core' | 'body' | 'hook'): void {
  fixtureDiagnostic(() => {
    if (!owner.phases) return;
    // Observe the original raw promise, never replace it with this detached branch.
    void pending.then(
      () => { markPhase(owner, slot, `${slot}-fulfilled`); },
      () => { markPhase(owner, slot, `${slot}-rejected`); },
    );
  });
}
type FixtureOwner = {
  preparationStages?: PreparationObserver;
  phases?: PhaseObserver;
  directory?: string;
  fixture?: Fixture;
  stop?: () => Promise<void>;
  reset?: () => void;
  retiring: boolean;
  disposed: boolean;
  complete: boolean;
  hookRequested: boolean;
  operations: Promise<unknown>[];
  releases: Array<(origin?: ReleaseOrigin) => void>;
  holds: Array<(origin?: ReleaseOrigin) => void>;
  released: Set<() => void>;
  releaseFailures: Failure[];
  toolWork: Array<{ tool: string; started: number; state: 'pending' | 'completed' | 'failed' }>;
  setup?: Promise<Completion>;
  body?: Promise<Completion>;
  core?: Promise<CoreCompletion>;
  hook?: Promise<Completion>;
  final?: Completion;
  teardown: Array<() => void | Promise<void>>;
  expected: readonly Error[];
  acknowledged: Set<Failure>;
};
const bodyOwner = new AsyncLocalStorage<FixtureOwner>();
const hookOwners = new WeakMap<object, FixtureOwner>();
let activeOwner: FixtureOwner | undefined;

function newOwner(): FixtureOwner {
  return {
    retiring: false, disposed: false, complete: false, hookRequested: false, operations: [], releases: [],
    holds: [], released: new Set(), releaseFailures: [], toolWork: [], teardown: [],
    expected: [], acknowledged: new Set(),
  };
}

function ownGrantIO<T>(owner: FixtureOwner, start: () => Promise<T>, fixture?: Fixture): Promise<T> {
  if (owner.retiring || owner.disposed || owner.complete) throw new Error('Producer fixture grant IO cannot be admitted.');
  if (fixture && owner.fixture !== fixture) throw new Error('Producer grant IO requires its original fixture owner.');
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const claim = new Promise<unknown>((complete, failed) => { resolve = complete; reject = failed; });
  // Observe rejection immediately, but store the ORIGINAL rejecting claim for all-settlement.
  void claim.then(undefined, (): undefined => undefined);
  try { owner.operations.push(claim); } catch (error) { reject(error); throw error; }
  try {
    const actual = start();
    void actual.then(resolve, reject);
    return actual;
  } catch (error) {
    reject(error);
    throw error;
  }
}

// Post-setup fixture reads are separate admitted work, not the raw body itself.
// Keep the original rejecting claim so the sole core drains the actual settlement.
function ownFixtureRead<T>(owner: FixtureOwner, start: () => Promise<T>, fixture?: Fixture): Promise<T> {
  if (owner.retiring || owner.disposed || owner.complete) throw new Error('Producer fixture read cannot be admitted.');
  if (fixture && owner.fixture !== fixture) throw new Error('Producer read requires its original fixture owner.');
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const claim = new Promise<unknown>((complete, failed) => { resolve = complete; reject = failed; });
  void claim.then(undefined, (): undefined => undefined);
  try { owner.operations.push(claim); } catch (error) { reject(error); throw error; }
  try {
    const actual = start();
    void actual.then(resolve, reject);
    return actual;
  } catch (error) {
    reject(error);
    throw error;
  }
}

type PreparationStage = 'outer' | 'transfer' | 'snapshot' | 'bundle';
type PreparationSlot = `${PreparationStage}-${'entered' | 'settled'}` | 'mcp';
type PreparationReady = boolean | 'unknown';
type PreparationToolError = boolean | 'absent';
const preparationCodes = ['not_a_repository', 'no_commits', 'invalid_repository', 'unsupported_repository', 'uncommitted_branch',
  'git_failed', 'unsafe_entry', 'source_changed', 'bounds_exceeded', 'secret_blocked', 'hash_mismatch', 'filesystem_failed', 'invalid_staging'] as const;
type PreparationCode = (typeof preparationCodes)[number] | 'none' | 'unknown';
type PreparationRow = Readonly<{ owner: 1; stage: PreparationStage | 'mcp'; event: 'entered' | 'fulfilled' | 'rejected' | 'threw';
  elapsedMs: number; error?: PreparationCode; ready?: PreparationReady; isError?: PreparationToolError }>;
type PreparationObserver = {
  baseline?: number; last?: number; selected: boolean; unavailable: boolean; noticeAttempted: boolean;
  context: AsyncLocalStorage<PreparationObserver | undefined>;
  started: Set<PreparationStage>; claimed: Set<PreparationSlot>; rows: Partial<Record<PreparationSlot, PreparationRow>>;
  clock: () => number; build: (row: PreparationRow) => PreparationRow;
  serialize: (row: PreparationRow) => string; publish: (line: string) => void;
};
// Nine reserved rich attempts <=256 ASCII bytes INCLUDING prefix/newline, plus one <=128-byte notice.
// Added <=2432 bytes/10 calls; with the unchanged old observer <=5885 bytes/23 calls. No ACK/retry/drain.
const preparationPrefix = 'Producer fixture preparation: ';
const preparationUnavailable = 'Producer fixture preparation unavailable (owner 1; missing stages/outcome unobserved)';
let firstPreparationOwner: FixtureOwner | undefined;

function preparationUnavailableOnce(observer: PreparationObserver): void {
  observer.unavailable = true;
  if (observer.noticeAttempted) return;
  observer.noticeAttempted = true;
  try { observer.publish(preparationUnavailable); } catch { /* One optional emission attempt, never delivery ACK. */ }
}

function newPreparationObserver(baseline: number | undefined): PreparationObserver {
  return { baseline, last: baseline, selected: false, unavailable: false, noticeAttempted: false,
    context: new AsyncLocalStorage(), started: new Set(), claimed: new Set(), rows: {}, clock: () => performance.now(),
    build: (row) => Object.freeze(row), serialize: (row) => JSON.stringify(row), publish: (line) => { console.error(line); } };
}

function preparationCode(value: unknown): PreparationCode {
  const code = value && typeof value === 'object' ? (value as { code?: unknown }).code : undefined;
  return preparationCodes.some((known) => known === code) ? code as (typeof preparationCodes)[number] : 'unknown';
}

function preparationReady(value: unknown): PreparationReady {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
  const ready = (value as { ready?: unknown }).ready;
  return typeof ready === 'boolean' ? ready : 'unknown';
}

function preparationMcp(value: unknown): { ready: PreparationReady; isError: PreparationToolError; error: PreparationCode } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ready: 'unknown', isError: 'absent', error: 'unknown' };
  const result = value as { isError?: unknown; content?: unknown };
  let isError: PreparationToolError = 'absent';
  if (Object.prototype.hasOwnProperty.call(result, 'isError')) {
    if (typeof result.isError !== 'boolean') throw new Error('Unavailable tool error metadata.');
    isError = result.isError;
  }
  const unknown = { ready: 'unknown' as const, isError, error: 'unknown' as const };
  if (!Array.isArray(result.content) || result.content.length !== 1) return unknown;
  const first = result.content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type !== 'text' || typeof first.text !== 'string' || first.text.length > 16 * 1024
    || Buffer.byteLength(first.text, 'utf8') > 16 * 1024) return unknown;
  let parsed: unknown;
  try { parsed = JSON.parse(first.text); } catch { return unknown; }
  const ready = preparationReady(parsed);
  const reason = parsed && typeof parsed === 'object' ? (parsed as { reason?: unknown }).reason : undefined;
  return { ready, isError, error: ready === true ? 'none' : preparationCode({ code: reason }) };
}

function markPreparation(observer: PreparationObserver, slot: PreparationSlot, build: (elapsedMs: number) => PreparationRow): void {
  try {
    if (observer.unavailable) return;
    if (observer.claimed.has(slot)) { preparationUnavailableOnce(observer); return; }
    observer.claimed.add(slot); // BEFORE optional clock/build/storage/serialization/publication reentry.
    const now = observer.clock(), baseline = observer.baseline;
    if (observer.unavailable) return;
    if (baseline === undefined || observer.last === undefined || !Number.isFinite(baseline) || baseline < 0
      || !Number.isFinite(now) || now < observer.last || now < baseline) throw new Error('Unavailable preparation clock.');
    observer.last = now;
    const input = Object.freeze(build(now - baseline)), row = observer.build(input);
    if (observer.unavailable) return;
    const keys = Object.keys(input) as Array<keyof PreparationRow>;
    if (!Object.isFrozen(row) || Object.keys(row).length !== keys.length || keys.some((key) => row[key] !== input[key])) {
      throw new Error('Unavailable preparation row.');
    }
    observer.rows[slot] = row;
    if (observer.unavailable) return;
    const encoded = observer.serialize(row);
    if (observer.unavailable) return;
    if (typeof encoded !== 'string' || /[^\x20-\x7e]/.test(encoded) || preparationPrefix.length + encoded.length + 1 > 256) {
      throw new Error('Unavailable bounded preparation serialization.');
    }
    const line = preparationPrefix + encoded;
    observer.publish(line);
  } catch { preparationUnavailableOnce(observer); }
}

function observePreparationStage<A extends unknown[], T>(observer: PreparationObserver, stage: PreparationStage,
  original: (...args: A) => Promise<T>, receiver: unknown, args: A): Promise<T> {
  let selected = false;
  try {
    selected = observer.context.getStore() === observer && !observer.unavailable;
    if (selected) {
      if (observer.started.has(stage)) { preparationUnavailableOnce(observer); selected = false; }
      else {
        observer.started.add(stage);
        markPreparation(observer, `${stage}-entered`, (elapsedMs) => ({ owner: 1, stage, event: 'entered', elapsedMs }));
      }
    }
  } catch { preparationUnavailableOnce(observer); }
  let actual: Promise<T>;
  try { actual = Reflect.apply(original, receiver, args); }
  catch (error) {
    if (selected) markPreparation(observer, `${stage}-settled`, (elapsedMs) => ({ owner: 1, stage, event: 'threw', elapsedMs, error: preparationCode(error) }));
    throw error;
  }
  if (selected) {
    try {
      void actual.then(
        (value) => { markPreparation(observer, `${stage}-settled`, (elapsedMs) => ({ owner: 1, stage, event: 'fulfilled', elapsedMs,
          error: 'none', ...(stage === 'outer' && { ready: preparationReady(value) }) })); },
        (error: unknown) => { markPreparation(observer, `${stage}-settled`, (elapsedMs) => ({ owner: 1, stage, event: 'rejected', elapsedMs, error: preparationCode(error) })); },
      );
    } catch { preparationUnavailableOnce(observer); }
  }
  return actual;
}

function preparationInvocation<T>(observer: PreparationObserver | undefined, selected: boolean, invoke: () => T): T {
  if (!observer) return invoke();
  let invoked = false, failed = false, originalError: unknown, result!: T;
  try {
    // Mask unrelated calls, including publisher reentry; nested stages of the admitted call retain its context.
    return observer.context.run(selected ? observer : undefined, () => {
      invoked = true;
      try { result = invoke(); return result; } catch (error) { failed = true; originalError = error; throw error; }
    });
  } catch {
    if (failed) throw originalError;
    observer.unavailable = true; // Notice is deferred until the actual caller promise is in the sole work ledger.
    return invoked ? result : invoke();
  }
}

function observePreparationMcp(observer: PreparationObserver, actual: Promise<McpToolResult>): void {
  try {
    void actual.then(
      (value) => { markPreparation(observer, 'mcp', (elapsedMs) => {
        const outcome = preparationMcp(value);
        if (observer.selected && outcome.ready === true && (['outer', 'transfer', 'snapshot', 'bundle'] as const).some((stage) =>
          !observer.rows[`${stage}-entered`] || !observer.rows[`${stage}-settled`])) throw new Error('Unavailable successful-path stage coverage.');
        return { owner: 1, stage: 'mcp', event: 'fulfilled', elapsedMs, ...outcome };
      }); },
      (error: unknown) => { markPreparation(observer, 'mcp', (elapsedMs) => ({ owner: 1, stage: 'mcp', event: 'rejected', elapsedMs,
        ready: 'unknown', isError: 'absent', error: preparationCode(error) })); },
    );
  } catch { preparationUnavailableOnce(observer); }
}

async function installPreparationObserver(owner: FixtureOwner): Promise<void> {
  if (owner !== firstPreparationOwner) return;
  let observer: PreparationObserver | undefined;
  try {
    observer = newPreparationObserver(owner.phases?.baseline);
    owner.preparationStages = observer;
    if (observer.baseline === undefined || !Number.isFinite(observer.baseline) || observer.baseline < 0) throw new Error('Unavailable preparation baseline.');
    const preparation = await import('../../src/main/services/handoff-preparations');
    const transfer = await import('../../src/main/services/handoff-transfer-preparation');
    const snapshot = await import('../../src/main/services/handoff-snapshot');
    const bundle = await import('../../src/main/services/handoff-git-bundle');
    const outerOriginal = preparation.prepareCallerHandoff, transferOriginal = transfer.prepareHandoffTransfer;
    const snapshotOriginal = snapshot.prepareHandoffSnapshot, bundleOriginal = bundle.prepareHandoffBundle;
    const captured = observer;
    vi.spyOn(preparation, 'prepareCallerHandoff').mockImplementation(function (this: unknown, ...args) {
      return observePreparationStage(captured, 'outer', outerOriginal, this, args);
    });
    vi.spyOn(transfer, 'prepareHandoffTransfer').mockImplementation(function (this: unknown, ...args) {
      return observePreparationStage(captured, 'transfer', transferOriginal, this, args);
    });
    vi.spyOn(snapshot, 'prepareHandoffSnapshot').mockImplementation(function (this: unknown, ...args) {
      return observePreparationStage(captured, 'snapshot', snapshotOriginal, this, args);
    });
    vi.spyOn(bundle, 'prepareHandoffBundle').mockImplementation(function (this: unknown, ...args) {
      return observePreparationStage(captured, 'bundle', bundleOriginal, this, args);
    });
  } catch {
    if (observer) preparationUnavailableOnce(observer);
    else { try { console.error(preparationUnavailable); } catch { /* Optional initialization status, never ACK. */ } }
  }
}

function fixtureOwner(): FixtureOwner {
  const owner = bodyOwner.getStore() ?? activeOwner;
  if (!owner) throw new Error('Producer fixture is not initialized.');
  return owner;
}

function fixtureDirectory(owner = fixtureOwner()): string {
  const directory = owner.directory;
  if (!directory) throw new Error('Producer fixture directory is not initialized.');
  return directory;
}

function allocateDirectory(owner: FixtureOwner, directory: string): void {
  if (owner.directory !== undefined) throw new Error('Producer fixture owner already has its original directory.');
  Object.defineProperty(owner, 'directory', { value: directory, enumerable: true });
}

function registerExpected(owner: FixtureOwner, errors: readonly Error[]): void {
  if (owner.retiring || owner.expected.length || !errors.length) throw new Error('Expected fixture errors must be registered before retirement.');
  owner.expected = Object.freeze([...errors]);
}

function admitOwner(): FixtureOwner {
  if (activeOwner && !activeOwner.complete) throw new Error('Previous producer fixture owner is unfinished; shared setup refused.');
  const owner = newOwner();
  activeOwner = owner;
  return owner;
}

function selectFirstRealOwner(owner: FixtureOwner): void {
  if (firstActualOwner) return;
  // Reserve BOTH selectors before the optional baseline clock/publication can reenter.
  firstActualOwner = owner;
  firstPreparationOwner = owner;
  attachPhaseObserver(owner);
}

function observe(owner: FixtureOwner, stage: 'setup' | 'body', callback: () => Promise<void>): Promise<void> {
  const pending = Promise.resolve().then(() => bodyOwner.run(owner, () => {
    if (stage === 'body') markPhase(owner, 'bodyEntry', 'body-entry');
    return callback();
  }));
  owner[stage] = pending.then(
    () => Object.freeze({ failures: Object.freeze([]) }),
    (error: unknown) => Object.freeze({ failures: Object.freeze([Object.freeze({ stage, error })]) }),
  );
  if (stage === 'body') observePhaseSettlement(owner, pending, 'body');
  return pending;
}

function runFixtureBody(callback: () => Promise<void>): Promise<void> {
  const owner = fixtureOwner();
  if (owner.retiring || owner.body) throw new Error('Producer fixture body cannot be admitted.');
  return observe(owner, 'body', callback);
}

function installFixture(owner: FixtureOwner, fixture: Fixture): void {
  if (owner.fixture) throw new Error('Producer fixture owner already has its original fixture.');
  Object.defineProperty(owner, 'fixture', { value: fixture, enumerable: true });
  if (owner.retiring) throw new Error('Producer fixture setup retired before caller wrapper installation.');
  const callTool = fixture.tools.callTool;
  vi.spyOn(fixture.tools, 'callTool').mockImplementation((...args) => {
    if (args[0] !== caller) return preparationInvocation(owner.preparationStages, false, () => callTool(...args));
    if (owner.retiring) throw new Error('Producer fixture is retiring; no new test calls may start.');
    let trace: (typeof owner.toolWork)[number] | undefined;
    fixtureDiagnostic(() => {
      trace = { tool: args[1].slice(0, 80), started: Date.now(), state: 'pending' };
      owner.toolWork.splice(0, Math.max(0, owner.toolWork.length - 7));
      owner.toolWork.push(trace);
    });
    const stages = owner.preparationStages;
    const selected = !!stages && !stages.selected && args[1] === 'prepare_handoff';
    if (selected) stages.selected = true; // No optional port is called before actual caller admission/registration.
    const pending = preparationInvocation(stages, selected, () => callTool(...args)).then((result) => {
      fixtureDiagnostic(() => { if (trace) trace.state = 'completed'; });
      return result;
    }, (error) => {
      fixtureDiagnostic(() => { if (trace) trace.state = 'failed'; });
      throw error;
    });
    owner.operations.push(pending);
    if (stages?.unavailable && !stages.noticeAttempted) preparationUnavailableOnce(stages);
    if (stages && selected) observePreparationMcp(stages, pending);
    return pending;
  });
}

function fixtureDiagnostic(observe: () => void): void {
  try { observe(); } catch {
    // Optional metadata must not mask actual caller outcomes or strand owned work.
  }
}

async function setupReal(context: TestContext): Promise<void> {
  const owner = admitOwner();
  hookOwners.set(context, owner);
  owner.teardown = [
    async () => { await owner.stop?.(); },
    () => { owner.reset?.(); },
    () => { vi.restoreAllMocks(); },
    () => { vi.useRealTimers(); },
    async () => { (await import('../../src/main/services/agent-config')).clearAgentConfigCache(); },
    () => { owner.disposed = true; },
    async () => { if (owner.directory) await fs.rm(owner.directory, { recursive: true, force: true }); },
  ];
  selectFirstRealOwner(owner);
  await observe(owner, 'setup', async () => {
    allocateDirectory(owner, await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-producer-admission-')));
    installFixture(owner, await setup(fixtureDirectory(owner), owner));
    await installPreparationObserver(owner);
  });
}

async function setupLight(context: TestContext): Promise<void> {
  const owner = admitOwner();
  hookOwners.set(context, owner);
  owner.teardown = [
    () => { vi.restoreAllMocks(); },
    () => { vi.useRealTimers(); },
    () => { owner.disposed = true; },
    async () => { if (owner.directory) await fs.rm(owner.directory, { recursive: true, force: true }); },
  ];
  await observe(owner, 'setup', async () => {
    allocateDirectory(owner, await fs.mkdtemp(path.join(os.tmpdir(), 'producer-model-')));
  });
}

function releaseOwned(owner: FixtureOwner, callbacks: Array<(origin?: ReleaseOrigin) => void>, origin: ReleaseOrigin): void {
  for (const release of callbacks.splice(0)) {
    if (owner.released.has(release)) continue;
    owner.released.add(release);
    const before = owner.releaseFailures.length;
    try { release(origin); } catch (error) {
      if (!owner.releaseFailures.slice(before).some((failure) => failure.error === error)) {
        owner.releaseFailures.push(Object.freeze({ stage: 'release', error }));
      }
    }
  }
}

function heldRelease(owner: FixtureOwner, release: () => void, preparationPhase = false): (origin?: ReleaseOrigin) => void {
  let released = false;
  const finish = (origin: ReleaseOrigin = 'body') => {
    if (released) return;
    released = true;
    if (preparationPhase) markPhase(owner, 'releaseEntry', `hold-release-${origin}-enter`);
    try { release(); } catch (error) {
      owner.releaseFailures.push(Object.freeze({ stage: 'release', error }));
      if (preparationPhase) markPhase(owner, 'releaseReturn', `hold-release-${origin}-threw`);
      throw error;
    }
    if (preparationPhase) markPhase(owner, 'releaseReturn', `hold-release-${origin}-returned`);
  };
  owner.holds.push(finish);
  // This invocation comes from late registration, not a fresh hook call.
  if (owner.hookRequested) releaseOwned(owner, owner.holds, 'other');
  return finish;
}

function failureError(failures: readonly Failure[]): unknown {
  if (failures.length === 1) return failures[0].error;
  if (failures.length > 1) return Object.assign(new Error('Producer fixture work or teardown failed.'), { errors: Object.freeze(failures.map((failure) => failure.error)) });
  return undefined;
}

async function retireCore(owner: FixtureOwner): Promise<CoreCompletion> {
  fixtureDiagnostic(() => {
    if (process.platform === 'win32') {
      const recent = owner.toolWork.slice(-8);
      if (recent.some((work) => work.state === 'pending')) {
        const now = Date.now();
        console.error('Producer fixture teardown work:', recent.map((work) => ({
          tool: work.tool.slice(0, 80), state: work.state, ageMs: now - work.started,
        })));
      }
    }
  });
  releaseOwned(owner, owner.releases, 'core');
  const failures: Failure[] = [...(await owner.setup)?.failures ?? []];
  const drained = new Set<Promise<unknown>>();
  while (owner.operations.length) {
    const batch = owner.operations.splice(0).filter((pending) => {
      if (drained.has(pending)) return false;
      drained.add(pending);
      return true;
    });
    for (const outcome of await Promise.allSettled(batch)) {
      if (outcome.status === 'rejected') failures.push(Object.freeze({ stage: 'work', error: outcome.reason }));
    }
    releaseOwned(owner, owner.releases, 'core');
  }
  const teardown: Completion[] = [];
  for (const finish of owner.teardown) {
    const step: Failure[] = [];
    try { await finish(); } catch (error) { step.push(Object.freeze({ stage: 'teardown', error })); }
    teardown.push(Object.freeze({ failures: Object.freeze(step) }));
    failures.push(...step);
  }
  failures.push(...owner.releaseFailures);
  return Object.freeze({ failures: Object.freeze(failures), teardown: Object.freeze(teardown), error: failureError(failures) });
}

function coreCompletion(owner: FixtureOwner, origin: RetirementOrigin = 'other'): Promise<CoreCompletion> {
  if (!owner.core) {
    owner.retiring = true;
    let resolve!: (record: CoreCompletion) => void;
    let reject!: (error: unknown) => void;
    owner.core = new Promise<CoreCompletion>((complete, failed) => { resolve = complete; reject = failed; });
    observePhaseSettlement(owner, owner.core, 'core');
    markPhase(owner, 'coreEntry', `core-created-${origin}`);
    retireCore(owner).then(resolve, reject);
  }
  return owner.core;
}

async function cleanupFixture(owner = fixtureOwner()): Promise<void> {
  const record = await coreCompletion(owner, 'manual');
  if (record.failures.length) throw record.error;
}

async function acknowledgeExpected(owner: FixtureOwner, error: unknown): Promise<void> {
  const record = await coreCompletion(owner);
  expect(owner.expected.length).toBeGreaterThan(0);
  expect(record.failures).toHaveLength(owner.expected.length);
  expect(error).toBe(record.error);
  if (record.failures.length > 1) {
    if (!(error instanceof Error) || !('errors' in error) || !Array.isArray(error.errors)) {
      throw new Error('Expected the complete original aggregate fixture error references.');
    }
    const originals: unknown[] = error.errors;
    expect(originals).toHaveLength(owner.expected.length);
    originals.forEach((original, index) => { expect(original).toBe(owner.expected[index]); });
  }
  record.failures.forEach((failure, index) => {
    expect(failure.stage).toBe('work');
    expect(failure.error).toBe(owner.expected[index]);
  });
  for (const failure of record.failures) owner.acknowledged.add(failure);
}

function hookCompletion(owner: FixtureOwner): Promise<Completion> {
  if (!owner.hook) {
    let resolve!: (record: Completion) => void;
    let reject!: (error: unknown) => void;
    owner.hook = new Promise<Completion>((complete, failed) => { resolve = complete; reject = failed; });
    owner.hookRequested = true;
    const retiring = coreCompletion(owner, 'hook');
    observePhaseSettlement(owner, owner.hook, 'hook');
    markPhase(owner, 'hookEntry', 'hook-request-fenced');
    releaseOwned(owner, owner.holds, 'hook');
    (async () => {
      const core = await retiring;
      const body = await owner.body;
      const all = [...core.failures, ...owner.releaseFailures.filter((failure) => !core.failures.includes(failure)), ...body?.failures ?? []];
      owner.final = Object.freeze({ failures: Object.freeze(all) });
      owner.complete = true;
      if (activeOwner === owner) activeOwner = undefined;
      markPhase(owner, 'complete', 'owner-complete');
      return Object.freeze({ failures: Object.freeze(all.filter((failure) => !owner.acknowledged.has(failure))) });
    })().then(resolve, reject);
  }
  return owner.hook;
}
async function cleanupContext(context: TestContext): Promise<void> {
  const owner = hookOwners.get(context);
  if (!owner) return;
  const record = await hookCompletion(owner);
  if (record.failures.length) throw failureError(record.failures);
}

function current(): Fixture {
  const owner = fixtureOwner();
  if (owner.disposed || !owner.fixture) throw new Error('Producer fixture is not initialized.');
  return owner.fixture;
}

async function prepare(fx: Fixture, exclude?: string[]): Promise<HandoffManifestSummary> {
  const result = await fx.tools.callTool(caller, 'prepare_handoff', { mode: 'worktree', ...(exclude && { exclude }) });
  expect(result.isError).not.toBe(true);
  const value = resultValue(result);
  expect(value).toMatchObject({ ready: true });
  if (!value || typeof value !== 'object' || !('summary' in value) || !('manifest' in value)) throw new Error('Expected a prepared manifest and summary.');
  const summary = summarizeHandoffManifest(parseHandoffManifest(value.manifest));
  expect(value.summary).toEqual(summary);
  return summary;
}

const offerArgs = (manifest: HandoffManifestSummary) => ({
  to: receiver, task: 'Continue fixture', brief: 'Synthetic unit fixture only', mode: 'worktree', manifest,
});

async function offer(fx: Fixture, summary: HandoffManifestSummary): Promise<Handoff> {
  const result = await fx.tools.callTool(caller, 'offer_handoff', offerArgs(summary));
  expect(result.isError).not.toBe(true);
  return parseHandoff(resultValue(result));
}

function catalog(fx: Fixture): Promise<string> {
  const owner = fixtureOwner();
  return ownFixtureRead(owner, () => nativeFs.promises.readFile(path.join(fx.userData, 'handoff-preparations.json'), 'utf8'), fx);
}

// The captured prepared-record lookup reads a real manifest before the dependent
// snapshot byte read. One original-owner claim covers that whole admitted chain.
function verifyCapturedPreparedSource(fx: Fixture, record: Handoff, project: Fixture['project'], second: string): Promise<void> {
  const owner = fixtureOwner();
  return ownFixtureRead(owner, async () => {
    const prepared = await fx.preparation.preparedSourceForRecord(record);
    expect(prepared.source.project).toEqual(project);
    expect(prepared.source.worktreeRoot).toBe(second);
    expect(await fs.readFile(path.join(prepared.snapshot.root, 'files', 'fixture.txt'), 'utf8')).toBe(contents);
  }, fx);
}

function verifySource(fx: Fixture, record: Handoff, summary: HandoffManifestSummary): Promise<void> {
  const owner = fixtureOwner();
  return ownFixtureRead(owner, async () => {
    expect(record.manifest).toEqual(summary);
    expect(fx.host.store.get(record.id)).toEqual(record);
    const prepared = await fx.preparation.preparedSourceForRecord(record);
    expect(prepared.source.project).toEqual(fx.project);
    expect(prepared.source.worktreeRoot).toBe(fx.repository);
    expect(await nativeFs.promises.readFile(path.join(prepared.snapshot.root, 'files', 'fixture.txt'), 'utf8')).toBe(contents);
  }, fx);
}

async function queuedOffer(fx: Fixture, seed: Handoff, summary: HandoffManifestSummary, args = offerArgs(summary)) {
  const entered = deferred(), queued = deferred(), release = deferred();
  fixtureOwner().releases.push(release.resolve);
  const transact: Fixture['host']['store']['transact'] = fx.host.store.transact.bind(fx.host.store);
  vi.spyOn(fx.host.store, 'transact').mockImplementation((id, change) => {
    if (id !== seed.id) queued.resolve();
    return transact(id, change);
  });
  const actualOffer: Fixture['host']['coordinator']['service']['offer'] = fx.host.coordinator.service.offer.bind(fx.host.coordinator.service);
  // Coordinator pruning precedes this entry. The blocker is an actual older history transaction.
  vi.spyOn(fx.host.coordinator.service, 'offer').mockImplementation((input, sender, beforeCommit, admission) => {
    const blocker = transact(seed.id, async (record) => {
      if (!record) throw new Error('Missing genuine seed history.');
      entered.resolve();
      await release.promise;
      return record;
    });
    fixtureOwner().operations.push(blocker);
    return actualOffer(input, sender, beforeCommit, admission);
  });
  const pending = fx.tools.callTool(caller, 'offer_handoff', args);
  fixtureOwner().operations.push(pending);
  await Promise.race([
    Promise.all([entered.promise, queued.promise]),
    pending.then((result) => { throw new Error(`Offer settled before its actual history-queue hold: ${JSON.stringify(result)}`); }),
  ]);
  return { pending, release: release.resolve };
}

async function heldPostPositiveSource(fx: Fixture, args: Record<string, unknown>, beforeVerification = false) {
  const permissions = await import('../../src/main/services/clubhouse-mcp/handoff-permissions');
  const approve = permissions.handoffAgreementCallApproved, source = fx.source.callerHandoffSource;
  const entered = deferred(), release = deferred();
  fixtureOwner().releases.push(release.resolve);
  let positive = false, held = false, returned = false, positiveCalls = 0;
  vi.spyOn(permissions, 'handoffAgreementCallApproved').mockImplementation(async (...input) => {
    const allowed = await approve(...input);
    if (input[1] === 'handoff.offer') {
      positive = allowed;
      if (allowed) {
        positiveCalls++;
        if (beforeVerification) { entered.resolve(); await release.promise; }
      }
    }
    return allowed;
  });
  vi.spyOn(fx.source, 'callerHandoffSource').mockImplementation(async (...input) => {
    const selected = await source(...input);
    if (positive && !held && !beforeVerification && input[0] === caller) {
      held = true;
      entered.resolve();
      await release.promise;
      returned = true;
    }
    return selected;
  });
  const pending = fx.tools.callTool(caller, 'offer_handoff', args);
  fixtureOwner().operations.push(pending);
  await Promise.race([entered.promise, pending.then(() => { throw new Error('Offer settled before postpositive source verification.'); })]);
  expect(positiveCalls).toBe(1);
  return { pending, release: release.resolve, returned: () => returned };
}

describe('isolated real MCP producer domain admission', () => {
  function windowsCleanup(): Promise<void> {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!platform?.configurable) throw new Error('Cannot isolate the synchronous Windows diagnostic branch.');
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      return cleanupFixture();
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  }

  async function heldFixturePreparation(fx: Fixture) {
    const entered = deferred(), release = deferred();
    const owner = fixtureOwner();
    const finish = heldRelease(owner, release.resolve, true);
    const source = fx.source.callerHandoffSource;
    vi.spyOn(fx.source, 'callerHandoffSource').mockImplementation(async (...args) => {
      const selected = await source(...args);
      markPhase(owner, 'sourceEntry', 'source-entered');
      entered.resolve();
      await release.promise;
      return selected;
    });
    const pending = fx.tools.callTool(caller, 'prepare_handoff', { mode: 'worktree' });
    observePhaseSettlement(owner, pending, 'preparation');
    await Promise.race([
      entered.promise,
      pending.then(() => { throw new Error('Preparation settled before its actual source hold.'); }),
    ]);
    return { pending, release: finish };
  }

  async function heldSelection(fx: Fixture, args: Record<string, unknown>, afterSelection = false) {
    const entered = deferred(), release = deferred();
    fixtureOwner().releases.push(release.resolve);
    const select = fx.preparation.selectPreparedHandoff;
    let selected: Awaited<ReturnType<typeof select>> | undefined;
    vi.spyOn(fx.preparation, 'selectPreparedHandoff').mockImplementation(async (...input) => {
      if (afterSelection) selected = await select(...input);
      entered.resolve();
      await release.promise;
      return selected ?? select(...input);
    });
    const pending = fx.tools.callTool(caller, 'offer_handoff', args);
    fixtureOwner().operations.push(pending);
    await entered.promise;
    return { pending, release: release.resolve, selected: () => selected };
  }

  function heldRename(fx: Fixture, filename: string, eligible = () => true) {
    const entered = deferred(), release = deferred();
    fixtureOwner().releases.push(release.resolve);
    const rename: typeof nativeFs.promises.rename = nativeFs.promises.rename.bind(nativeFs.promises);
    vi.spyOn(nativeFs.promises, 'rename').mockImplementation(async (from, to) => {
      if (to === path.join(fx.userData, filename) && eligible()) {
        entered.resolve();
        await release.promise;
      }
      return rename(from, to);
    });
    return { entered: entered.promise, release: release.resolve };
  }

  function remote(fx: Fixture) {
    return ownGrantIO(fixtureOwner(), async () => {
      const { publicKey } = generateKeyPairSync('ed25519');
      const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      const fingerprint = fx.machine.identity.computeFingerprint(publicKeyBase64);
      fx.machine.peers.addPeer({
        fingerprint, publicKey: publicKeyBase64, alias: 'Remote fixture', icon: 'computer', color: 'indigo',
        role: 'member', kind: 'desktop', pairedAt: '2026-01-01T00:00:00.000Z', lastSeen: '',
      });
      await fx.grants.updateAgentGrantChanges(caller, () => ({
        changes: [
          { action: 'handoff.offer', target: { kind: 'connected' }, mode: 'allow' },
          { action: 'handoff.offer', target: { kind: 'remote_dispatcher' }, mode: 'allow' },
        ],
      }));
      vi.spyOn(fx.machine.client, 'isMachineConnected').mockImplementation((machine) => machine === fingerprint);
      return fingerprint;
    }, fx);
  }

  async function configuredSource(fx: Fixture) {
    const config = await import('../../src/main/services/agent-config');
    const row: DurableAgentConfig = { id: caller, name: 'Original source', color: 'indigo',
      createdAt: '2026-01-01T00:00:00.000Z', worktreePath: fx.repository };
    const directory = path.join(fx.repository, '.clubhouse');
    await fs.mkdir(directory, { recursive: true });
    const write = async () => {
      await fs.writeFile(path.join(directory, 'agents.json'), JSON.stringify([row]));
      config.clearAgentConfigCache(fx.repository);
    };
    await write();
    fx.gate.forgetMcpCaller(caller);
    fx.gate.setMcpCaller(caller, fx.repository, row);
    return { row, write };
  }

  async function heldStandalonePreparation(fx: Fixture, mode: 'branch' | 'worktree') {
    const entered = deferred(), release = deferred(), selected = deferred();
    fixtureOwner().releases.push(release.resolve);
    const originalSource = fx.source.callerHandoffSource, select = fx.preparation.selectPreparedHandoff;
    let first = true;
    vi.spyOn(fx.source, 'callerHandoffSource').mockImplementation(async (...args) => {
      const source = await originalSource(...args);
      if (first) {
        first = false; entered.resolve();
        await release.promise;
      }
      return source;
    });
    vi.spyOn(fx.preparation, 'selectPreparedHandoff').mockImplementation((...args) => {
      const pending = select(...args);
      selected.resolve();
      return pending;
    });
    const pending = fx.tools.callTool(caller, 'prepare_handoff', { mode });
    fixtureOwner().operations.push(pending);
    await entered.promise;
    return { pending, release: release.resolve, selected: selected.promise };
  }

  describe('real fixture', () => {
    beforeEach(setupReal);
    afterEach(cleanupContext);

    it('keeps overlapping cleanup behind the original actual preparation drain', async () => runFixtureBody(async () => {
      const fx = current(), failure = new Error('Original overlap fixture caller rejection.');
      registerExpected(fixtureOwner(), [failure]);
      const grant = fx.tools.listToolGrants().find((tool) => tool.kind === 'global' && tool.name === 'offer_handoff')?.grant;
      if (!grant) throw new Error('Missing actual offer grant declaration.');
      fx.tools.registerGlobalTool('fixture_overlap_rejection', {
        description: 'Isolated actual overlapping teardown rejection control.',
        inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
      }, async () => { throw failure; }, { grant });
      const rejecting = fx.tools.callTool(caller, 'fixture_overlap_rejection', { to: receiver });
      observePhaseSettlement(fixtureOwner(), rejecting, 'rejection');
      const rejection = await rejecting.then(
        () => { throw new Error('Expected an actual registered caller rejection.'); },
        (error: unknown) => error,
      );
      expect(rejection).toBe(failure);
      const held = await heldFixturePreparation(fx);
      const stop = fx.hostApi.stopHandoffs;
      let stopCalls = 0, firstFinished = false, overlapFinished = false;
      vi.spyOn(fx.hostApi, 'stopHandoffs').mockImplementation(async () => {
        stopCalls++;
        await stop();
      });
      const first = cleanupFixture().then(
        () => { firstFinished = true; return { ok: true }; },
        (error: unknown) => { firstFinished = true; return { ok: false, error }; },
      );
      const overlap = cleanupFixture().then(
        () => { overlapFinished = true; return { ok: true }; },
        (error: unknown) => { overlapFinished = true; return { ok: false, error }; },
      );
      try {
        await Promise.race([overlap, new Promise((resolve) => setTimeout(resolve, 25))]);
        expect.soft(firstFinished).toBe(false);
        expect.soft(overlapFinished).toBe(false);
        expect.soft(stopCalls).toBe(0);
        expect.soft(nativeFs.existsSync(fx.userData)).toBe(true);
      } finally {
        held.release();
        try { await held.pending; } finally {
          for (const outcome of await Promise.all([first, overlap])) {
            if ('error' in outcome) {
              expect.soft(outcome.error).toBe(failure);
              await acknowledgeExpected(fixtureOwner(), outcome.error);
            }
            else expect.soft(false, 'Expected both cleanup callers to retain the original actual caller rejection.').toBe(true);
          }
          expect.soft(stopCalls).toBe(1);
          expect.soft(nativeFs.existsSync(fx.userData)).toBe(false);
        }
      }
    }));

    it('keeps admitted direct grant IO ahead of original owner directory removal', async () => runFixtureBody(async () => {
      const fx = current(), owner = fixtureOwner(), directory = fixtureDirectory(owner);
      const destination = path.join(fx.userData, 'agent-grants.json');
      const entered = deferred(), release = deferred();
      const rename: typeof nativeFs.promises.rename = nativeFs.promises.rename.bind(nativeFs.promises);
      const stop = fx.hostApi.stopHandoffs, reset = fx.requests._resetGrantRequestsForTesting;
      let stopCalls = 0, resetCalls = 0, renameEntries = 0, nativeCalls = 0, ioSettled = false, coreFinished = false;
      let source: string | undefined, nativePromise: Promise<void> | undefined, nativeError: unknown;
      let core: Promise<CoreCompletion> | undefined;
      vi.spyOn(fx.hostApi, 'stopHandoffs').mockImplementation(async () => { stopCalls++; await stop(); });
      vi.spyOn(fx.requests, '_resetGrantRequestsForTesting').mockImplementation(() => { resetCalls++; reset(); });
      vi.spyOn(nativeFs.promises, 'rename').mockImplementation((from, to) => {
        if (to !== destination) return rename(from, to);
        renameEntries++;
        return (async () => {
          if (typeof from !== 'string') throw new Error('Expected the actual settings temporary path.');
          source = from;
          expect(path.dirname(from)).toBe(fx.userData);
          expect(path.basename(from).startsWith('.agent-grants.json.tmp-')).toBe(true);
          expect((await fs.stat(from)).isFile()).toBe(true);
          expect(JSON.parse(await fs.readFile(from, 'utf8'))).toMatchObject({ agents: { [caller]: {
            changes: expect.arrayContaining([expect.objectContaining({ action: 'handoff.offer', mode: 'off' })]),
          } } });
          entered.resolve();
          await release.promise;
          nativeCalls++;
          nativePromise = rename(from, to);
          void nativePromise.then(() => {}, (error: unknown) => { nativeError = error; });
          return nativePromise;
        })();
      });
      const update = fx.grants.updateAgentGrantChanges;
      let originalGrant: ReturnType<typeof update> | undefined;
      vi.spyOn(fx.grants, 'updateAgentGrantChanges').mockImplementation((...args) => { originalGrant = update(...args); return originalGrant; });
      const actual = fx.setGrant('off');
      expect(actual).toBe(originalGrant);
      const outcome = actual.then(
        (value) => { ioSettled = true; return { status: 'fulfilled' as const, value }; },
        (error: unknown) => { ioSettled = true; return { status: 'rejected' as const, error }; },
      );
      const errors: unknown[] = [];
      try {
        await Promise.race([
          entered.promise,
          outcome.then((settled) => {
            if (settled.status === 'rejected') throw settled.error;
            throw new Error('Direct grant update settled before its actual native rename hold.');
          }),
        ]);
        expect(renameEntries).toBe(1);
        expect(nativeCalls).toBe(0);
        expect(ioSettled).toBe(false);
        // The frozen red has zero work; this successor must reserve before invocation.
        expect(owner.operations).toHaveLength(1);
        expect(owner.operations[0]).not.toBe(actual);
        expect(nativeFs.existsSync(directory)).toBe(true);
        expect(source && nativeFs.existsSync(source)).toBe(true);
        const hook = hookCompletion(owner);
        core = coreCompletion(owner);
        expect(hookCompletion(owner)).toBe(hook);
        expect(coreCompletion(owner)).toBe(core);
        const observedCore = core.then(() => { coreFinished = true; }, () => {});
        await Promise.race([observedCore, new Promise((resolve) => setTimeout(resolve, 25))]);
        expect.soft({
          ioSettled, nativeCalls, coreFinished,
          originalDirectoryPresent: nativeFs.existsSync(directory),
          originalUserDataPresent: nativeFs.existsSync(fx.userData),
        }, 'An already-admitted actual grant rename must precede original core completion/removal.').toEqual({
          ioSettled: false, nativeCalls: 0, coreFinished: false,
          originalDirectoryPresent: true, originalUserDataPresent: true,
        });
      } catch (error) { errors.push(error); } finally {
        release.resolve();
        if (!core) { hookCompletion(owner); core = coreCompletion(owner); }
        const settled = await Promise.allSettled([actual, core] as const);
        expect.soft(renameEntries).toBe(1);
        expect.soft(nativeCalls).toBe(1);
        expect.soft(nativePromise).toBeInstanceOf(Promise);
        expect.soft(stopCalls).toBe(1);
        expect.soft(resetCalls).toBe(1);
        expect.soft(nativeFs.existsSync(directory)).toBe(false);
        if (settled[0].status === 'fulfilled') {
          const originalOutcome = await outcome;
          expect.soft(originalOutcome.status).toBe('fulfilled');
          if (originalOutcome.status === 'fulfilled') expect.soft(settled[0].value).toBe(originalOutcome.value);
          expect.soft(settled[0].value).toMatchObject({ changes: expect.arrayContaining([expect.objectContaining({ action: 'handoff.offer', mode: 'off' })]) });
        }
        if (settled[0].status === 'rejected') {
          if (nativePromise) expect.soft(settled[0].reason).toBe(nativeError);
          errors.push(settled[0].reason);
        }
        if (settled[1].status === 'rejected') errors.push(settled[1].reason);
        else {
          expect.soft(settled[1].value.teardown).toHaveLength(7);
          if (settled[1].value.failures.length) errors.push(settled[1].value.error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw Object.assign(new Error('Original direct IO and core failures retained.'), { errors: Object.freeze(errors) });
    }));

    it.each([1, 9])('drains a real held preparation and completes teardown before reporting its original caller rejection (%i failures)', async (count) => runFixtureBody(async () => {
      const fx = current();
      const failures = Array.from({ length: count }, (_, index) => new Error(`Original fixture caller rejection ${index}.`));
      registerExpected(fixtureOwner(), failures);
      let next = 0;
      const grant = fx.tools.listToolGrants().find((tool) => tool.kind === 'global' && tool.name === 'offer_handoff')?.grant;
      if (!grant) throw new Error('Missing actual offer grant declaration.');
      const name = `fixture_teardown_rejection_${'x'.repeat(80)}`;
      fx.tools.registerGlobalTool(name, {
        description: 'Isolated fixture rejection control.',
        inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
      }, async () => { throw failures[next++]; }, { grant });
      for (const failure of failures) {
        const rejection = await fx.tools.callTool(caller, name, { to: receiver }).then(
          () => { throw new Error('Expected an actual registered caller rejection.'); },
          (error: unknown) => error,
        );
        expect(rejection).toBe(failure);
      }
      const held = await heldFixturePreparation(fx);
      const stop = vi.spyOn(fx.hostApi, 'stopHandoffs');
      const reset = vi.spyOn(fx.requests, '_resetGrantRequestsForTesting');
      let finished = false;
      let diagnostics: unknown;
      const logging = count > 1 ? vi.spyOn(console, 'error').mockImplementation((_label, rows: unknown) => { diagnostics = rows; }) : undefined;
      const cleaning = (count > 1 ? windowsCleanup() : cleanupFixture()).then(
        () => { finished = true; return { ok: true }; },
        (error: unknown) => { finished = true; return { ok: false, error }; },
      );
      logging?.mockRestore();
      let overlapFinished = false;
      const overlap = count > 1 ? cleanupFixture().then(
        () => { overlapFinished = true; return { ok: true }; },
        (error: unknown) => { overlapFinished = true; return { ok: false, error }; },
      ) : undefined;
      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect.soft(finished).toBe(false);
        expect.soft(nativeFs.existsSync(fx.userData)).toBe(true);
        expect.soft(stop).not.toHaveBeenCalled();
        if (overlap) expect.soft(overlapFinished).toBe(false);
      } finally {
        held.release();
        const prepared = await held.pending;
        const outcome = await cleaning;
        if (overlap) {
          const joined = await overlap;
          expect('error' in joined && 'error' in outcome).toBe(true);
          if ('error' in joined && 'error' in outcome) expect(joined.error).toBe(outcome.error);
        }
        expect.soft(prepared.isError).not.toBe(true);
        if ('error' in outcome) {
          if (count === 1) expect.soft(outcome.error).toBe(failures[0]);
          else {
            const error = outcome.error;
            expect.soft(error).toBeInstanceOf(Error);
            if (error && typeof error === 'object' && 'errors' in error && Array.isArray(error.errors)) {
              const originals: unknown[] = error.errors;
              expect.soft(originals).toHaveLength(count);
              failures.forEach((failure, index) => expect.soft(originals[index]).toBe(failure));
            } else expect.soft(false, 'Expected every original caller rejection after mandatory teardown.').toBe(true);
          }
          await acknowledgeExpected(fixtureOwner(), outcome.error);
        } else expect.soft(false, 'Expected original caller rejection after mandatory teardown.').toBe(true);
        expect.soft(stop).toHaveBeenCalledOnce();
        expect.soft(reset).toHaveBeenCalledOnce();
        expect.soft(nativeFs.existsSync(fx.userData)).toBe(false);
        expect.soft(current).toThrow('Producer fixture is not initialized.');
        if (count > 1) {
          expect.soft(Array.isArray(diagnostics)).toBe(true);
          if (Array.isArray(diagnostics)) {
            expect.soft(diagnostics).toHaveLength(8);
            const rows: unknown[] = diagnostics;
            const names: string[] = [];
            for (const row of rows) {
              if (row && typeof row === 'object' && 'tool' in row && typeof row.tool === 'string') {
                expect.soft(Object.keys(row).sort()).toEqual(['ageMs', 'state', 'tool']);
                expect.soft(row.tool.length).toBeLessThanOrEqual(80);
                names.push(row.tool);
              } else expect.soft(false, 'Expected bounded diagnostic metadata only.').toBe(true);
            }
            expect.soft(names).toHaveLength(8);
            expect.soft(names[0]).toHaveLength(80);
          }
        }
      }
    }));

    it.each(['clock', 'logger'] as const)('completes actual fixture teardown when its Windows %s diagnostic throws', async (port) => runFixtureBody(async () => {
      const fx = current(), held = await heldFixturePreparation(fx);
      const release = vi.fn(held.release);
      fixtureOwner().releases.push(release);
      const stop = vi.spyOn(fx.hostApi, 'stopHandoffs');
      const reset = vi.spyOn(fx.requests, '_resetGrantRequestsForTesting');
      const failure = new Error(`Original fixture ${port} diagnostic fault.`);
      let faulted = false;
      const diagnosticFailure = () => { faulted = true; throw failure; };
      const diagnostic = port === 'clock'
        ? vi.spyOn(Date, 'now').mockImplementationOnce(diagnosticFailure)
        : vi.spyOn(console, 'error').mockImplementationOnce(diagnosticFailure);
      let cleaning: Promise<void>;
      try {
        cleaning = windowsCleanup();
      } finally {
        diagnostic.mockRestore();
      }
      const observed = cleaning.then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      try {
        expect.soft(faulted).toBe(true);
        expect.soft(await observed).toEqual({ ok: true });
        expect.soft(release).toHaveBeenCalledOnce();
        expect.soft(stop).toHaveBeenCalledOnce();
        expect.soft(reset).toHaveBeenCalledOnce();
        expect.soft(nativeFs.existsSync(fx.userData)).toBe(false);
        expect.soft(current).toThrow('Producer fixture is not initialized.');
      } finally {
        held.release();
        expect.soft((await held.pending).isError).not.toBe(true);
      }
    }));

    it('forwards actual preparation once when its pre-forward diagnostic clock throws', async () => runFixtureBody(async () => {
      const fx = current();
      const source = vi.spyOn(fx.source, 'callerHandoffSource');
      let faulted = false;
      const clock = vi.spyOn(Date, 'now').mockImplementationOnce(() => {
        faulted = true;
        throw new Error('Original pre-forward diagnostic clock fault.');
      });
      const pending = (async () => fx.tools.callTool(caller, 'prepare_handoff', { mode: 'worktree' }))();
      clock.mockRestore();
      const outcome = await pending.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      expect.soft(faulted).toBe(true);
      expect.soft(source).toHaveBeenCalledOnce();
      if ('result' in outcome) expect.soft(outcome.result.isError).not.toBe(true);
      else expect.soft(false, 'Diagnostic failure masked the actual preparation.').toBe(true);
      expect.soft(nativeFs.existsSync(path.join(fx.userData, 'handoff-preparations.json'))).toBe(true);
    }));

    it('reports actual early offer settlement without entering an unreachable history hold', async () => runFixtureBody(async () => {
      const fx = current(), summary = await prepare(fx), seed = await offer(fx, summary);
      const before = await catalog(fx);
      await fx.setGrant('off');
      await expect(queuedOffer(fx, seed, summary)).rejects.toThrow('Offer settled before its actual history-queue hold:');
      expect(fx.host.store.list()).toEqual([seed]);
      expect(await catalog(fx)).toBe(before);
    }));

    it('keeps actual fixture preparation alive until teardown settles it', async () => runFixtureBody(async () => {
      const fx = current(), entered = deferred(), release = deferred();
      heldRelease(fixtureOwner(), release.resolve);
      const source = fx.source.callerHandoffSource;
      vi.spyOn(fx.source, 'callerHandoffSource').mockImplementation(async (...args) => {
        const selected = await source(...args);
        entered.resolve();
        await release.promise;
        return selected;
      });
      const pending = fx.tools.callTool(caller, 'prepare_handoff', { mode: 'worktree' });
      await entered.promise;
      let settled = false;
      const cleaning = cleanupFixture().then(() => { settled = true; });
      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect.soft(settled).toBe(false);
        expect.soft(nativeFs.existsSync(fx.userData)).toBe(true);
      } finally {
        release.resolve();
        const result = await pending;
        await cleaning;
        expect.soft(result.isError).not.toBe(true);
      }
    }));

    it('keeps current sender authority, source bytes and durable binding through a held history queue', async () => runFixtureBody(async () => {
      const fx = current(), summary = await prepare(fx);
      const seed = await offer(fx, summary);
      await verifySource(fx, seed, summary);
      const queued = await queuedOffer(fx, seed, summary);
      expect(fx.host.store.list()).toEqual([seed]);
      queued.release();
      const result = await queued.pending;
      expect(result.isError).not.toBe(true);
      await verifySource(fx, parseHandoff(resultValue(result)), summary);
      expect(fx.host.store.list()).toHaveLength(2);
      expect(fx.requests.listGrantRequests()).toEqual([]);
    }));
  });

  async function sentinelOwner(owner = newOwner()) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'producer-owner-control-'));
    allocateDirectory(owner, directory);
    owner.teardown = [
      () => { owner.disposed = true; },
      async () => { await fs.rm(directory, { recursive: true, force: true }); },
    ];
    return owner;
  }

  function preparationControl() {
    const observer = newPreparationObserver(performance.now()), lines: string[] = [];
    observer.publish = (line) => { lines.push(line); };
    return { observer, lines };
  }

  describe('ownership models', () => {
    beforeEach(setupLight);
    afterEach(cleanupContext);

    it('fixture read ownership reserves before synchronous reentry and returns actual work unchanged', async () => runFixtureBody(async () => {
      const owner = await sentinelOwner(), gate = deferred();
      const file = path.join(fixtureDirectory(owner), 'read.txt');
      await fs.writeFile(file, 'captured read');
      const actual = gate.promise.then(() => fs.readFile(file, 'utf8'));
      let core: Promise<CoreCompletion> | undefined, starts = 0;
      const returned = ownFixtureRead(owner, () => {
        starts++;
        expect(owner.operations).toHaveLength(1);
        core = coreCompletion(owner);
        return actual;
      });
      expect(returned).toBe(actual);
      expect(() => ownFixtureRead(owner, () => { starts++; return actual; })).toThrow('Producer fixture read cannot be admitted.');
      expect(starts).toBe(1);
      expect(nativeFs.existsSync(file)).toBe(true);
      gate.resolve();
      expect(await returned).toBe('captured read');
      expect((await core!).failures).toEqual([]);
      expect((await hookCompletion(owner)).failures).toEqual([]);
      expect(nativeFs.existsSync(fixtureDirectory(owner))).toBe(false);
    }));

    it.each(['sync', 'async'] as const)('fixture read ownership preserves original %s failure through its rejecting claim', async (kind) => runFixtureBody(async () => {
      const owner = await sentinelOwner(), original = new Error('Original read failure.');
      registerExpected(owner, [original]);
      if (kind === 'sync') expect(() => ownFixtureRead(owner, () => { throw original; })).toThrow(original);
      else {
        const actual = Promise.reject(original);
        const returned = ownFixtureRead(owner, () => actual);
        expect(returned).toBe(actual);
        await expect(returned).rejects.toBe(original);
      }
      const record = await coreCompletion(owner);
      expect(record.failures).toEqual([{ stage: 'work', error: original }]);
      expect(record.error).toBe(original);
      await acknowledgeExpected(owner, original);
      expect((await hookCompletion(owner)).failures).toEqual([]);
    }));

    it.each(['before', 'after'] as const)('fixture read ownership refuses invocation when registration fails %s insertion', async (point) => runFixtureBody(async () => {
      const owner = await sentinelOwner(), original = new Error('Original read registration failure.');
      let starts = 0;
      const push = owner.operations.push.bind(owner.operations);
      owner.operations.push = (...pending) => { if (point === 'after') push(...pending); throw original; };
      expect(() => ownFixtureRead(owner, () => { starts++; return Promise.resolve('unexpected'); })).toThrow(original);
      expect(starts).toBe(0);
      const record = await coreCompletion(owner);
      expect(record.failures).toEqual(point === 'after' ? [{ stage: 'work', error: original }] : []);
      expect((await hookCompletion(owner)).failures).toEqual(record.failures);
    }));

    it('fixture read ownership keeps late body lifetime separate from manual core completion', async () => runFixtureBody(async () => {
      const original = fixtureOwner(), owner = await sentinelOwner(), bodyGate = deferred(), reached = deferred();
      const file = path.join(fixtureDirectory(owner), 'body-read.txt');
      await fs.writeFile(file, 'original body');
      const actual = observe(owner, 'body', async () => {
        expect(await ownFixtureRead(owner, () => fs.readFile(file, 'utf8'))).toBe('original body');
        await cleanupFixture(owner);
        reached.resolve();
        await bodyGate.promise;
      });
      activeOwner = owner;
      try {
        await Promise.race([reached.promise, actual.then(() => { throw new Error('Body settled before its continuation.'); })]);
        expect(owner.complete).toBe(false);
        expect(() => admitOwner()).toThrow('Previous producer fixture owner is unfinished');
      } finally {
        bodyGate.resolve();
        try { await actual; expect((await hookCompletion(owner)).failures).toEqual([]); }
        finally { activeOwner = original; }
      }
    }));

    it('fixture read ownership retains unrelated mandatory cleanup failures', async () => runFixtureBody(async () => {
      const owner = await sentinelOwner(), original = new Error('Original rejected read.'), cleanup = new Error('Original cleanup failure.');
      registerExpected(owner, [original]);
      owner.teardown.unshift(() => { throw cleanup; });
      await expect(ownFixtureRead(owner, () => Promise.reject(original))).rejects.toBe(original);
      const record = await coreCompletion(owner);
      expect(record.failures).toEqual([{ stage: 'work', error: original }, { stage: 'teardown', error: cleanup }]);
      await expect(acknowledgeExpected(owner, record.error)).rejects.toThrow();
      expect((await hookCompletion(owner)).failures).toEqual(record.failures);
    }));

    it.each([
      { label: 'ready true absent error', result: { content: [{ type: 'text', text: '{"ready":true}' }] }, ready: true, isError: 'absent', error: 'none' },
      { label: 'exact16KiB JSON', result: { content: [{ type: 'text', text: '{"ready":true}' + ' '.repeat(16 * 1024 - 14) }] }, ready: true, isError: 'absent', error: 'none' },
      { label: 'structured not ready without tool error', result: { content: [{ type: 'text', text: '{"ready":false,"reason":"filesystem_failed","findings":["private"]}' }] }, ready: false, isError: 'absent', error: 'filesystem_failed' },
      { label: 'generic tool error', result: { content: [{ type: 'text', text: 'Private generic error text.' }], isError: true }, ready: 'unknown', isError: true, error: 'unknown' },
      { label: 'explicit false tool error', result: { content: [{ type: 'text', text: '{"ready":true}' }], isError: false }, ready: true, isError: false, error: 'none' },
      { label: 'malformed JSON', result: { content: [{ type: 'text', text: '{private' }] }, ready: 'unknown', isError: 'absent', error: 'unknown' },
      { label: 'oversize ASCII', result: { content: [{ type: 'text', text: ' '.repeat(16 * 1024) + '{"ready":true}' }] }, ready: 'unknown', isError: 'absent', error: 'unknown' },
      { label: 'oversize UTF8', result: { content: [{ type: 'text', text: 'é'.repeat(9 * 1024) }] }, ready: 'unknown', isError: 'absent', error: 'unknown' },
      { label: 'unexpected content', result: { content: [{ type: 'image', text: '{"ready":true}' }] }, ready: 'unknown', isError: 'absent', error: 'unknown' },
      { label: 'nonboolean ready', result: { content: [{ type: 'text', text: '{"ready":"true"}' }] }, ready: 'unknown', isError: 'absent', error: 'unknown' },
      { label: 'unknown reason', result: { content: [{ type: 'text', text: '{"ready":false,"reason":"private/path"}' }] }, ready: false, isError: 'absent', error: 'unknown' },
    ])('preparation observation classifies $label without changing actual metadata', async ({ result, ready, isError, error }) => runFixtureBody(async () => {
      const { observer, lines } = preparationControl(), actual = Promise.resolve(result as McpToolResult);
      observePreparationMcp(observer, actual);
      expect(await actual).toBe(result);
      expect(preparationMcp(result)).toEqual({ ready, isError, error });
      expect(observer.rows.mcp).toMatchObject({ ready, isError, error, event: 'fulfilled' });
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('private');
      expect(Object.isFrozen(observer.rows.mcp)).toBe(true);
    }));

    it.each(['invalid-isError', 'throwing-content'] as const)('preparation observation retains actual %s metadata and marks unavailable', async (fault) => runFixtureBody(async () => {
      const { observer, lines } = preparationControl();
      const value = fault === 'invalid-isError' ? { isError: 'private invalid metadata' }
        : Object.defineProperty({}, 'content', { get: () => { throw new Error('Private metadata getter failure.'); } });
      const actual = Promise.resolve(value as McpToolResult);
      observePreparationMcp(observer, actual);
      expect(await actual).toBe(value);
      expect(observer.unavailable).toBe(true);
      expect(observer.rows.mcp).toBeUndefined();
      expect(lines).toEqual([preparationUnavailable]);
    }));

    it('preparation observation retains original rejected MCP promise without inferring not-ready', async () => runFixtureBody(async () => {
      const { observer, lines } = preparationControl(), error = Object.assign(new Error('Private MCP rejection.'), { code: 'git_failed' });
      const actual = Promise.reject<McpToolResult>(error);
      observePreparationMcp(observer, actual);
      await expect(actual).rejects.toBe(error);
      expect(observer.rows.mcp).toMatchObject({ event: 'rejected', ready: 'unknown', isError: 'absent', error: 'git_failed' });
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('Private');
    }));

    it('preparation observation marks successful MCP with missing actual stage coverage unavailable', async () => runFixtureBody(async () => {
      const { observer, lines } = preparationControl(), value: McpToolResult = { content: [{ type: 'text', text: '{"ready":true}' }] };
      observer.selected = true;
      const actual = Promise.resolve(value);
      observePreparationMcp(observer, actual);
      expect(await actual).toBe(value);
      expect(observer.rows.mcp).toBeUndefined();
      expect(observer.unavailable).toBe(true);
      expect(lines).toEqual([preparationUnavailable]);
    }));

    it.each(['fulfilled', 'rejected', 'threw'] as const)('preparation observation preserves original this args promise value and %s outcome', async (kind) => runFixtureBody(async () => {
      const { observer, lines } = preparationControl(), receiver = Object.freeze({ identity: 'original receiver' }), arg = Object.freeze({ identity: 'original argument' });
      const value = Object.freeze({ ready: true, manifest: 'not serialized' }), error = Object.assign(new Error('Private original stage error.'), { code: 'filesystem_failed' });
      let calls = 0;
      const actual = kind === 'rejected' ? Promise.reject(error) : Promise.resolve(value);
      function original(this: unknown, input: typeof arg) {
        calls++;
        expect(this).toBe(receiver);
        expect(input).toBe(arg);
        if (kind === 'threw') throw error;
        return actual;
      }
      if (kind === 'threw') expect(() => observer.context.run(observer, () => observePreparationStage(observer, 'outer', original, receiver, [arg]))).toThrow(error);
      else {
        const returned = observer.context.run(observer, () => observePreparationStage(observer, 'outer', original, receiver, [arg]));
        expect(returned).toBe(actual);
        if (kind === 'rejected') await expect(returned).rejects.toBe(error);
        else expect(await returned).toBe(value);
      }
      expect(calls).toBe(1);
      expect(observer.rows['outer-entered']?.event).toBe('entered');
      expect(observer.rows['outer-settled']).toMatchObject({ event: kind, error: kind === 'fulfilled' ? 'none' : 'filesystem_failed' });
      expect(lines).toHaveLength(2);
      expect(lines.join('\n')).not.toContain('Private');
    }));

    it('preparation observation retains early entry and actual pending settlement without manufacturing readiness', async () => runFixtureBody(async () => {
      const { observer, lines } = preparationControl(), gate = deferred(), value = Object.freeze({ ready: true });
      const raw = gate.promise.then(() => value);
      const actual = observer.context.run(observer, () => observePreparationStage(observer, 'outer', () => raw, undefined, []));
      expect(actual).toBe(raw);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(observer.rows['outer-entered']?.event).toBe('entered');
      expect(observer.rows['outer-settled']).toBeUndefined();
      expect(observer.rows.mcp).toBeUndefined();
      expect(lines).toHaveLength(1);
      gate.resolve();
      expect(await actual).toBe(value);
      expect(observer.rows['outer-settled']).toMatchObject({ event: 'fulfilled', ready: true });
    }));

    it('preparation observation masks unrelated reentrant calls and marks repeated selected coverage unavailable', async () => runFixtureBody(async () => {
      const { observer, lines } = preparationControl(), value = Object.freeze({ ready: true });
      let calls = 0;
      const original = () => { calls++; return Promise.resolve(value); };
      await observer.context.run(observer, () => observePreparationStage(observer, 'outer', original, undefined, []));
      const prior = lines.length;
      expect(await observer.context.run(observer, () => preparationInvocation(observer, false, () => observePreparationStage(observer, 'outer', original, undefined, [])))).toBe(value);
      expect(lines).toHaveLength(prior);
      expect(observer.unavailable).toBe(false);
      expect(await observer.context.run(observer, () => observePreparationStage(observer, 'outer', original, undefined, []))).toBe(value);
      expect(calls).toBe(3);
      expect(observer.unavailable).toBe(true);
      expect(lines.filter((line) => line === preparationUnavailable)).toHaveLength(1);
    }));

    it.each(['clock', 'regression', 'nonfinite', 'construction', 'slot-storage', 'storage', 'serialization', 'publisher', 'baseline'] as const)(
      'preparation observation contains %s fault while original work and teardown settle', async (fault) => runFixtureBody(async () => {
        const owner = await sentinelOwner(), { observer, lines } = preparationControl();
        const marker = path.join(fixtureDirectory(owner), 'actual-stage-work');
        let calls = 0, attempts = 0, teardowns = 0;
        owner.teardown.unshift(() => { teardowns++; });
        const publish = observer.publish;
        observer.publish = (line) => { attempts++; if (fault === 'publisher') throw new Error('Optional publisher failure.'); publish(line); };
        if (fault === 'clock') observer.clock = () => { throw new Error('Optional clock failure.'); };
        if (fault === 'regression') observer.clock = () => observer.baseline! - 1;
        if (fault === 'nonfinite') observer.clock = () => Number.NaN;
        if (fault === 'construction') observer.build = () => { throw new Error('Optional builder failure.'); };
        if (fault === 'slot-storage') vi.spyOn(observer.claimed, 'add').mockImplementation(() => { throw new Error('Optional slot storage failure.'); });
        if (fault === 'storage') observer.rows = new Proxy({}, { set: () => { throw new Error('Optional row storage failure.'); } });
        if (fault === 'serialization') observer.serialize = () => 'x'.repeat(256);
        if (fault === 'baseline') observer.baseline = undefined;
        const raw = fs.writeFile(marker, 'actual'); owner.operations.push(raw);
        const actual = observer.context.run(observer, () => observePreparationStage(observer, 'snapshot', () => { calls++; return raw; }, undefined, []));
        expect(actual).toBe(raw);
        await actual;
        expect(calls).toBe(1);
        expect(observer.unavailable).toBe(true);
        expect(observer.noticeAttempted).toBe(true);
        expect(attempts).toBe(fault === 'publisher' ? 2 : 1);
        expect(lines).toEqual(fault === 'publisher' ? [] : [preparationUnavailable]);
        expect((await hookCompletion(owner)).failures).toEqual([]);
        expect(teardowns).toBe(1);
        expect(nativeFs.existsSync(fixtureDirectory(owner))).toBe(false);
      }));

    it.each(['before', 'after'] as const)('preparation observation preserves once forwarding through context failure %s invocation', async (when) => runFixtureBody(async () => {
      const { observer, lines } = preparationControl(), value = Object.freeze({ ready: true });
      const raw = Promise.resolve(value);
      let calls = 0;
      vi.spyOn(observer.context, 'run').mockImplementation((_store, callback) => {
        if (when === 'after') callback();
        throw new Error('Optional context failure.');
      });
      const actual = preparationInvocation(observer, true, () => { calls++; return raw; });
      expect(actual).toBe(raw);
      expect(await actual).toBe(value);
      expect(calls).toBe(1);
      expect(observer.unavailable).toBe(true);
      expect(lines).toEqual([]); // Functional caller ledger registration precedes this deferred optional notice.
      preparationUnavailableOnce(observer);
      expect(lines).toEqual([preparationUnavailable]);
    }));

    it.each(['clock', 'serialization', 'publisher'] as const)('preparation observation contains reentrant %s failure after original fences', async (port) => runFixtureBody(async () => {
      const owner = await sentinelOwner(), { observer, lines } = preparationControl();
      const error = new Error('Optional reentrant preparation port failure.');
      let calls = 0, joined: Promise<CoreCompletion> | undefined, hook: Promise<Completion> | undefined;
      const fail = () => { hook = hookCompletion(owner); joined = coreCompletion(owner); throw error; };
      if (port === 'clock') observer.clock = fail;
      if (port === 'serialization') observer.serialize = fail;
      if (port === 'publisher') observer.publish = fail;
      const raw = fs.writeFile(path.join(fixtureDirectory(owner), 'actual'), 'owned'); owner.operations.push(raw);
      const actual = observer.context.run(observer, () => observePreparationStage(observer, 'outer', () => { calls++; return raw; }, undefined, []));
      expect(actual).toBe(raw);
      await actual;
      expect(owner.retiring).toBe(true);
      expect(coreCompletion(owner)).toBe(joined);
      expect(hookCompletion(owner)).toBe(hook);
      expect((await coreCompletion(owner)).failures).toEqual([]);
      expect((await hookCompletion(owner)).failures).toEqual([]);
      expect(calls).toBe(1);
      expect(observer.unavailable).toBe(true);
      expect(observer.noticeAttempted).toBe(true);
      expect(lines).toEqual(port === 'publisher' ? [] : [preparationUnavailable]);
      expect(nativeFs.existsSync(fixtureDirectory(owner))).toBe(false);
    }));

    it('preparation observation stops an in-flight rich row after reserved-slot clock reentry', async () => runFixtureBody(async () => {
      const { observer, lines } = preparationControl(), value = Object.freeze({ ready: true });
      const clock = observer.clock;
      observer.clock = () => {
        markPreparation(observer, 'outer-entered', (elapsedMs) => ({ owner: 1, stage: 'outer', event: 'entered', elapsedMs }));
        return clock();
      };
      let calls = 0;
      const raw = Promise.resolve(value);
      const actual = observer.context.run(observer, () => observePreparationStage(observer, 'outer', () => { calls++; return raw; }, undefined, []));
      expect(actual).toBe(raw);
      expect(await actual).toBe(value);
      expect(calls).toBe(1);
      expect(observer.unavailable).toBe(true);
      expect(lines).toEqual([preparationUnavailable]);
      expect(observer.rows).toEqual({});
    }));

    it('preparation observation forwards nested already-admitted work after fenced publisher reentry', async () => runFixtureBody(async () => {
      const owner = await sentinelOwner(), { observer, lines } = preparationControl(), release = deferred();
      const marker = path.join(fixtureDirectory(owner), 'nested-work');
      let calls = 0, lateStarts = 0, refusal: unknown, joined: Promise<CoreCompletion> | undefined, hook: Promise<Completion> | undefined, present = false;
      owner.teardown.unshift(() => { present = nativeFs.readFileSync(marker, 'utf8') === 'actual nested work'; });
      const publish = observer.publish;
      observer.publish = (line) => {
        publish(line);
        if (line.includes('"stage":"outer"') && line.includes('"event":"entered"')) {
          hook = hookCompletion(owner); joined = coreCompletion(owner);
          try { bodyOwner.run(owner, () => runFixtureBody(async () => { lateStarts++; })); } catch (error) { refusal = error; }
        }
      };
      const raw = observer.context.run(observer, () => release.promise.then(() => observePreparationStage(observer, 'transfer', () => {
        calls++; expect(owner.retiring).toBe(true); return fs.writeFile(marker, 'actual nested work');
      }, undefined, [])));
      owner.operations.push(raw);
      const actual = observer.context.run(observer, () => observePreparationStage(observer, 'outer', () => raw, undefined, []));
      expect(actual).toBe(raw);
      expect(owner.retiring).toBe(true);
      expect(coreCompletion(owner)).toBe(joined);
      expect(hookCompletion(owner)).toBe(hook);
      expect(refusal).toBeInstanceOf(Error);
      expect(lateStarts).toBe(0);
      try { expect(nativeFs.existsSync(fixtureDirectory(owner))).toBe(true); }
      finally { release.resolve(); }
      await actual;
      expect((await coreCompletion(owner)).failures).toEqual([]);
      expect((await hookCompletion(owner)).failures).toEqual([]);
      expect(calls).toBe(1);
      expect(present).toBe(true);
      expect(observer.rows['transfer-settled']?.event).toBe('fulfilled');
      expect(lines.length).toBeLessThanOrEqual(9);
    }));

    it('grant IO ownership reserves before synchronous start reentry and returns actual work unchanged', async () => runFixtureBody(async () => {
      const owner = await sentinelOwner(), gate = deferred(), marker = path.join(fixtureDirectory(owner), 'actual-write');
      const value = Object.freeze({ original: 'actual result' });
      let starts = 0, refusedStarts = 0, visible = false, coreFinished = false, sawFile = false;
      let original: Promise<typeof value> | undefined, core: Promise<CoreCompletion> | undefined, hook: Promise<Completion> | undefined, refusal: unknown;
      owner.teardown.unshift(() => { sawFile = nativeFs.readFileSync(marker, 'utf8') === 'owned'; });
      const actual = ownGrantIO(owner, () => {
        starts++;
        visible = owner.operations.length === 1;
        hook = hookCompletion(owner);
        core = coreCompletion(owner);
        try { ownGrantIO(owner, () => { refusedStarts++; return fs.writeFile(marker, 'unadmitted'); }); }
        catch (error) { refusal = error; }
        original = gate.promise.then(async () => { await fs.writeFile(marker, 'owned'); return value; });
        return original;
      });
      expect(actual).toBe(original);
      expect(visible).toBe(true);
      expect(starts).toBe(1);
      expect(refusedStarts).toBe(0);
      expect(refusal).toBeInstanceOf(Error);
      expect(coreCompletion(owner)).toBe(core);
      expect(hookCompletion(owner)).toBe(hook);
      const observed = coreCompletion(owner).then(() => { coreFinished = true; });
      try {
        await Promise.race([observed, new Promise((resolve) => setTimeout(resolve, 25))]);
        expect.soft(coreFinished).toBe(false);
        expect.soft(nativeFs.existsSync(fixtureDirectory(owner))).toBe(true);
      } finally { gate.resolve(); }
      expect(await actual).toBe(value);
      expect((await coreCompletion(owner)).failures).toEqual([]);
      expect((await hookCompletion(owner)).failures).toEqual([]);
      expect(sawFile).toBe(true);
      expect(nativeFs.existsSync(fixtureDirectory(owner))).toBe(false);
    }));

    it.each(['sync', 'async'] as const)('grant IO ownership preserves original %s rejection through one rejected claim', async (kind) => runFixtureBody(async () => {
      const owner = await sentinelOwner(), syncError = new Error('Original synchronous grant-work failure.');
      let original: Promise<string> | undefined, returned: Promise<string> | undefined, error: unknown, starts = 0;
      try {
        returned = ownGrantIO(owner, () => {
          starts++;
          if (kind === 'sync') throw syncError;
          original = fs.readFile(path.join(fixtureDirectory(owner), 'actual-missing'), 'utf8');
          return original;
        });
      } catch (reason) { error = reason; }
      if (kind === 'async') {
        expect(returned).toBe(original);
        error = await returned!.then(() => { throw new Error('Expected the actual missing-file error.'); }, (reason: unknown) => reason);
        expect(await original!.catch((reason: unknown) => reason)).toBe(error);
      } else expect(error).toBe(syncError);
      expect(starts).toBe(1);
      if (!(error instanceof Error)) throw new Error('Expected an original operation Error reference.');
      await new Promise<void>((resolve) => setImmediate(resolve));
      registerExpected(owner, [error]);
      const record = await coreCompletion(owner);
      expect(record.failures).toHaveLength(1);
      expect(record.failures[0].stage).toBe('work');
      expect(record.failures[0].error).toBe(error);
      expect(record.error).toBe(error);
      await acknowledgeExpected(owner, error);
      expect((await hookCompletion(owner)).failures).toEqual([]);
      expect(owner.final?.failures[0].error).toBe(error);
      expect(nativeFs.existsSync(fixtureDirectory(owner))).toBe(false);
    }));

    it.each(['before', 'after'] as const)('grant IO ownership does not invoke work when registration fails %s insertion', async (when) => runFixtureBody(async () => {
      const owner = await sentinelOwner(), error = new Error('Original reservation registration fault.');
      let starts = 0, joined: Promise<CoreCompletion> | undefined;
      if (when === 'after') registerExpected(owner, [error]);
      const push = owner.operations.push.bind(owner.operations);
      const registration = vi.spyOn(owner.operations, 'push').mockImplementation((...claims) => {
        if (when === 'after') { push(...claims); joined = coreCompletion(owner); }
        throw error;
      });
      expect(() => ownGrantIO(owner, () => { starts++; return fs.writeFile(path.join(fixtureDirectory(owner), 'unstarted'), 'bad'); })).toThrow(error);
      registration.mockRestore();
      expect(starts).toBe(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const core = coreCompletion(owner);
      if (joined) expect(core).toBe(joined);
      const record = await core;
      if (when === 'after') {
        expect(record.failures).toHaveLength(1);
        expect(record.failures[0].error).toBe(error);
        await acknowledgeExpected(owner, error);
      } else expect(record.failures).toEqual([]);
      expect((await hookCompletion(owner)).failures).toEqual([]);
      expect(nativeFs.existsSync(fixtureDirectory(owner))).toBe(false);
    }));

    it('grant IO ownership retains an extra teardown error outside expected work acknowledgment', async () => runFixtureBody(async () => {
      const owner = await sentinelOwner(), workError = new Error('Original grant IO failure.'), teardownError = new Error('Original additional teardown failure.');
      registerExpected(owner, [workError]);
      owner.teardown.unshift(() => { throw teardownError; });
      const actual = ownGrantIO(owner, () => Promise.reject(workError));
      await expect(actual).rejects.toBe(workError);
      const record = await coreCompletion(owner);
      expect(record.failures.map((failure) => failure.error)).toEqual([workError, teardownError]);
      await expect(acknowledgeExpected(owner, record.error)).rejects.toThrow();
      expect(owner.acknowledged.size).toBe(0);
      expect((await hookCompletion(owner)).failures).toEqual(record.failures);
      expect(nativeFs.existsSync(fixtureDirectory(owner))).toBe(false);
    }));

    it('grant IO ownership permits body-to-core completion while retaining later body lifetime and stale admission', async () => runFixtureBody(async () => {
      const original = fixtureOwner(), owner = await sentinelOwner(), ioGate = deferred(), bodyGate = deferred(), reached = deferred();
      const marker = path.join(fixtureDirectory(owner), 'actual-owned-write');
      activeOwner = owner;
      const actualBody = observe(owner, 'body', async () => {
        const actualIO = ownGrantIO(owner, () => ioGate.promise.then(() => fs.writeFile(marker, 'owned')));
        const cleaning = cleanupFixture(owner);
        ioGate.resolve();
        await actualIO;
        await cleaning;
        reached.resolve();
        await bodyGate.promise;
      });
      let hook: Promise<Completion> | undefined;
      try {
        await Promise.race([reached.promise, actualBody.then(() => { throw new Error('Body ended before its continuation hold.'); })]);
        hook = hookCompletion(owner);
        expect(owner.complete).toBe(false);
        expect(() => admitOwner()).toThrow('Previous producer fixture owner is unfinished');
      } finally {
        bodyGate.resolve();
        try { await actualBody; await (hook ?? hookCompletion(owner)); }
        finally { activeOwner = original; }
      }
      activeOwner = owner;
      const next = await sentinelOwner(admitOwner());
      let starts = 0;
      try {
        expect(() => ownGrantIO(owner, () => { starts++; return fs.writeFile(path.join(fixtureDirectory(next), 'late'), 'bad'); })).toThrow('Producer fixture grant IO cannot be admitted.');
        expect(starts).toBe(0);
        expect(nativeFs.existsSync(fixtureDirectory(next))).toBe(true);
        expect(next.operations).toHaveLength(0);
      } finally { await hookCompletion(next); activeOwner = original; }
    }));
  });

  describe('real fixture', () => {
    beforeEach(setupReal);
    afterEach(cleanupContext);

    it('grant IO ownership binds exposed grants and rejects a mismatched fixture before remote effects', async () => runFixtureBody(async () => {
      const fx = current(), owner = fixtureOwner(), update = fx.grants.updateAgentGrantChanges;
      let starts = 0, original: ReturnType<typeof update> | undefined;
      vi.spyOn(fx.grants, 'updateAgentGrantChanges').mockImplementation((...args) => { starts++; original = update(...args); return original; });
      const peer = vi.spyOn(fx.machine.peers, 'addPeer');
      expect(() => remote({ ...fx })).toThrow('Producer grant IO requires its original fixture owner.');
      expect(starts).toBe(0);
      expect(peer).not.toHaveBeenCalled();
      const actual = fx.setGrant('off');
      expect(actual).toBe(original);
      expect((await actual)?.changes).toEqual(expect.arrayContaining([expect.objectContaining({ mode: 'off' })]));
      expect(starts).toBe(1);
      await cleanupFixture(owner);
      expect(() => fx.setGrant('allow')).toThrow('Producer fixture grant IO cannot be admitted.');
      expect(() => remote(fx)).toThrow('Producer fixture grant IO cannot be admitted.');
      expect(owner.operations).toHaveLength(0);
    }));

    it('grant IO ownership records a whole remote helper rejection once without a nested claim', async () => runFixtureBody(async () => {
      const fx = current(), owner = fixtureOwner(), error = new Error('Original remote grant rejection.'), ready = fx.machine.client.isMachineConnected;
      registerExpected(owner, [error]);
      vi.spyOn(fx.grants, 'updateAgentGrantChanges').mockRejectedValueOnce(error);
      await expect(remote(fx)).rejects.toBe(error);
      expect(fx.machine.client.isMachineConnected).toBe(ready);
      const record = await coreCompletion(owner);
      expect(record.failures).toHaveLength(1);
      expect(record.failures[0].stage).toBe('work');
      expect(record.failures[0].error).toBe(error);
      await acknowledgeExpected(owner, error);
    }));
  });

  function phaseControl(owner: FixtureOwner) {
    attachPhaseObserver(owner);
    const observer = owner.phases;
    if (!observer) throw new Error('Expected isolated diagnostic observer.');
    const lines: string[] = [];
    observer.publish = (line) => { lines.push(line); };
    return { observer, lines };
  }

  describe('ownership models', () => {
    beforeEach(setupLight);
    afterEach(cleanupContext);

    it.each(['manual', 'hook'] as const)('phase observer retains first %s origin and reserved late terminal slots through actual release reentry', async (origin) => runFixtureBody(async () => {
      const owner = await sentinelOwner(), { observer, lines } = phaseControl(owner);
      const bodyGate = deferred(), workGate = deferred(), reached = deferred();
      let releases = 0, teardowns = 0;
      const fences: Array<{ retiring: boolean; core?: Promise<CoreCompletion> }> = [];
      owner.teardown.unshift(() => { teardowns++; });
      const work = workGate.promise.then(() => fs.writeFile(path.join(fixtureDirectory(owner), 'actual-work'), 'owned'));
      owner.operations.push(work);
      observePhaseSettlement(owner, work, 'preparation');
      let reenteredHook: Promise<Completion> | undefined, reenteredCore: Promise<CoreCompletion> | undefined;
      const release = heldRelease(owner, () => {
        releases++;
        reenteredHook = hookCompletion(owner);
        reenteredCore = coreCompletion(owner, 'other');
        workGate.resolve();
      }, true);
      const publishing = observer.publish;
      observer.publish = (line) => {
        publishing(line);
        if (line.includes('core-created-')) {
          fences.push({ retiring: owner.retiring, core: owner.core });
          reenteredCore = coreCompletion(owner, 'other');
        }
        if (line.includes('hold-release-') && line.includes('-enter')) release('other');
      };
      const actual = observe(owner, 'body', async () => { reached.resolve(); await bodyGate.promise; });
      await reached.promise;
      let joining: Promise<Completion> | undefined;
      if (origin === 'manual') {
        const original = coreCompletion(owner, 'manual');
        for (let repeat = 0; repeat < 20; repeat++) expect(coreCompletion(owner, 'other')).toBe(original);
        release('body');
        await original;
      } else joining = hookCompletion(owner);
      const core = coreCompletion(owner);
      expect(fences).toEqual([{ retiring: true, core }]);
      expect((await core).failures).toEqual([]);
      expect(reenteredCore).toBe(core);
      expect(reenteredHook).toBe(joining ?? hookCompletion(owner));
      joining ??= hookCompletion(owner);
      expect(owner.complete).toBe(false);
      expect(observer.rows.complete).toBeUndefined();
      expect(observer.rows.hook).toBeUndefined();
      expect(observer.rows.coreEntry?.phase).toBe(`core-created-${origin}`);
      expect(observer.rows.releaseEntry?.phase).toBe(`hold-release-${origin === 'manual' ? 'body' : 'hook'}-enter`);
      expect(observer.rows.releaseReturn?.phase).toBe(`hold-release-${origin === 'manual' ? 'body' : 'hook'}-returned`);
      bodyGate.resolve();
      await actual;
      expect((await joining).failures).toEqual([]);
      for (let repeat = 0; repeat < 20; repeat++) { release('other'); expect(hookCompletion(owner)).toBe(joining); }
      expect(releases).toBe(1);
      expect(teardowns).toBe(1);
      expect(observer.rows.body?.phase).toBe('body-fulfilled');
      expect(observer.rows.complete?.phase).toBe('owner-complete');
      expect(observer.rows.hook?.phase).toBe('hook-fulfilled');
      expect(lines).toHaveLength(Object.keys(observer.rows).length);
      expect(lines.length).toBeLessThanOrEqual(12);
      for (const row of Object.values(observer.rows)) expect(Object.isFrozen(row)).toBe(true);
      expect(new Set(lines).size).toBe(lines.length);
      expect(nativeFs.existsSync(fixtureDirectory(owner))).toBe(false);
    }));

    it('phase observer leaves owner and hook terminal slots for a genuinely late original hook', async () => runFixtureBody(async () => {
      const owner = await sentinelOwner(), { observer, lines } = phaseControl(owner);
      const actual = observe(owner, 'body', async () => { await cleanupFixture(owner); });
      await actual;
      const core = coreCompletion(owner);
      expect((await core).failures).toEqual([]);
      for (let repeat = 0; repeat < 20; repeat++) expect(coreCompletion(owner, 'hook')).toBe(core);
      expect(observer.rows.body?.phase).toBe('body-fulfilled');
      expect(observer.rows.complete).toBeUndefined();
      expect(observer.rows.hook).toBeUndefined();
      expect(owner.complete).toBe(false);
      const hook = hookCompletion(owner);
      expect((await hook).failures).toEqual([]);
      expect(observer.rows.coreEntry?.phase).toBe('core-created-manual');
      expect(observer.rows.hookEntry?.phase).toBe('hook-request-fenced');
      expect(observer.rows.complete?.phase).toBe('owner-complete');
      expect(observer.rows.hook?.phase).toBe('hook-fulfilled');
      expect(lines).toHaveLength(7);
    }));

    it('phase observer attributes immediate late registration release to its actual other invocation', async () => runFixtureBody(async () => {
      const owner = await sentinelOwner(), { observer } = phaseControl(owner), gate = deferred(), entered = deferred();
      const actual = observe(owner, 'body', async () => { entered.resolve(); await gate.promise; });
      await entered.promise;
      const hook = hookCompletion(owner);
      let releases = 0;
      const release = heldRelease(owner, () => { releases++; }, true);
      release('body');
      expect(observer.rows.releaseEntry?.phase).toBe('hold-release-other-enter');
      expect(observer.rows.releaseReturn?.phase).toBe('hold-release-other-returned');
      expect(observer.rows.coreEntry?.phase).toBe('core-created-hook');
      expect(owner.complete).toBe(false);
      gate.resolve();
      await actual;
      expect((await hook).failures).toEqual([]);
      expect(releases).toBe(1);
      expect(observer.rows.complete?.phase).toBe('owner-complete');
      expect(observer.rows.hook?.phase).toBe('hook-fulfilled');
    }));

    it('phase observer baseline failure remains unavailable while actual owner accounting continues', async () => runFixtureBody(async () => {
      const owner = await sentinelOwner(), lines: unknown[] = [];
      const logging = vi.spyOn(console, 'error').mockImplementation((line: unknown) => { lines.push(line); });
      const clock = vi.spyOn(performance, 'now').mockImplementationOnce(() => { throw new Error('Optional baseline fault.'); });
      try { attachPhaseObserver(owner); } finally { clock.mockRestore(); logging.mockRestore(); }
      expect(owner.phases?.unavailable).toBe(true);
      expect(lines).toEqual([phaseUnavailable]);
      await observe(owner, 'body', async () => { await fs.writeFile(path.join(fixtureDirectory(owner), 'actual'), 'owned'); });
      expect((await hookCompletion(owner)).failures).toEqual([]);
      expect(owner.complete).toBe(true);
      expect(owner.phases?.rows).toEqual({});
      expect(nativeFs.existsSync(fixtureDirectory(owner))).toBe(false);
    }));

    it.each(['clock', 'regression', 'nonfinite', 'construction', 'slot-storage', 'storage', 'serialization', 'publisher'] as const)('phase observer contains %s faults without changing actual promises errors or teardown', async (fault) => runFixtureBody(async () => {
      const owner = await sentinelOwner(), { observer, lines } = phaseControl(owner);
      const releaseError = new Error('Original actual phase-control release failure.');
      const bodyError = new Error('Original actual phase-control body failure.');
      let releases = 0, teardowns = 0, publicationAttempts = 0;
      owner.teardown.unshift(() => { teardowns++; });
      const publish = observer.publish;
      observer.publish = (line) => {
        publicationAttempts++;
        if (fault === 'publisher') throw new Error('Optional publisher fault.');
        publish(line);
      };
      if (fault === 'clock') observer.clock = () => { throw new Error('Optional clock fault.'); };
      if (fault === 'regression') observer.clock = () => (observer.baseline ?? 0) - 1;
      if (fault === 'nonfinite') observer.clock = () => Number.NaN;
      if (fault === 'construction') observer.build = () => { throw new Error('Optional construction fault.'); };
      if (fault === 'slot-storage') vi.spyOn(observer.claimed, 'add').mockImplementation(() => { throw new Error('Optional slot reservation fault.'); });
      if (fault === 'storage') observer.rows = new Proxy({}, { set: () => { throw new Error('Optional row storage fault.'); } });
      if (fault === 'serialization') observer.serialize = () => { throw new Error('Optional serialization fault.'); };
      const release = heldRelease(owner, () => { releases++; throw releaseError; }, true);
      const actual = observe(owner, 'body', async () => { throw bodyError; });
      await expect(actual).rejects.toBe(bodyError);
      expect(owner.body).not.toBe(actual);
      const hook = hookCompletion(owner), core = coreCompletion(owner);
      expect(coreCompletion(owner)).toBe(core);
      expect(hookCompletion(owner)).toBe(hook);
      const record = await core, final = await hook;
      release();
      expect(record.failures.some((failure) => failure.stage === 'release' && failure.error === releaseError)).toBe(true);
      expect(final.failures.some((failure) => failure.stage === 'body' && failure.error === bodyError)).toBe(true);
      expect(final.failures.filter((failure) => failure.error === releaseError)).toHaveLength(1);
      expect(releases).toBe(1);
      expect(teardowns).toBe(1);
      expect(owner.complete).toBe(true);
      expect(observer.unavailable).toBe(true);
      expect(observer.noticeAttempted).toBe(true);
      expect(publicationAttempts).toBe(fault === 'publisher' ? 2 : 1);
      expect(lines).toEqual(fault === 'publisher' ? [] : [phaseUnavailable]);
      expect(nativeFs.existsSync(fixtureDirectory(owner))).toBe(false);
    }));

    it('phase observer reserves before optional reentry and records release throw without swallowing the original', async () => runFixtureBody(async () => {
      const owner = await sentinelOwner(), { observer, lines } = phaseControl(owner);
      const original = new Error('Original release throw after optional reentry.');
      let releases = 0;
      const fences: Array<{ retiring: boolean; core?: Promise<CoreCompletion>; joined: Promise<CoreCompletion> }> = [];
      const release = heldRelease(owner, () => { releases++; throw original; }, true);
      const publish = observer.publish;
      observer.publish = (line) => {
        publish(line);
        if (line.includes('hold-release-body-enter')) release('other');
        if (line.includes('core-created-')) {
          fences.push({ retiring: owner.retiring, core: owner.core, joined: coreCompletion(owner, 'hook') });
        }
      };
      expect(() => release('body')).toThrow(original);
      release('hook');
      const core = coreCompletion(owner, 'manual');
      expect(fences).toEqual([{ retiring: true, core, joined: core }]);
      const record = await core;
      expect(record.error).toBe(original);
      await expect(cleanupFixture(owner)).rejects.toBe(original);
      expect((await hookCompletion(owner)).failures[0].error).toBe(original);
      expect(observer.rows.releaseEntry?.phase).toBe('hold-release-body-enter');
      expect(observer.rows.releaseReturn?.phase).toBe('hold-release-body-threw');
      expect(observer.rows.coreEntry?.phase).toBe('core-created-manual');
      expect(releases).toBe(1);
      expect(lines.filter((line) => line.includes('hold-release-body-enter'))).toHaveLength(1);
      expect(observer.rows.complete?.phase).toBe('owner-complete');
      expect(observer.rows.hook?.phase).toBe('hook-fulfilled');
    }));
  });

  describe.each(['caller', 'body'] as const)('hook intake (%s)', (kind) => {
    beforeEach(kind === 'caller' ? setupReal : setupLight);
    afterEach(cleanupContext);

    it(`owner lifecycle closes automatic hook intake before synchronous release admission (${kind})`, async () => runFixtureBody(async () => {
      const fx = kind === 'caller' ? current() : undefined;
      const owner = kind === 'caller' ? fixtureOwner() : await sentinelOwner();
      const marker = path.join(fixtureDirectory(owner), 'hook-release-admission.txt');
      let calls = 0, bodyBytes: string | undefined, presentAtTeardown = false;
      const name = 'fixture_hook_release_admission';
      if (fx) {
        const grant = fx.tools.listToolGrants().find((tool) => tool.kind === 'global' && tool.name === 'offer_handoff')?.grant;
        if (!grant) throw new Error('Missing actual offer grant declaration.');
        fx.tools.registerGlobalTool(name, {
          description: 'Isolated actual hook-release caller admission control.',
          inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
        }, async () => {
          calls++;
          await fs.writeFile(marker, 'actual registered caller');
          return { content: [{ type: 'text', text: JSON.stringify({ bytes: await fs.readFile(marker, 'utf8') }) }] };
        }, { grant });
        const result = await fx.tools.callTool(caller, name, { to: receiver });
        expect(result.isError).not.toBe(true);
        expect(resultValue(result)).toEqual({ bytes: 'actual registered caller' });
        await fs.unlink(marker);
      }
      owner.teardown.unshift(() => { presentAtTeardown = nativeFs.existsSync(marker); });
      const stop = fx ? vi.spyOn(fx.hostApi, 'stopHandoffs') : undefined;
      let admitted: Promise<unknown> | undefined, refusal: unknown;
      let reenteredHook: Promise<Completion> | undefined, reenteredCore: Promise<CoreCompletion> | undefined;
      heldRelease(owner, () => {
        reenteredHook = hookCompletion(owner);
        try {
          admitted = fx
            ? fx.tools.callTool(caller, name, { to: receiver })
            : bodyOwner.run(owner, () => runFixtureBody(async () => {
              await fs.writeFile(marker, 'actual registered body');
              bodyBytes = await fs.readFile(marker, 'utf8');
            }));
          owner.operations.push(admitted);
        } catch (error) { refusal = error; }
        reenteredCore = coreCompletion(owner);
      });
      const joining = hookCompletion(owner);
      expect(reenteredHook).toBe(joining);
      expect(reenteredCore).toBe(coreCompletion(owner));
      const core = await coreCompletion(owner);
      expect(core.failures).toEqual([]);
      expect.soft(admitted).toBeUndefined();
      expect.soft(refusal).toBeInstanceOf(Error);
      if (refusal instanceof Error) {
        expect.soft(refusal.message).toBe(kind === 'caller'
          ? 'Producer fixture is retiring; no new test calls may start.'
          : 'Producer fixture body cannot be admitted.');
      }
      expect.soft(presentAtTeardown).toBe(false);
      expect.soft(calls).toBe(kind === 'caller' ? 1 : 0);
      expect.soft(bodyBytes).toBeUndefined();
      expect(nativeFs.existsSync(fixtureDirectory(owner))).toBe(false);
      if (stop) expect(stop).toHaveBeenCalledOnce();
      if (kind === 'body') expect((await joining).failures).toEqual([]);
    }));
  });

  describe('ownership models', () => {
    beforeEach(setupLight);
    afterEach(cleanupContext);

    it('owner lifecycle excludes later setup until the actual body finishes without a manual self-cycle', async () => runFixtureBody(async () => {
      const original = fixtureOwner(), owner = await sentinelOwner();
      const reached = deferred(), release = deferred();
      const actual = observe(owner, 'body', async () => {
        await cleanupFixture(owner);
        reached.resolve();
        await release.promise;
      });
      activeOwner = owner;
      let joined: Promise<Completion> | undefined;
      try {
        await Promise.race([reached.promise, actual.then(() => { throw new Error('Body settled before its continuation hold.'); })]);
        joined = hookCompletion(owner);
        expect(await Promise.race([joined, Promise.resolve('expired waiter')])).toBe('expired waiter');
        expect(owner.complete).toBe(false);
        expect(() => admitOwner()).toThrow('Previous producer fixture owner is unfinished');
        expect(bodyOwner.getStore()).toBe(original);
      } finally {
        release.resolve();
        await actual;
        expect((await (joined ?? hookCompletion(owner))).failures).toEqual([]);
        activeOwner = original;
      }
      expect(owner.complete).toBe(true);
      activeOwner = owner;
      const next = await sentinelOwner(admitOwner());
      try {
        let touched = 0;
        next.teardown.unshift(() => { touched++; });
        activeOwner = next;
        await cleanupFixture(owner);
        expect(nativeFs.existsSync(fixtureDirectory(next))).toBe(true);
        expect(touched).toBe(0);
        expect(owner.final?.failures).toEqual([]);
        expect((await hookCompletion(next)).failures).toEqual([]);
      } finally {
        await hookCompletion(next);
        activeOwner = original;
      }
    }));

    it('owner lifecycle hook releases original and late body holds exactly once before joining core', async () => runFixtureBody(async () => {
      const owner = await sentinelOwner(), gate = deferred(), bodyGate = deferred();
      let releases = 0;
      const release = heldRelease(owner, () => { releases++; gate.resolve(); });
      owner.operations.push(gate.promise);
      const actual = observe(owner, 'body', async () => {
        await cleanupFixture(owner);
        heldRelease(owner, bodyGate.resolve);
        await bodyGate.promise;
        release();
      });
      const joining = hookCompletion(owner);
      expect((await joining).failures).toEqual([]);
      await actual;
      expect(releases).toBe(1);
      expect(owner.complete).toBe(true);
      expect(nativeFs.existsSync(fixtureDirectory(owner))).toBe(false);
    }));

    it('owner lifecycle drains appended actual filesystem work and retains rejection plus every teardown outcome', async () => runFixtureBody(async () => {
      const owner = await sentinelOwner(), gate = deferred();
      const directory = fixtureDirectory(owner);
      const file = path.join(directory, 'settled.txt');
      const first = gate.promise.then(() => fs.writeFile(file, 'settled'));
      owner.operations.push(first, first);
      let readyAtTeardown = false;
      const teardownError = new Error('Original mandatory teardown fault.');
      owner.teardown.unshift(() => {
        readyAtTeardown = nativeFs.existsSync(file);
        throw teardownError;
      });
      const core = coreCompletion(owner);
      await Promise.resolve();
      const appended = fs.readFile(path.join(directory, 'missing'));
      const rejected = appended.then(
        () => { throw new Error('Expected an actual missing-file rejection.'); },
        (error: unknown) => error,
      );
      owner.operations.push(appended, appended);
      gate.resolve();
      const record = await core;
      const actualError = await rejected;
      expect(record.failures.map((failure) => failure.stage)).toEqual(['work', 'teardown']);
      expect(record.failures[0].error).toBe(actualError);
      expect(record.failures[1].error).toBe(teardownError);
      expect(record.teardown).toHaveLength(3);
      expect(readyAtTeardown).toBe(true);
      expect(nativeFs.existsSync(directory)).toBe(false);
      await expect(cleanupFixture(owner)).rejects.toBe(record.error);
      const final = await hookCompletion(owner);
      expect(final.failures).toEqual(record.failures);
    }));

    it.each(['caller', 'release', 'teardown', 'body'] as const)('owner lifecycle preserves unexpected %s errors without inferred acknowledgment', async (stage) => runFixtureBody(async () => {
      const owner = await sentinelOwner();
      const expected = new Error('Registered synthetic caller fault.'), unexpected = new Error(`Original unexpected ${stage} fault.`);
      registerExpected(owner, [expected]);
      owner.operations.push(Promise.reject(expected));
      if (stage === 'caller') owner.operations.push(Promise.reject(unexpected));
      if (stage === 'teardown') owner.teardown.unshift(() => { throw unexpected; });
      const record = await coreCompletion(owner);
      if (stage === 'caller' || stage === 'teardown') {
        await expect(acknowledgeExpected(owner, record.error)).rejects.toThrow();
        expect(owner.acknowledged.size).toBe(0);
        await observe(owner, 'body', async () => {});
      } else {
        await acknowledgeExpected(owner, record.error);
        if (stage === 'release') heldRelease(owner, () => { throw unexpected; });
        else await expect(observe(owner, 'body', async () => { throw unexpected; })).rejects.toBe(unexpected);
      }
      const final = await hookCompletion(owner);
      expect(final.failures.some((failure) => failure.error === unexpected)).toBe(true);
      expect(owner.final?.failures.some((failure) => failure.error === expected)).toBe(true);
      expect(final.failures.filter((failure) => failure.error === expected)).toHaveLength(stage === 'caller' || stage === 'teardown' ? 1 : 0);
      expect(nativeFs.existsSync(fixtureDirectory(owner))).toBe(false);
    }));

    it('owner lifecycle rejects equal-message unregistered error references despite fulfilled body', async () => runFixtureBody(async () => {
      const owner = await sentinelOwner(), expected = new Error('Synthetic reference.'), actual = new Error('Synthetic reference.');
      registerExpected(owner, [expected]);
      owner.operations.push(Promise.reject(actual));
      const record = await coreCompletion(owner);
      await expect(acknowledgeExpected(owner, record.error)).rejects.toThrow();
      await observe(owner, 'body', async () => {});
      expect(owner.acknowledged.size).toBe(0);
      const final = await hookCompletion(owner);
      expect(final.failures).toHaveLength(1);
      expect(final.failures[0].error).toBe(actual);
      expect(final.failures[0].stage).toBe('work');
    }));
  });

  describe('real fixture', () => {
    beforeEach(setupReal);
    afterEach(cleanupContext);

    it('owner lifecycle refuses incomplete actual setup and retains partial storage and late-install failure until settlement', async () => runFixtureBody(async () => {
      const original = fixtureOwner(), fx = current(), owner = await sentinelOwner(), gate = deferred();
      const raw = observe(owner, 'setup', async () => {
        await fs.writeFile(path.join(fixtureDirectory(owner), 'partial.txt'), 'partial');
        await gate.promise;
        installFixture(owner, fx);
      });
      activeOwner = owner;
      const core = coreCompletion(owner);
      try {
        await Promise.resolve();
        expect(() => admitOwner()).toThrow('Previous producer fixture owner is unfinished');
        expect(nativeFs.existsSync(fixtureDirectory(owner))).toBe(true);
      } finally {
        gate.resolve();
        await expect(raw).rejects.toThrow('setup retired before caller wrapper installation');
        const record = await core;
        expect(record.failures.map((failure) => failure.stage)).toEqual(['setup']);
        expect(nativeFs.existsSync(fixtureDirectory(owner))).toBe(false);
        expect((await hookCompletion(owner)).failures).toEqual(record.failures);
        activeOwner = original;
      }
      expect(fx.tools.callTool).toBeDefined();
    }));

    it('owner lifecycle reports actual early preparation refusal instead of stranding source entry', async () => runFixtureBody(async () => {
      const fx = current();
      const original = fx.registry.agentRegistry.get(caller);
      if (!original) throw new Error('Missing original fixture caller registration.');
      original.projectPath = path.join(fixtureDirectory(), 'unregistered-source');
      await expect(heldFixturePreparation(fx)).rejects.toThrow('Preparation settled before its actual source hold.');
      expect(nativeFs.existsSync(fx.userData)).toBe(true);
    }));











    describe('original producer continuity and admitted persistence', () => {
      it('retains original grant retirement even when Allow is restored before the queue resumes', async () => runFixtureBody(async () => {
        const fx = current(), summary = await prepare(fx), seed = await offer(fx, summary);
        const before = await catalog(fx);
        const queued = await queuedOffer(fx, seed, summary);
        await fx.setGrant('off');
        await fx.setGrant('allow');
        queued.release();
        expect((await queued.pending).isError).toBe(true);
        expect(fx.host.store.list()).toEqual([seed]);
        expect(await catalog(fx)).toBe(before);
      }));

      it('preserves gate-forget-only completion, unrelated bindings and cosmetic runtime metadata', async () => runFixtureBody(async () => {
        const fx = current(), summary = await prepare(fx), seed = await offer(fx, summary);
        const queued = await queuedOffer(fx, seed, summary);
        fx.gate.forgetMcpCaller(caller);
        fx.registry.agentRegistry.setRuntime(caller, 'chat');
        fx.binding.bindingManager.updateBinding(caller, receiver, { label: 'Cosmetic label' });
        fx.binding.bindingManager.bind(caller, { targetKind: 'agent', targetId: 'unrelated-fixture', label: 'Unrelated' });
        expect(fx.gate.mcpCallAccess(caller, fx.repository)).toBe('closed');
        queued.release();
        const result = await queued.pending;
        expect(result.isError).not.toBe(true);
        await verifySource(fx, parseHandoff(resultValue(result)), summary);
      }));

      it('ignores cosmetic binding changes during the actual target-project capture await', async () => runFixtureBody(async () => {
        const fx = current(), summary = await prepare(fx), originalSource = fx.source.callerHandoffSource;
        let wired = false;
        vi.spyOn(fx.source, 'callerHandoffSource').mockImplementation(async (...args) => {
          const source = await originalSource(...args);
          if (!wired) {
            const producer = fx.host.producers.values().next().value;
            if (!producer) throw new Error('Missing original producer.');
            const capture: typeof producer.captureTarget = producer.captureTarget.bind(producer);
            vi.spyOn(producer, 'captureTarget').mockImplementation((target) => {
              const pending = capture(target);
              fx.binding.bindingManager.updateBinding(caller, receiver, { label: 'Cosmetic pending target' });
              return pending;
            });
            wired = true;
          }
          return source;
        });
        const record = await offer(fx, summary);
        expect(wired).toBe(true);
        await verifySource(fx, record, summary);
      }));

      it('does not adopt a replacement quick source with the same id and worktree', async () => runFixtureBody(async () => {
        const fx = current(), summary = await prepare(fx), seed = await offer(fx, summary);
        const original = fx.registry.agentRegistry.get(caller);
        if (!original) throw new Error('Missing original caller.');
        const before = await catalog(fx);
        const queued = await queuedOffer(fx, seed, summary);
        fx.registry.agentRegistry.untrack(caller);
        fx.registry.agentRegistry.register(caller, { ...original });
        fx.gate.setMcpCallerQuick(caller, fx.repository);
        queued.release();
        expect((await queued.pending).isError).toBe(true);
        expect(fx.host.store.list()).toEqual([seed]);
        expect(await catalog(fx)).toBe(before);
      }));

      it('does not adopt a different registered caller worktree after preparation', async () => runFixtureBody(async () => {
        const fx = current(), summary = await prepare(fx), seed = await offer(fx, summary);
        const original = fx.registry.agentRegistry.get(caller);
        if (!original) throw new Error('Missing original caller.');
        const before = await catalog(fx);
        const queued = await queuedOffer(fx, seed, summary);
        original.cwd = path.join(fixtureDirectory(), 'different-source');
        queued.release();
        expect((await queued.pending).isError).toBe(true);
        expect(fx.host.store.list()).toEqual([seed]);
        expect(await catalog(fx)).toBe(before);
      }));

      it('keeps a durable original source without a live runtime and ignores display name/color changes', async () => runFixtureBody(async () => {
        const fx = current(), config = await configuredSource(fx), summary = await prepare(fx, ['.clubhouse/**']);
        const seed = await offer(fx, summary), queued = await queuedOffer(fx, seed, summary);
        config.row.name = 'Cosmetic source'; config.row.color = 'blue';
        await config.write();
        fx.registry.agentRegistry.untrack(caller);
        fx.gate.forgetMcpCaller(caller);
        queued.release();
        const result = await queued.pending;
        expect(result.isError).not.toBe(true);
        const record = parseHandoff(resultValue(result));
        expect(record.senderName).toBe('Original source');
        await verifySource(fx, record, summary);
      }));

      it('refuses a durable source replacement with only its original createdAt changed', async () => runFixtureBody(async () => {
        const fx = current(), config = await configuredSource(fx), summary = await prepare(fx, ['.clubhouse/**']);
        const seed = await offer(fx, summary), before = await catalog(fx), queued = await queuedOffer(fx, seed, summary);
        config.row.createdAt = '2026-01-01T00:00:01.000Z';
        await config.write();
        queued.release();
        expect((await queued.pending).isError).toBe(true);
        expect(fx.host.store.list()).toEqual([seed]);
        expect(await catalog(fx)).toBe(before);
      }));

      it('rechecks retirement during the actual positive authorization await', async () => runFixtureBody(async () => {
        const fx = current(), summary = await prepare(fx), seed = await offer(fx, summary);
        const permissions = await import('../../src/main/services/clubhouse-mcp/handoff-permissions');
        const approve = permissions.handoffAgreementCallApproved;
        const entered = deferred(), release = deferred();
        fixtureOwner().releases.push(release.resolve);
        vi.spyOn(permissions, 'handoffAgreementCallApproved').mockImplementation(async (...args) => {
          const allowed = await approve(...args);
          expect(allowed).toBe(true);
          entered.resolve();
          await release.promise;
          return allowed;
        });
        const before = await catalog(fx);
        const pending = fx.tools.callTool(caller, 'offer_handoff', offerArgs(summary));
        fixtureOwner().operations.push(pending);
        await entered.promise;
        await fx.setGrant('off');
        await fx.setGrant('allow');
        release.resolve();
        expect((await pending).isError).toBe(true);
        expect(fx.host.store.list()).toEqual([seed]);
        expect(await catalog(fx)).toBe(before);
      }));

      it('uses a synthetic isolated exact-call approval without changing standing Ask grants', async () => runFixtureBody(async () => {
        const fx = current(), summary = await prepare(fx);
        await fx.setGrant('ask');
        expect((await fx.tools.callTool(caller, 'offer_handoff', offerArgs(summary))).isError).toBe(true);
        const request = fx.requests.listGrantRequests()[0];
        fx.requests.takeGrantRequest(request.requestId, true);
        const before = fx.grants.getAgentGrantChanges(caller);
        await verifySource(fx, await offer(fx, summary), summary);
        expect(fx.grants.getAgentGrantChanges(caller)).toEqual(before);
        expect(fx.requests.listGrantRequests()).toEqual([]);
      }));

      it('requires still-valid consumed approval inside the queue, not merely a stable Ask grant', async () => runFixtureBody(async () => {
        const fx = current(), summary = await prepare(fx), seed = await offer(fx, summary);
        await fx.setGrant('ask');
        expect((await fx.tools.callTool(caller, 'offer_handoff', offerArgs(summary))).isError).toBe(true);
        fx.requests.takeGrantRequest(fx.requests.listGrantRequests()[0].requestId, true);
        const before = await catalog(fx);
        const queued = await queuedOffer(fx, seed, summary);
        fx.requests.dropCallApprovalsFor(caller);
        queued.release();
        expect((await queued.pending).isError).toBe(true);
        expect(fx.host.store.list()).toEqual([seed]);
        expect(await catalog(fx)).toBe(before);
      }));

      it('preserves consumed Ask approval when only the general MCP gate forgets the caller', async () => runFixtureBody(async () => {
        const fx = current(), summary = await prepare(fx), seed = await offer(fx, summary);
        await fx.setGrant('ask');
        expect((await fx.tools.callTool(caller, 'offer_handoff', offerArgs(summary))).isError).toBe(true);
        fx.requests.takeGrantRequest(fx.requests.listGrantRequests()[0].requestId, true);
        const queued = await queuedOffer(fx, seed, summary);
        fx.gate.forgetMcpCaller(caller);
        queued.release();
        expect((await queued.pending).isError).not.toBe(true);
        expect(fx.host.store.list()).toHaveLength(2);
      }));

      it('does not borrow consumed Ask approval for a changed exact approval context', async () => runFixtureBody(async () => {
        const fx = current(), summary = await prepare(fx), seed = await offer(fx, summary);
        await fx.setGrant('ask');
        expect((await fx.tools.callTool(caller, 'offer_handoff', offerArgs(summary))).isError).toBe(true);
        fx.requests.takeGrantRequest(fx.requests.listGrantRequests()[0].requestId, true);
        const before = await catalog(fx);
        const queued = await queuedOffer(fx, seed, summary);
        fx.registry.agentRegistry.setRuntime(caller, 'chat');
        queued.release();
        expect((await queued.pending).isError).toBe(true);
        expect(fx.host.store.list()).toEqual([seed]);
        expect(await catalog(fx)).toBe(before);
      }));

      it.each(['dropped Ask approval', 'changed Ask context', 'current Ask', 'fresh Allow with changed approval/context', 'forget-only Ask'] as const)(
        'fences %s during real postpositive source verification', async (change) => runFixtureBody(async () => {
          const fx = current(), summary = await prepare(fx), peer = await remote(fx);
          const mode = change.startsWith('fresh Allow') ? 'allow' : 'ask';
          await ownGrantIO(fixtureOwner(), () => fx.grants.updateAgentGrantChanges(caller, () => ({
            changes: [{ action: 'handoff.offer', target: { kind: 'remote_dispatcher' }, mode }],
          })), fx);
          const args = { ...offerArgs(summary), to: `machine:${peer}` };
          if (mode === 'ask') {
            expect((await fx.tools.callTool(caller, 'offer_handoff', args)).isError).toBe(true);
            fx.requests.takeGrantRequest(fx.requests.listGrantRequests()[0].requestId, true);
          }
          const before = await catalog(fx), grants = fx.grants.getAgentGrantChanges(caller);
          const version = fx.requests.callApprovalVersion(caller);
          const mark = vi.spyOn(fx.host.commands, 'markUndelivered'), post = vi.spyOn(fx.machine.client, 'postToMachine');
          const notice = vi.spyOn(await import('../../src/main/services/dispatcher-federation-policy'), 'publishFederationHandoff');
          const held = await heldPostPositiveSource(fx, args);
          expect(fx.gate.mcpCallAccess(caller, fx.repository)).toBe('open');
          expect(fx.host.store.list()).toEqual([]);
          expect(await catalog(fx)).toBe(before);
          expect(mark).not.toHaveBeenCalled();
          expect(post).not.toHaveBeenCalled();
          expect(notice).not.toHaveBeenCalled();
          if (change === 'dropped Ask approval' || mode === 'allow') {
            fx.requests.dropCallApprovalsFor(caller);
            expect(fx.requests.callApprovalVersion(caller)).toBe(version + 1);
          }
          if (change === 'changed Ask context' || mode === 'allow') fx.registry.agentRegistry.setRuntime(caller, 'chat');
          if (change === 'forget-only Ask') fx.gate.forgetMcpCaller(caller);
          expect(fx.grants.getAgentGrantChanges(caller)).toEqual(grants);
          expect(await fx.source.callerHandoffSource(caller)).toMatchObject({ project: fx.project, worktreeRoot: fx.repository });
          expect(fx.hostApi.handoffHost()).toBe(fx.host);
          held.release();
          const result = await held.pending;
          if (change === 'dropped Ask approval' || change === 'changed Ask context') {
            expect.soft(result.isError).toBe(true);
            expect.soft(fx.host.store.list()).toEqual([]);
            expect.soft(await catalog(fx)).toBe(before);
            expect.soft(mark).not.toHaveBeenCalled();
            expect.soft(post).not.toHaveBeenCalled();
            expect.soft(notice).not.toHaveBeenCalled();
            await expect.soft(fs.access(path.join(fx.userData, 'handoffs.json'))).rejects.toMatchObject({ code: 'ENOENT' });
          } else {
            expect(result.isError).not.toBe(true);
            const record = parseHandoff(resultValue(result));
            await verifySource(fx, record, summary);
            expect(mark).toHaveBeenCalledExactlyOnceWith(record.id);
            expect(post).toHaveBeenCalledTimes(1);
            expect(notice).toHaveBeenCalledExactlyOnceWith(record);
            expect(JSON.parse(await catalog(fx))).toMatchObject({ entries: [{ boundTo: [record.id] }] });
          }
        }),
      );

      it.each([
        ['quick moved', 'ask'], ['quick moved', 'allow'], ['quick current', 'ask'], ['quick current', 'allow'],
        ['durable moved', 'ask'], ['durable moved', 'allow'], ['durable replaced', 'ask'], ['durable replaced', 'allow'],
        ['durable current', 'ask'], ['durable current', 'allow'], ['durable cosmetic', 'ask'], ['durable cosmetic', 'allow'],
        ['durable unrelated', 'ask'], ['durable unrelated', 'allow'],
      ] as const)(
        'keeps original recipient project and identity through postpositive verification: %s / %s', async (change, mode) => runFixtureBody(async () => {
          const fx = current(), projectStore = await import('../../src/main/services/project-store');
          const config = await import('../../src/main/services/agent-config');
          const projectB = path.join(fixtureDirectory(), 'recipient-B'), projectC = path.join(fixtureDirectory(), 'recipient-C');
          await fs.mkdir(projectB); await fs.mkdir(projectC);
          await projectStore.add(projectB); await projectStore.add(projectC);
          const row: DurableAgentConfig = { id: receiver, name: 'Original recipient', color: 'indigo',
            createdAt: '2026-01-01T00:00:00.000Z', worktreePath: projectB };
          const durable = change.startsWith('durable');
          const write = async (project: string, rows: DurableAgentConfig[]) => {
            await fs.mkdir(path.join(project, '.clubhouse'), { recursive: true });
            await fs.writeFile(path.join(project, '.clubhouse', 'agents.json'), JSON.stringify(rows));
            config.clearAgentConfigCache(project);
          };
          const registration = fx.registry.agentRegistry.get(receiver);
          if (!registration) throw new Error('Missing original recipient registration.');
          fx.registry.agentRegistry.register(receiver, { ...registration, projectPath: projectB, cwd: projectB });
          fx.gate.forgetMcpCaller(receiver);
          if (durable) { await write(projectB, [row]); fx.gate.setMcpCaller(receiver, projectB, row); }
          else fx.gate.setMcpCallerQuick(receiver, projectB);
          (await import('../../src/main/services/clubhouse-mcp/orchestration-gate'))
            .setOrchestrationEnabled(caller, true, { crossProject: true });
          await ownGrantIO(fixtureOwner(), () => fx.grants.updateAgentGrantChanges(caller, () => ({
            changes: [{ action: 'handoff.offer', target: { kind: 'project', project: { path: projectB } }, mode }],
          })), fx);
          const summary = await prepare(fx), args = offerArgs(summary);
          if (mode === 'ask') {
            expect((await fx.tools.callTool(caller, 'offer_handoff', args)).isError).toBe(true);
            fx.requests.takeGrantRequest(fx.requests.listGrantRequests()[0].requestId, true);
          }
          const permissions = await import('../../src/main/services/clubhouse-mcp/handoff-permissions');
          const target = await fx.hostApi.resolveHandoffGrantTarget(caller, args);
          expect(target).toMatchObject({ agentId: receiver, projectPath: projectB });
          const context = fx.tools.grantApprovalContext(caller, 'offer_handoff', args, permissions.HANDOFF_OFFER_GRANT,
            new Map([[permissions.HANDOFF_OFFER_GRANT, [target]]]));
          const before = await catalog(fx), grants = fx.grants.getAgentGrantChanges(caller), version = fx.requests.callApprovalVersion(caller);
          const mark = vi.spyOn(fx.host.commands, 'markUndelivered'), post = vi.spyOn(fx.machine.client, 'postToMachine');
          const notice = vi.spyOn(fx.host.commands, 'claimNotice');
          const held = await heldPostPositiveSource(fx, args);
          if (change.endsWith('moved')) {
            if (durable) { await write(projectB, []); row.worktreePath = projectC; await write(projectC, [row]); }
            fx.registry.agentRegistry.register(receiver, { ...registration, projectPath: projectC, cwd: projectC });
            if (durable) fx.gate.setMcpCaller(receiver, projectC, row);
            else fx.gate.setMcpCallerQuick(receiver, projectC);
            const freshTarget = await fx.hostApi.resolveHandoffGrantTarget(caller, args);
            expect(freshTarget).toMatchObject({ agentId: receiver, projectPath: projectC });
            const targets = new Map([[permissions.HANDOFF_OFFER_GRANT, [freshTarget]]]);
            expect((await import('../../src/main/services/clubhouse-mcp/grant-check'))
              .checkToolGrant(caller, permissions.HANDOFF_OFFER_GRANT, args, undefined, targets)).toMatchObject({ ok: false });
            expect(fx.tools.grantApprovalContext(caller, 'offer_handoff', args, permissions.HANDOFF_OFFER_GRANT, targets)).not.toBe(context);
          } else if (change === 'durable replaced') {
            row.createdAt = '2026-01-01T00:00:01.000Z'; await write(projectB, [row]);
          } else if (change === 'durable cosmetic') {
            row.name = 'Cosmetic recipient'; row.color = 'blue'; await write(projectB, [row]);
            fx.binding.bindingManager.bind(caller, { targetKind: 'agent', targetId: receiver, label: 'Cosmetic label' });
          } else if (change === 'durable unrelated') {
            await write(projectC, [{ ...row, id: 'unrelated-recipient', name: 'Unrelated metadata', worktreePath: projectC }]);
          }
          expect(fx.grants.getAgentGrantChanges(caller)).toEqual(grants);
          if (mode === 'allow' && change.endsWith('current')) fx.requests.dropCallApprovalsFor(caller);
          expect(fx.requests.callApprovalVersion(caller)).toBe(version + (mode === 'allow' && change.endsWith('current') ? 1 : 0));
          expect(fx.gate.mcpCallAccess(caller, fx.repository)).toBe('open');
          expect(await fx.source.callerHandoffSource(caller)).toMatchObject({ project: fx.project, worktreeRoot: fx.repository });
          expect(fx.hostApi.handoffHost()).toBe(fx.host);
          expect(fx.host.store.list()).toEqual([]);
          expect(await catalog(fx)).toBe(before);
          held.release();
          const result = await held.pending;
          if (change.endsWith('moved') || change === 'durable replaced') {
            expect.soft(result.isError).toBe(true);
            expect.soft(fx.host.store.list()).toEqual([]);
            expect.soft(await catalog(fx)).toBe(before);
            expect.soft(mark).not.toHaveBeenCalled();
            expect.soft(post).not.toHaveBeenCalled();
            expect.soft(notice).not.toHaveBeenCalled();
            await expect.soft(fs.access(path.join(fx.userData, 'handoffs.json'))).rejects.toMatchObject({ code: 'ENOENT' });
          } else {
            expect(result.isError).not.toBe(true);
            const record = parseHandoff(resultValue(result));
            expect(record.to).toEqual({ agentId: receiver, machine: fx.host.machine });
            await verifySource(fx, record, summary);
            expect(JSON.parse(await catalog(fx))).toMatchObject({ entries: [{ boundTo: [record.id] }] });
          }
        }),
      );

      it.each(['pending incompatible', 'pending benign', 'settled benign'] as const)(
        'verifies only the awaited source observation revision: %s', async (change) => runFixtureBody(async () => {
          const fx = current(), configured = await configuredSource(fx), summary = await prepare(fx, ['.clubhouse/**']);
          const config = await import('../../src/main/services/agent-config');
          const listen = config.onAgentConfigChanged, peek = config.peekDurableConfigs;
          const listeners = new Set<Parameters<typeof listen>[0]>();
          vi.spyOn(config, 'onAgentConfigChanged').mockImplementation((listener) => {
            listeners.add(listener);
            const unsubscribe = listen(listener);
            return () => { listeners.delete(listener); unsubscribe(); };
          });
          const before = await catalog(fx);
          const mark = vi.spyOn(fx.host.commands, 'markUndelivered'), post = vi.spyOn(fx.machine.client, 'postToMachine');
          const notice = vi.spyOn(fx.host.commands, 'claimNotice');
          const held = await heldPostPositiveSource(fx, offerArgs(summary), change === 'settled benign');
          const producer = fx.host.producers.values().next().value;
          if (!producer) throw new Error('Missing original source producer.');
          expect(listeners.size).toBe(1);
          const entered = deferred(), release = deferred();
          fixtureOwner().releases.push(release.resolve);
          let scheduled = false, observing = false, pendingObservation = false, released = false, fenceChecks = 0;
          const check: typeof producer.check = producer.check.bind(producer);
          vi.spyOn(producer, 'check').mockImplementation(() => {
            if (pendingObservation && !released) fenceChecks++;
            check();
          });
          vi.spyOn(config, 'peekDurableConfigs').mockImplementation(async (...input) => {
            if (observing) {
              observing = false;
              pendingObservation = true;
              entered.resolve();
              await release.promise;
            }
            const rows = await peek(...input);
            if (change !== 'settled benign' && held.returned() && !scheduled) {
              scheduled = true;
              // The second microtask appends real callback work after verify snapshots its settled promise.
              queueMicrotask(() => queueMicrotask(() => {
                observing = true;
                for (const listener of listeners) listener(fx.repository);
              }));
            }
            return rows;
          });
          if (change === 'settled benign') {
            configured.row.name = 'Cosmetic source'; configured.row.color = 'blue';
            await configured.write();
            for (const listener of listeners) listener(fx.repository);
          }
          held.release();
          if (change !== 'settled benign') await entered.promise;
          const result = await held.pending;
          if (change === 'settled benign') {
            expect(result.isError).not.toBe(true);
            await verifySource(fx, parseHandoff(resultValue(result)), summary);
          } else {
            expect(fenceChecks).toBeGreaterThan(0);
            expect.soft(result.isError).toBe(true);
            expect.soft(fx.host.store.list()).toEqual([]);
            expect.soft(await catalog(fx)).toBe(before);
            expect.soft(mark).not.toHaveBeenCalled();
            expect.soft(post).not.toHaveBeenCalled();
            expect.soft(notice).not.toHaveBeenCalled();
            await expect.soft(fs.access(path.join(fx.userData, 'handoffs.json'))).rejects.toMatchObject({ code: 'ENOENT' });
            if (change === 'pending incompatible') configured.row.createdAt = '2026-01-01T00:00:01.000Z';
            else { configured.row.name = 'Cosmetic source'; configured.row.color = 'blue'; }
            await configured.write();
            released = true; release.resolve();
            await producer.settled;
            if (change === 'pending benign') await verifySource(fx, await offer(fx, summary), summary);
          }
        }),
      );

      it('does not borrow a newly retargeted alias authorization for the frozen recipient', async () => runFixtureBody(async () => {
        const fx = current();
        const config = await import('../../src/main/services/agent-config');
        const configs: DurableAgentConfig[] = [
          { id: receiver, name: 'Receiver', color: 'indigo', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 'producer-other', name: 'Other', color: 'indigo', createdAt: '2026-01-01T00:00:01.000Z' },
        ];
        const configDir = path.join(fx.repository, '.clubhouse');
        await fs.mkdir(configDir);
        await fs.writeFile(path.join(configDir, 'agents.json'), JSON.stringify(configs));
        config.clearAgentConfigCache(fx.repository);
        fx.binding.bindingManager.bind(caller, { targetKind: 'agent', targetId: 'producer-other', label: 'Other' });
        const summary = await prepare(fx, ['.clubhouse/**']);
        const held = await heldSelection(fx, { ...offerArgs(summary), to: 'Receiver' }, true);
        configs[0].name = 'Former receiver'; configs[1].name = 'Receiver';
        await fs.writeFile(path.join(configDir, 'agents.json'), JSON.stringify(configs));
        config.clearAgentConfigCache(fx.repository);
        expect(await fx.hostApi.resolveHandoffTarget('Receiver')).toMatchObject({ agentId: 'producer-other' });
        held.release();
        expect((await held.pending).isError).toBe(true);
        expect(fx.host.store.list()).toEqual([]);
        expect(JSON.parse(await catalog(fx))).toMatchObject({ entries: [{ boundTo: [] }] });
      }));

      it('does not substitute a new same-summary preparation for the captured catalog entry', async () => runFixtureBody(async () => {
        const fx = current(), summary = await prepare(fx);
        const held = await heldSelection(fx, offerArgs(summary), true);
        const selected = held.selected();
        if (!selected) throw new Error('Missing actual captured preparation.');
        expect(await prepare(fx)).toEqual(summary);
        const replacement = JSON.parse(await catalog(fx));
        expect(replacement.entries[0].id).not.toBe(selected.id);
        held.release();
        expect((await held.pending).isError).toBe(true);
        expect(fx.host.store.list()).toEqual([]);
        expect(JSON.parse(await catalog(fx))).toEqual(replacement);
      }));

      it('prepares its own requested mode after an independently running preparation', async () => runFixtureBody(async () => {
        const fx = current();
        await exec('git', ['add', 'fixture.txt'], { cwd: fx.repository });
        await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Clean branch fixture'], { cwd: fx.repository });
        const held = await heldStandalonePreparation(fx, 'branch');
        const pending = fx.tools.callTool(caller, 'offer_handoff', { to: receiver, task: 'Fixture', brief: 'Synthetic fixture', mode: 'worktree' });
        fixtureOwner().operations.push(pending);
        await held.selected;
        held.release();
        const prepared = resultValue(await held.pending);
        console.info('Independent preparation mode witness', JSON.stringify(prepared));
        expect(prepared).toMatchObject({ ready: true });
        const result = await pending;
        expect(result.isError).not.toBe(true);
        const record = parseHandoff(resultValue(result));
        expect(record.mode).toBe('worktree');
        if (!prepared || typeof prepared !== 'object' || !('summary' in prepared)) throw new Error('Missing independent preparation summary.');
        expect(record.manifest).not.toEqual(prepared.summary);
        expect(fx.host.store.get(record.id)).toEqual(record);
        expect(JSON.parse(await catalog(fx))).toMatchObject({ entries: [{ mode: 'worktree', boundTo: [record.id] }] });
      }));

      it('prepares its original captured source after an independently running preparation on another source', async () => runFixtureBody(async () => {
        const fx = current(), second = path.join(fixtureDirectory(), 'second-repository');
        await fs.mkdir(second);
        await initializeRepository(second);
        const project = await (await import('../../src/main/services/project-store')).add(second);
        const held = await heldStandalonePreparation(fx, 'worktree');
        for (const agent of [caller, receiver]) {
          const original = fx.registry.agentRegistry.get(agent);
          if (!original) throw new Error('Missing original fixture registration.');
          fx.registry.agentRegistry.register(agent, { ...original, projectPath: second, cwd: second });
          fx.gate.setMcpCallerQuick(agent, second);
        }
        const pending = fx.tools.callTool(caller, 'offer_handoff', { to: receiver, task: 'Fixture', brief: 'Synthetic fixture', mode: 'worktree' });
        fixtureOwner().operations.push(pending);
        await held.selected;
        expect(fx.preparation.selectPreparedHandoff).toHaveBeenCalledWith(caller, 'worktree', undefined,
          expect.objectContaining({ project: expect.objectContaining({ id: project.id }), worktreeRoot: second }), expect.any(Function));
        held.release();
        expect(resultValue(await held.pending)).toMatchObject({ ready: true });
        const result = await pending;
        expect(result.isError).not.toBe(true);
        const record = parseHandoff(resultValue(result));
        await verifyCapturedPreparedSource(fx, record, project, second);
        expect(JSON.parse(await catalog(fx))).toMatchObject({ entries: [{ project: project.id, mode: 'worktree', boundTo: [record.id] }] });
      }));

      it('owns its await of separately admitted preparation without cancelling that independent read on stop', async () => runFixtureBody(async () => {
        const fx = current(), held = await heldStandalonePreparation(fx, 'worktree');
        const pending = fx.tools.callTool(caller, 'offer_handoff', { to: receiver, task: 'Fixture', brief: 'Synthetic fixture', mode: 'worktree' });
        fixtureOwner().operations.push(pending);
        await held.selected;
        let stopped = false;
        const stopping = fx.hostApi.stopHandoffs().then(() => { stopped = true; });
        fixtureOwner().operations.push(stopping);
        await Promise.resolve();
        expect(stopped).toBe(false);
        expect(fx.host.producers.size).toBe(1);
        expect(() => fx.hostApi.handoffHost()).toThrow();
        held.release();
        expect(resultValue(await held.pending)).toMatchObject({ ready: true });
        expect((await pending).isError).toBe(true);
        await stopping;
        expect(fx.host.producers.size).toBe(0);
        expect(fx.host.store.list()).toEqual([]);
        expect(JSON.parse(await catalog(fx))).toMatchObject({ entries: [{ project: fx.project.id, mode: 'worktree', boundTo: [] }] });
      }));

      it('owns the original host before implicit preparation and refuses stop-time replacement', async () => runFixtureBody(async () => {
        const fx = current();
        const held = await heldSelection(fx, { to: receiver, task: 'Fixture', brief: 'Synthetic fixture', mode: 'worktree' });
        let stopped = false;
        const stopping = fx.hostApi.stopHandoffs().then(() => { stopped = true; });
        fixtureOwner().operations.push(stopping);
        await Promise.resolve();
        expect(stopped).toBe(false);
        expect(() => fx.hostApi.handoffHost()).toThrow();
        held.release();
        expect((await held.pending).isError).toBe(true);
        await stopping;
        expect(fx.host.store.list()).toEqual([]);
        await expect(fs.access(path.join(fx.userData, 'handoff-preparations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        const replacement = fx.hostApi.handoffHost();
        expect(replacement).not.toBe(fx.host);
        await replacement.ready;
      }));

      it.each(['handoff-commands.json', 'handoff-preparations.json', 'handoffs.json'])('finishes admitted %s save truthfully while stop waits actual work', async (filename) => runFixtureBody(async () => {
        const fx = current(), summary = await prepare(fx);
        const peer = filename === 'handoff-commands.json' ? await remote(fx) : undefined;
        const post = vi.spyOn(fx.machine.client, 'postToMachine');
        let marking = false;
        const mark = fx.host.commands.markUndelivered.bind(fx.host.commands);
        vi.spyOn(fx.host.commands, 'markUndelivered').mockImplementation((id) => {
          marking = true;
          return mark(id).finally(() => { marking = false; });
        });
        const held = heldRename(fx, filename, () => filename !== 'handoff-commands.json' || marking);
        const pending = fx.tools.callTool(caller, 'offer_handoff', { ...offerArgs(summary), ...(peer && { to: `machine:${peer}` }) });
        fixtureOwner().operations.push(pending);
        await held.entered;
        let stopped = false;
        const stopping = fx.hostApi.stopHandoffs().then(() => { stopped = true; });
        fixtureOwner().operations.push(stopping);
        await Promise.resolve();
        expect(stopped).toBe(false);
        expect(fx.host.store.list()).toEqual([]);
        expect(() => fx.hostApi.handoffHost()).toThrow();
        held.release();
        const result = await pending;
        expect(result.isError).not.toBe(true);
        const record = parseHandoff(resultValue(result));
        expect(fx.host.store.get(record.id)).toEqual(record);
        expect(JSON.parse(await fs.readFile(path.join(fx.userData, 'handoffs.json'), 'utf8')).records).toEqual([record]);
        expect(JSON.parse(await catalog(fx))).toMatchObject({ entries: [{ boundTo: [record.id] }] });
        if (peer) expect(fx.host.commands.isUndelivered(record.id)).toBe(true);
        expect(post).not.toHaveBeenCalled();
        await stopping;
      }));

      it('holds a dispatched POST beyond its deadline until the actual promise releases', async () => runFixtureBody(async () => {
        const fx = current(), summary = await prepare(fx), peer = await remote(fx);
        const entered = deferred();
        let finish!: (value: Awaited<ReturnType<typeof fx.machine.client.postToMachine>>) => void;
        const response = new Promise<Awaited<ReturnType<typeof fx.machine.client.postToMachine>>>((resolve) => { finish = resolve; });
        const post = vi.spyOn(fx.machine.client, 'postToMachine').mockImplementation(async () => { entered.resolve(); return response; });
        vi.useFakeTimers();
        const pending = fx.tools.callTool(caller, 'offer_handoff', { ...offerArgs(summary), to: `machine:${peer}` });
        fixtureOwner().operations.push(pending);
        await entered.promise;
        const record = fx.host.store.list()[0];
        const producer = fx.host.producers.values().next().value;
        if (!producer) throw new Error('Missing dispatched original producer.');
        let producerSettled = false;
        fixtureOwner().operations.push(producer.settled.then(() => { producerSettled = true; }));
        fixtureOwner().releases.push(() => finish({ status: 200, body: record }));
        let stopped = false;
        const stopping = fx.hostApi.stopHandoffs().then(() => { stopped = true; });
        fixtureOwner().operations.push(stopping);
        await vi.advanceTimersByTimeAsync(5_000);
        expect((await pending).isError).not.toBe(true);
        expect(stopped).toBe(false);
        expect(producerSettled).toBe(false);
        expect(fx.host.producers.size).toBe(1);
        expect(() => fx.hostApi.handoffHost()).toThrow();
        finish({ status: 200, body: record });
        await stopping;
        expect(post).toHaveBeenCalledTimes(1);
        expect(fx.host.store.get(record.id)).toEqual(record);
        expect(fx.host.producers.size).toBe(0);
        expect(producerSettled).toBe(true);
      }));

      it.each(['catalog-prewrite', 'history-prewrite', 'history-after-rename'] as const)('retains exact partial ids and distinguishes %s failure without retry or rollback fiction', async (failure) => runFixtureBody(async () => {
        const fx = current(), summary = await prepare(fx);
        const peer = failure === 'catalog-prewrite' ? await remote(fx) : undefined;
        const post = vi.spyOn(fx.machine.client, 'postToMachine');
        const filename = failure === 'catalog-prewrite' ? 'handoff-preparations.json' : 'handoffs.json';
        const rename: typeof nativeFs.promises.rename = nativeFs.promises.rename.bind(nativeFs.promises);
        const error = new Error(`Synthetic ${failure} failure`);
        let faults = 0, id: string | undefined;
        const transact: Fixture['host']['store']['transact'] = fx.host.store.transact.bind(fx.host.store);
        vi.spyOn(fx.host.store, 'transact').mockImplementation((nextId, change) => { id = nextId; return transact(nextId, change); });
        vi.spyOn(nativeFs.promises, 'rename').mockImplementation(async (from, to) => {
          if (to !== path.join(fx.userData, filename)) return rename(from, to);
          faults++;
          if (failure === 'history-after-rename') await rename(from, to);
          throw error;
        });
        const result = await fx.tools.callTool(caller, 'offer_handoff', { ...offerArgs(summary), ...(peer && { to: `machine:${peer}` }) });
        expect(result.isError).toBe(true);
        expect(faults).toBe(1);
        expect(fx.host.store.list()).toEqual([]);
        if (peer) {
          expect(fx.host.commands.isUndelivered(id!)).toBe(true);
          expect(JSON.parse(await fs.readFile(path.join(fx.userData, 'handoff-commands.json'), 'utf8')).undelivered).toEqual([id]);
        }
        expect(post).not.toHaveBeenCalled();
        expect(JSON.parse(await catalog(fx))).toMatchObject({ entries: [{ boundTo: failure === 'catalog-prewrite' ? [] : [id] }] });
        if (failure === 'history-after-rename') {
          const records = JSON.parse(await fs.readFile(path.join(fx.userData, 'handoffs.json'), 'utf8')).records;
          expect(records).toHaveLength(1);
          expect(records[0].id).toBe(id);
          console.info('Admitted ambiguous IO witness', JSON.stringify({ failure, id, memory: [], disk: records, error: error.message }));
        } else await expect(fs.access(path.join(fx.userData, 'handoffs.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        await fx.hostApi.stopHandoffs();
      }));
    });

    it('refuses original sender grant retirement before queued offer admission without adding history or binding', async () => runFixtureBody(async () => {
      const fx = current(), summary = await prepare(fx);
      const seed = await offer(fx, summary);
      const originalCaller = fx.registry.agentRegistry.get(caller);
      const originalSource = await fx.source.callerHandoffSource(caller);
      const before = await catalog(fx);
      const queued = await queuedOffer(fx, seed, summary);
      await fx.setGrant('off');
      expect(fx.registry.agentRegistry.get(caller)).toBe(originalCaller);
      expect(fx.gate.mcpCallAccess(caller, fx.repository)).toBe('open');
      expect(await fx.source.callerHandoffSource(caller)).toEqual(originalSource);
      const { checkToolGrant } = await import('../../src/main/services/clubhouse-mcp/grant-check');
      const { HANDOFF_OFFER_GRANT } = await import('../../src/main/services/clubhouse-mcp/handoff-permissions');
      const target = await fx.hostApi.resolveHandoffGrantTarget(caller, offerArgs(summary));
      expect(checkToolGrant(caller, HANDOFF_OFFER_GRANT, offerArgs(summary), undefined,
        new Map([[HANDOFF_OFFER_GRANT, [target]]]))).toMatchObject({ ok: false, reason: 'no_grant' });
      expect(fx.host.store.list()).toEqual([seed]);
      expect(await catalog(fx)).toBe(before);
      queued.release();
      const result = await queued.pending;
      const after = await catalog(fx);
      console.info('Original sender admission witness', JSON.stringify({
        generalGate: 'open', sourceUnchanged: true, handoffOfferGrant: 'no_grant',
        resultIsError: result.isError === true, beforeHistory: [seed.id], afterHistory: fx.host.store.list().map((record) => record.id),
        beforeCatalog: JSON.parse(before), afterCatalog: JSON.parse(after),
      }));
      expect.soft(result.isError).toBe(true);
      expect.soft(fx.host.store.list()).toEqual([seed]);
      expect.soft(after).toBe(before);
    }));

    it.each(['ask', 'off'] as const)('keeps explicit prepared source but refuses %s offer before handler admission', async (mode) => runFixtureBody(async () => {
      const fx = current(), summary = await prepare(fx);
      const before = await catalog(fx);
      await fx.setGrant(mode);
      const result = await fx.tools.callTool(caller, 'offer_handoff', offerArgs(summary));
      expect(result.isError).toBe(true);
      expect(fx.host.store.list()).toEqual([]);
      expect(await catalog(fx)).toBe(before);
      const requests = fx.requests.listGrantRequests();
      expect(requests).toHaveLength(mode === 'ask' ? 1 : 0);
      if (mode === 'ask') {
        const request = requests[0];
        expect(request).toMatchObject({ agentId: caller, toolName: 'offer_handoff' });
        if (!request.argumentsText) throw new Error('Missing exact Ask-first arguments.');
        expect(JSON.parse(request.argumentsText)).toEqual(offerArgs(summary));
      }
      expect(fx.gate.mcpCallAccess(caller, fx.repository)).toBe('open');
    }));
  });
});
