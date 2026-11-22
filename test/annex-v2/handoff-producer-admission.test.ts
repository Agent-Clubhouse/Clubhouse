import { execFile } from 'child_process';
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

async function setup(dir: string) {
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
  const host = hostApi.handoffHost();
  await host.ready;
  const preparation = await import('../../src/main/services/handoff-preparations');
  const source = await import('../../src/main/services/handoff-preflight-host');
  const requests = await import('../../src/main/services/grant-requests');
  return { userData, repository, project, registry, gate, grants, tools, hostApi, host, preparation, source, requests, setGrant, machine, binding };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
let dir: string;
let fixture: Fixture | undefined;
const releases: Array<() => void> = [];
const operations: Promise<unknown>[] = [];
let retiringFixture = false;
const toolWork: Array<{ tool: string; started: number; state: 'pending' | 'completed' | 'failed' }> = [];

beforeEach(async () => {
  retiringFixture = false;
  toolWork.length = 0;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-producer-admission-'));
  fixture = await setup(dir);
  const callTool = fixture.tools.callTool;
  vi.spyOn(fixture.tools, 'callTool').mockImplementation((...args) => {
    if (args[0] !== caller) return callTool(...args);
    if (retiringFixture) throw new Error('Producer fixture is retiring; no new test calls may start.');
    const trace: (typeof toolWork)[number] = { tool: args[1], started: Date.now(), state: 'pending' };
    toolWork.push(trace);
    const pending = callTool(...args).then((result) => {
      trace.state = 'completed';
      return result;
    }, (error) => {
      trace.state = 'failed';
      throw error;
    });
    operations.push(pending);
    return pending;
  });
});
async function cleanupFixture(): Promise<void> {
  retiringFixture = true;
  try {
    if (process.platform === 'win32') {
      const recent = toolWork.slice(-8);
      if (recent.some((work) => work.state === 'pending')) {
        const now = Date.now();
        console.error('Producer fixture teardown work:', recent.map((work) => ({
          tool: work.tool.slice(0, 80), state: work.state, ageMs: now - work.started,
        })));
      }
    }
  } catch {
    // Optional diagnostics must never strand owned fixture work.
  }
  for (const release of releases.splice(0)) release();
  const failures: unknown[] = [];
  const drained = new Set<Promise<unknown>>();
  while (operations.length) {
    const batch = operations.splice(0).filter((pending) => {
      if (drained.has(pending)) return false;
      drained.add(pending);
      return true;
    });
    for (const outcome of await Promise.allSettled(batch)) {
      if (outcome.status === 'rejected') failures.push(outcome.reason);
    }
  }
  const teardown: Array<() => void | Promise<void>> = [
    async () => { await fixture?.hostApi.stopHandoffs(); },
    () => { fixture?.requests._resetGrantRequestsForTesting(); },
    () => { vi.restoreAllMocks(); },
    () => { vi.useRealTimers(); },
    async () => { (await import('../../src/main/services/agent-config')).clearAgentConfigCache(); },
    () => { fixture = undefined; },
    async () => { await fs.rm(dir, { recursive: true, force: true }); },
  ];
  for (const finish of teardown) {
    try { await finish(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Producer fixture work or teardown failed.');
}
afterEach(cleanupFixture);

function current(): Fixture {
  if (!fixture) throw new Error('Producer fixture is not initialized.');
  return fixture;
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
  releases.push(release.resolve);
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
    operations.push(blocker);
    return actualOffer(input, sender, beforeCommit, admission);
  });
  const pending = fx.tools.callTool(caller, 'offer_handoff', args);
  operations.push(pending);
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
  releases.push(release.resolve);
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
  operations.push(pending);
  await Promise.race([entered.promise, pending.then(() => { throw new Error('Offer settled before postpositive source verification.'); })]);
  expect(positiveCalls).toBe(1);
  return { pending, release: release.resolve, returned: () => returned };
}

describe('isolated real MCP producer domain admission', () => {
  async function heldFixturePreparation(fx: Fixture) {
    const entered = deferred(), release = deferred();
    const source = fx.source.callerHandoffSource;
    vi.spyOn(fx.source, 'callerHandoffSource').mockImplementation(async (...args) => {
      const selected = await source(...args);
      entered.resolve();
      await release.promise;
      return selected;
    });
    const pending = fx.tools.callTool(caller, 'prepare_handoff', { mode: 'worktree' });
    await entered.promise;
    return { pending, release: release.resolve };
  }

  it('drains a real held preparation and completes teardown before reporting its original caller rejection', async () => {
    const fx = current();
    const failure = new Error('Original fixture caller rejection.');
    const grant = fx.tools.listToolGrants().find((tool) => tool.kind === 'global' && tool.name === 'offer_handoff')?.grant;
    if (!grant) throw new Error('Missing actual offer grant declaration.');
    fx.tools.registerGlobalTool('fixture_teardown_rejection', {
      description: 'Isolated fixture rejection control.',
      inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
    }, async () => { throw failure; }, { grant });
    const rejection = await fx.tools.callTool(caller, 'fixture_teardown_rejection', { to: receiver }).then(
      () => { throw new Error('Expected an actual registered caller rejection.'); },
      (error: unknown) => error,
    );
    expect(rejection).toBe(failure);
    const held = await heldFixturePreparation(fx);
    const stop = vi.spyOn(fx.hostApi, 'stopHandoffs');
    const reset = vi.spyOn(fx.requests, '_resetGrantRequestsForTesting');
    let finished = false;
    const cleaning = cleanupFixture().then(
      () => { finished = true; return { ok: true }; },
      (error: unknown) => { finished = true; return { ok: false, error }; },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect.soft(finished).toBe(false);
      expect.soft(nativeFs.existsSync(fx.userData)).toBe(true);
      expect.soft(stop).not.toHaveBeenCalled();
    } finally {
      held.release();
      const prepared = await held.pending;
      const outcome = await cleaning;
      expect.soft(prepared.isError).not.toBe(true);
      expect.soft(outcome).toEqual({ ok: false, error: failure });
      expect.soft(stop).toHaveBeenCalledOnce();
      expect.soft(reset).toHaveBeenCalledOnce();
      expect.soft(nativeFs.existsSync(fx.userData)).toBe(false);
      expect.soft(current).toThrow('Producer fixture is not initialized.');
    }
  });

  it.each(['clock', 'logger'] as const)('completes actual fixture teardown when its Windows %s diagnostic throws', async (port) => {
    const fx = current(), held = await heldFixturePreparation(fx);
    const release = vi.fn(held.release);
    releases.push(release);
    const stop = vi.spyOn(fx.hostApi, 'stopHandoffs');
    const reset = vi.spyOn(fx.requests, '_resetGrantRequestsForTesting');
    const failure = new Error(`Original fixture ${port} diagnostic fault.`);
    let faulted = false;
    const diagnosticFailure = () => { faulted = true; throw failure; };
    const diagnostic = port === 'clock'
      ? vi.spyOn(Date, 'now').mockImplementationOnce(diagnosticFailure)
      : vi.spyOn(console, 'error').mockImplementationOnce(diagnosticFailure);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!platform?.configurable) throw new Error('Cannot isolate the synchronous Windows diagnostic branch.');
    let cleaning: Promise<void>;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      cleaning = cleanupFixture();
    } finally {
      Object.defineProperty(process, 'platform', platform);
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
  });

  it('keeps actual fixture preparation alive until teardown settles it', async () => {
    const fx = current(), entered = deferred(), release = deferred();
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
  });

  it('keeps current sender authority, source bytes and durable binding through a held history queue', async () => {
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
  });

  async function heldSelection(fx: Fixture, args: Record<string, unknown>, afterSelection = false) {
    const entered = deferred(), release = deferred();
    releases.push(release.resolve);
    const select = fx.preparation.selectPreparedHandoff;
    let selected: Awaited<ReturnType<typeof select>> | undefined;
    vi.spyOn(fx.preparation, 'selectPreparedHandoff').mockImplementation(async (...input) => {
      if (afterSelection) selected = await select(...input);
      entered.resolve();
      await release.promise;
      return selected ?? select(...input);
    });
    const pending = fx.tools.callTool(caller, 'offer_handoff', args);
    operations.push(pending);
    await entered.promise;
    return { pending, release: release.resolve, selected: () => selected };
  }

  function heldRename(fx: Fixture, filename: string, eligible = () => true) {
    const entered = deferred(), release = deferred();
    releases.push(release.resolve);
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
    releases.push(release.resolve);
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
    operations.push(pending);
    await entered.promise;
    return { pending, release: release.resolve, selected: selected.promise };
  }

  describe('original producer continuity and admitted persistence', () => {
    it('retains original grant retirement even when Allow is restored before the queue resumes', async () => {
      const fx = current(), summary = await prepare(fx), seed = await offer(fx, summary);
      const before = await catalog(fx);
      const queued = await queuedOffer(fx, seed, summary);
      await fx.setGrant('off');
      await fx.setGrant('allow');
      queued.release();
      expect((await queued.pending).isError).toBe(true);
      expect(fx.host.store.list()).toEqual([seed]);
      expect(await catalog(fx)).toBe(before);
    });

    it('preserves gate-forget-only completion, unrelated bindings and cosmetic runtime metadata', async () => {
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
    });

    it('ignores cosmetic binding changes during the actual target-project capture await', async () => {
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
    });

    it('does not adopt a replacement quick source with the same id and worktree', async () => {
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
    });

    it('does not adopt a different registered caller worktree after preparation', async () => {
      const fx = current(), summary = await prepare(fx), seed = await offer(fx, summary);
      const original = fx.registry.agentRegistry.get(caller);
      if (!original) throw new Error('Missing original caller.');
      const before = await catalog(fx);
      const queued = await queuedOffer(fx, seed, summary);
      original.cwd = path.join(dir, 'different-source');
      queued.release();
      expect((await queued.pending).isError).toBe(true);
      expect(fx.host.store.list()).toEqual([seed]);
      expect(await catalog(fx)).toBe(before);
    });

    it('keeps a durable original source without a live runtime and ignores display name/color changes', async () => {
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
    });

    it('refuses a durable source replacement with only its original createdAt changed', async () => {
      const fx = current(), config = await configuredSource(fx), summary = await prepare(fx, ['.clubhouse/**']);
      const seed = await offer(fx, summary), before = await catalog(fx), queued = await queuedOffer(fx, seed, summary);
      config.row.createdAt = '2026-01-01T00:00:01.000Z';
      await config.write();
      queued.release();
      expect((await queued.pending).isError).toBe(true);
      expect(fx.host.store.list()).toEqual([seed]);
      expect(await catalog(fx)).toBe(before);
    });

    it('rechecks retirement during the actual positive authorization await', async () => {
      const fx = current(), summary = await prepare(fx), seed = await offer(fx, summary);
      const permissions = await import('../../src/main/services/clubhouse-mcp/handoff-permissions');
      const approve = permissions.handoffAgreementCallApproved;
      const entered = deferred(), release = deferred();
      releases.push(release.resolve);
      vi.spyOn(permissions, 'handoffAgreementCallApproved').mockImplementation(async (...args) => {
        const allowed = await approve(...args);
        expect(allowed).toBe(true);
        entered.resolve();
        await release.promise;
        return allowed;
      });
      const before = await catalog(fx);
      const pending = fx.tools.callTool(caller, 'offer_handoff', offerArgs(summary));
      operations.push(pending);
      await entered.promise;
      await fx.setGrant('off');
      await fx.setGrant('allow');
      release.resolve();
      expect((await pending).isError).toBe(true);
      expect(fx.host.store.list()).toEqual([seed]);
      expect(await catalog(fx)).toBe(before);
    });

    it('uses a synthetic isolated exact-call approval without changing standing Ask grants', async () => {
      const fx = current(), summary = await prepare(fx);
      await fx.setGrant('ask');
      expect((await fx.tools.callTool(caller, 'offer_handoff', offerArgs(summary))).isError).toBe(true);
      const request = fx.requests.listGrantRequests()[0];
      fx.requests.takeGrantRequest(request.requestId, true);
      const before = fx.grants.getAgentGrantChanges(caller);
      await verifySource(fx, await offer(fx, summary), summary);
      expect(fx.grants.getAgentGrantChanges(caller)).toEqual(before);
      expect(fx.requests.listGrantRequests()).toEqual([]);
    });

    it('requires still-valid consumed approval inside the queue, not merely a stable Ask grant', async () => {
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
    });

    it('preserves consumed Ask approval when only the general MCP gate forgets the caller', async () => {
      const fx = current(), summary = await prepare(fx), seed = await offer(fx, summary);
      await fx.setGrant('ask');
      expect((await fx.tools.callTool(caller, 'offer_handoff', offerArgs(summary))).isError).toBe(true);
      fx.requests.takeGrantRequest(fx.requests.listGrantRequests()[0].requestId, true);
      const queued = await queuedOffer(fx, seed, summary);
      fx.gate.forgetMcpCaller(caller);
      queued.release();
      expect((await queued.pending).isError).not.toBe(true);
      expect(fx.host.store.list()).toHaveLength(2);
    });

    it('does not borrow consumed Ask approval for a changed exact approval context', async () => {
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
    });

    it.each(['dropped Ask approval', 'changed Ask context', 'current Ask', 'fresh Allow with changed approval/context', 'forget-only Ask'] as const)(
      'fences %s during real postpositive source verification', async (change) => {
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
      },
    );

    it.each([
      ['quick moved', 'ask'], ['quick moved', 'allow'], ['quick current', 'ask'], ['quick current', 'allow'],
      ['durable moved', 'ask'], ['durable moved', 'allow'], ['durable replaced', 'ask'], ['durable replaced', 'allow'],
      ['durable current', 'ask'], ['durable current', 'allow'], ['durable cosmetic', 'ask'], ['durable cosmetic', 'allow'],
      ['durable unrelated', 'ask'], ['durable unrelated', 'allow'],
    ] as const)(
      'keeps original recipient project and identity through postpositive verification: %s / %s', async (change, mode) => {
        const fx = current(), projectStore = await import('../../src/main/services/project-store');
        const config = await import('../../src/main/services/agent-config');
        const projectB = path.join(dir, 'recipient-B'), projectC = path.join(dir, 'recipient-C');
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
      },
    );

    it.each(['pending incompatible', 'pending benign', 'settled benign'] as const)(
      'verifies only the awaited source observation revision: %s', async (change) => {
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
        releases.push(release.resolve);
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
      },
    );

    it('does not borrow a newly retargeted alias authorization for the frozen recipient', async () => {
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
    });

    it('does not substitute a new same-summary preparation for the captured catalog entry', async () => {
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
    });

    it('prepares its own requested mode after an independently running preparation', async () => {
      const fx = current();
      await exec('git', ['add', 'fixture.txt'], { cwd: fx.repository });
      await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Clean branch fixture'], { cwd: fx.repository });
      const held = await heldStandalonePreparation(fx, 'branch');
      const pending = fx.tools.callTool(caller, 'offer_handoff', { to: receiver, task: 'Fixture', brief: 'Synthetic fixture', mode: 'worktree' });
      operations.push(pending);
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
    });

    it('prepares its original captured source after an independently running preparation on another source', async () => {
      const fx = current(), second = path.join(dir, 'second-repository');
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
      operations.push(pending);
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
    });

    it('owns its await of separately admitted preparation without cancelling that independent read on stop', async () => {
      const fx = current(), held = await heldStandalonePreparation(fx, 'worktree');
      const pending = fx.tools.callTool(caller, 'offer_handoff', { to: receiver, task: 'Fixture', brief: 'Synthetic fixture', mode: 'worktree' });
      operations.push(pending);
      await held.selected;
      let stopped = false;
      const stopping = fx.hostApi.stopHandoffs().then(() => { stopped = true; });
      operations.push(stopping);
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
    });

    it('owns the original host before implicit preparation and refuses stop-time replacement', async () => {
      const fx = current();
      const held = await heldSelection(fx, { to: receiver, task: 'Fixture', brief: 'Synthetic fixture', mode: 'worktree' });
      let stopped = false;
      const stopping = fx.hostApi.stopHandoffs().then(() => { stopped = true; });
      operations.push(stopping);
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
    });

    it.each(['handoff-commands.json', 'handoff-preparations.json', 'handoffs.json'])('finishes admitted %s save truthfully while stop waits actual work', async (filename) => {
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
      operations.push(pending);
      await held.entered;
      let stopped = false;
      const stopping = fx.hostApi.stopHandoffs().then(() => { stopped = true; });
      operations.push(stopping);
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
    });

    it('holds a dispatched POST beyond its deadline until the actual promise releases', async () => {
      const fx = current(), summary = await prepare(fx), peer = await remote(fx);
      const entered = deferred();
      let finish!: (value: Awaited<ReturnType<typeof fx.machine.client.postToMachine>>) => void;
      const response = new Promise<Awaited<ReturnType<typeof fx.machine.client.postToMachine>>>((resolve) => { finish = resolve; });
      const post = vi.spyOn(fx.machine.client, 'postToMachine').mockImplementation(async () => { entered.resolve(); return response; });
      vi.useFakeTimers();
      const pending = fx.tools.callTool(caller, 'offer_handoff', { ...offerArgs(summary), to: `machine:${peer}` });
      operations.push(pending);
      await entered.promise;
      const record = fx.host.store.list()[0];
      const producer = fx.host.producers.values().next().value;
      if (!producer) throw new Error('Missing dispatched original producer.');
      let producerSettled = false;
      operations.push(producer.settled.then(() => { producerSettled = true; }));
      releases.push(() => finish({ status: 200, body: record }));
      let stopped = false;
      const stopping = fx.hostApi.stopHandoffs().then(() => { stopped = true; });
      operations.push(stopping);
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
    });

    it.each(['catalog-prewrite', 'history-prewrite', 'history-after-rename'] as const)('retains exact partial ids and distinguishes %s failure without retry or rollback fiction', async (failure) => {
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
    });
  });

  it('refuses original sender grant retirement before queued offer admission without adding history or binding', async () => {
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
  });

  it.each(['ask', 'off'] as const)('keeps explicit prepared source but refuses %s offer before handler admission', async (mode) => {
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
  });
});
