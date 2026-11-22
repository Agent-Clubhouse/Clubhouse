import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrantChangeMode } from '../../src/shared/agent-grant-changes';
import { parseHandoffManifest, summarizeHandoffManifest } from '../../src/shared/handoff-manifest';
import { parseHandoff, type Handoff, type HandoffManifestSummary } from '../../src/shared/handoffs';
import type { McpToolResult } from '../../src/main/services/clubhouse-mcp/types';
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

async function setup(dir: string) {
  const userData = path.join(dir, 'user-data');
  const repository = path.join(dir, 'repository');
  await fs.mkdir(userData);
  await fs.mkdir(repository);
  await exec('git', ['init', '--quiet', '--initial-branch=fixture'], { cwd: repository });
  await fs.writeFile(path.join(repository, 'fixture.txt'), 'original\n');
  await exec('git', ['add', 'fixture.txt'], { cwd: repository });
  await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture'], { cwd: repository });
  await fs.writeFile(path.join(repository, 'fixture.txt'), contents);
  await desktop(userData);
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
  return { userData, repository, project, registry, gate, grants, tools, hostApi, host, preparation, source, requests, setGrant };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
let dir: string;
let fixture: Fixture | undefined;
const releases: Array<() => void> = [];
const operations: Promise<unknown>[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-producer-admission-'));
  fixture = await setup(dir);
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(operations.splice(0));
  await fixture?.hostApi.stopHandoffs();
  fixture?.requests._resetGrantRequestsForTesting();
  vi.restoreAllMocks();
  fixture = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

function current(): Fixture {
  if (!fixture) throw new Error('Producer fixture is not initialized.');
  return fixture;
}

async function prepare(fx: Fixture): Promise<HandoffManifestSummary> {
  const result = await fx.tools.callTool(caller, 'prepare_handoff', { mode: 'worktree' });
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

async function queuedOffer(fx: Fixture, seed: Handoff, summary: HandoffManifestSummary) {
  const entered = deferred(), queued = deferred(), release = deferred();
  releases.push(release.resolve);
  const transact: Fixture['host']['store']['transact'] = fx.host.store.transact.bind(fx.host.store);
  vi.spyOn(fx.host.store, 'transact').mockImplementation((id, change) => {
    if (id !== seed.id) queued.resolve();
    return transact(id, change);
  });
  const actualOffer: Fixture['host']['coordinator']['service']['offer'] = fx.host.coordinator.service.offer.bind(fx.host.coordinator.service);
  // Coordinator pruning precedes this entry. The blocker is an actual older history transaction.
  vi.spyOn(fx.host.coordinator.service, 'offer').mockImplementation((input, sender, beforeCommit) => {
    const blocker = transact(seed.id, async (record) => {
      if (!record) throw new Error('Missing genuine seed history.');
      entered.resolve();
      await release.promise;
      return record;
    });
    operations.push(blocker);
    return actualOffer(input, sender, beforeCommit);
  });
  const pending = fx.tools.callTool(caller, 'offer_handoff', offerArgs(summary));
  operations.push(pending);
  await Promise.all([entered.promise, queued.promise]);
  return { pending, release: release.resolve };
}

describe('isolated real MCP producer domain admission', () => {
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
