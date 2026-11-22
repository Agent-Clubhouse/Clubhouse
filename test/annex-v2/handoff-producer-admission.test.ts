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
  vi.useRealTimers();
  (await import('../../src/main/services/agent-config')).clearAgentConfigCache();
  fixture = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

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
