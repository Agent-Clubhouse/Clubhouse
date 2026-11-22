import { execFile } from 'child_process';
import { AsyncLocalStorage } from 'async_hooks';
import { generateKeyPairSync } from 'crypto';
import * as nativeFs from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrantChangeMode } from '../../src/shared/agent-grant-changes';
import { parseHandoffManifest, summarizeHandoffManifest } from '../../src/shared/handoff-manifest';
import { parseHandoff, type Handoff, type HandoffManifestSummary } from '../../src/shared/handoffs';
import type { McpToolResult } from '../../src/main/services/clubhouse-mcp/types';
import type { DurableAgentConfig } from '../../src/shared/types';
import { desktop } from './reverse-desktop-fixture';

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
  return { userData, repository, project, registry, gate, grants, tools, hostApi, host, preparation, source, requests, setGrant, machine, binding };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
type FailureStage = 'setup' | 'work' | 'release' | 'teardown' | 'body';
type Failure = Readonly<{ stage: FailureStage; error: unknown }>;
type Completion = Readonly<{ failures: readonly Failure[] }>;
type CoreCompletion = Completion & Readonly<{ teardown: readonly Completion[]; error?: unknown }>;
type FixtureOwner = {
  directory?: string;
  fixture?: Fixture;
  stop?: () => Promise<void>;
  reset?: () => void;
  retiring: boolean;
  disposed: boolean;
  complete: boolean;
  hookRequested: boolean;
  operations: Promise<unknown>[];
  releases: Array<() => void>;
  holds: Array<() => void>;
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

function observe(owner: FixtureOwner, stage: 'setup' | 'body', callback: () => Promise<void>): Promise<void> {
  const pending = Promise.resolve().then(() => bodyOwner.run(owner, callback));
  owner[stage] = pending.then(
    () => Object.freeze({ failures: Object.freeze([]) }),
    (error: unknown) => Object.freeze({ failures: Object.freeze([Object.freeze({ stage, error })]) }),
  );
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
    if (args[0] !== caller) return callTool(...args);
    if (owner.retiring) throw new Error('Producer fixture is retiring; no new test calls may start.');
    let trace: (typeof owner.toolWork)[number] | undefined;
    fixtureDiagnostic(() => {
      trace = { tool: args[1].slice(0, 80), started: Date.now(), state: 'pending' };
      owner.toolWork.splice(0, Math.max(0, owner.toolWork.length - 7));
      owner.toolWork.push(trace);
    });
    const pending = callTool(...args).then((result) => {
      fixtureDiagnostic(() => { if (trace) trace.state = 'completed'; });
      return result;
    }, (error) => {
      fixtureDiagnostic(() => { if (trace) trace.state = 'failed'; });
      throw error;
    });
    owner.operations.push(pending);
    return pending;
  });
}

function fixtureDiagnostic(observe: () => void): void {
  try { observe(); } catch {
    // Optional metadata must not mask actual caller outcomes or strand owned work.
  }
}

beforeEach(async (context) => {
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
  await observe(owner, 'setup', async () => {
    allocateDirectory(owner, await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-producer-admission-')));
    installFixture(owner, await setup(fixtureDirectory(owner), owner));
  });
});

function releaseOwned(owner: FixtureOwner, callbacks: Array<() => void>): void {
  for (const release of callbacks.splice(0)) {
    if (owner.released.has(release)) continue;
    owner.released.add(release);
    const before = owner.releaseFailures.length;
    try { release(); } catch (error) {
      if (!owner.releaseFailures.slice(before).some((failure) => failure.error === error)) {
        owner.releaseFailures.push(Object.freeze({ stage: 'release', error }));
      }
    }
  }
}

function heldRelease(owner: FixtureOwner, release: () => void): () => void {
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    try { release(); } catch (error) {
      owner.releaseFailures.push(Object.freeze({ stage: 'release', error }));
      throw error;
    }
  };
  owner.holds.push(finish);
  if (owner.hookRequested) releaseOwned(owner, owner.holds);
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
  releaseOwned(owner, owner.releases);
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
    releaseOwned(owner, owner.releases);
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

function coreCompletion(owner: FixtureOwner): Promise<CoreCompletion> {
  if (!owner.core) {
    owner.retiring = true;
    let resolve!: (record: CoreCompletion) => void;
    let reject!: (error: unknown) => void;
    owner.core = new Promise<CoreCompletion>((complete, failed) => { resolve = complete; reject = failed; });
    retireCore(owner).then(resolve, reject);
  }
  return owner.core;
}

async function cleanupFixture(owner = fixtureOwner()): Promise<void> {
  const record = await coreCompletion(owner);
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
    releaseOwned(owner, owner.holds);
    (async () => {
      const core = await coreCompletion(owner);
      const body = await owner.body;
      const all = [...core.failures, ...owner.releaseFailures.filter((failure) => !core.failures.includes(failure)), ...body?.failures ?? []];
      owner.final = Object.freeze({ failures: Object.freeze(all) });
      owner.complete = true;
      if (activeOwner === owner) activeOwner = undefined;
      return Object.freeze({ failures: Object.freeze(all.filter((failure) => !owner.acknowledged.has(failure))) });
    })().then(resolve, reject);
  }
  return owner.hook;
}
afterEach(async (context) => {
  const owner = hookOwners.get(context);
  if (!owner) return;
  const record = await hookCompletion(owner);
  if (record.failures.length) throw failureError(record.failures);
});

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

async function catalog(fx: Fixture) {
  return fs.readFile(path.join(fx.userData, 'handoff-preparations.json'), 'utf8');
}

async function verifySource(fx: Fixture, record: Handoff, summary: HandoffManifestSummary) {
  expect(record.manifest).toEqual(summary);
  expect(fx.host.store.get(record.id)).toEqual(record);
  const prepared = await fx.preparation.preparedSourceForRecord(record);
  expect(prepared.source.project).toEqual(fx.project);
  expect(prepared.source.worktreeRoot).toBe(fx.repository);
  expect(await fs.readFile(path.join(prepared.snapshot.root, 'files', 'fixture.txt'), 'utf8')).toBe(contents);
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
    const finish = heldRelease(fixtureOwner(), release.resolve);
    const source = fx.source.callerHandoffSource;
    vi.spyOn(fx.source, 'callerHandoffSource').mockImplementation(async (...args) => {
      const selected = await source(...args);
      entered.resolve();
      await release.promise;
      return selected;
    });
    const pending = fx.tools.callTool(caller, 'prepare_handoff', { mode: 'worktree' });
    await Promise.race([
      entered.promise,
      pending.then(() => { throw new Error('Preparation settled before its actual source hold.'); }),
    ]);
    return { pending, release: finish };
  }

  it('keeps overlapping cleanup behind the original actual preparation drain', async () => runFixtureBody(async () => {
    const fx = current(), failure = new Error('Original overlap fixture caller rejection.');
    registerExpected(fixtureOwner(), [failure]);
    const grant = fx.tools.listToolGrants().find((tool) => tool.kind === 'global' && tool.name === 'offer_handoff')?.grant;
    if (!grant) throw new Error('Missing actual offer grant declaration.');
    fx.tools.registerGlobalTool('fixture_overlap_rejection', {
      description: 'Isolated actual overlapping teardown rejection control.',
      inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
    }, async () => { throw failure; }, { grant });
    const rejection = await fx.tools.callTool(caller, 'fixture_overlap_rejection', { to: receiver }).then(
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

  async function sentinelOwner(owner = newOwner()) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'producer-owner-control-'));
    allocateDirectory(owner, directory);
    owner.teardown = [
      () => { owner.disposed = true; },
      async () => { await fs.rm(directory, { recursive: true, force: true }); },
    ];
    return owner;
  }

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

  async function remote(fx: Fixture) {
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
        await fx.grants.updateAgentGrantChanges(caller, () => ({
          changes: [{ action: 'handoff.offer', target: { kind: 'remote_dispatcher' }, mode }],
        }));
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
        await fx.grants.updateAgentGrantChanges(caller, () => ({
          changes: [{ action: 'handoff.offer', target: { kind: 'project', project: { path: projectB } }, mode }],
        }));
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
      const record = parseHandoff(resultValue(result)), prepared = await fx.preparation.preparedSourceForRecord(record);
      expect(prepared.source.project).toEqual(project);
      expect(prepared.source.worktreeRoot).toBe(second);
      expect(await fs.readFile(path.join(prepared.snapshot.root, 'files', 'fixture.txt'), 'utf8')).toBe(contents);
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
