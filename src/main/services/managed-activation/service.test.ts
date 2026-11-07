import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseAdoption } from '../../../shared/asset-catalog-types';
const W = vi.hoisted(() => ({ home: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => W.home } }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
import { createAssetCatalogStore, readFrozenActivation } from '../asset-catalog/store';
import { emptyComposition } from '../asset-catalog/planner';
import { withSettingsSurface } from '../settings-audit';
import { establishDeliveryCapability } from './capability';
import { createManagedActivationService, type AdoptionRequest, type ManagedLaunchLease, type ManagedActivationOptions } from './service';
import { pluginNameFor } from './owned-output';
import { recordManagedProcessStart } from './runtime-start';

const adoption: BaseAdoption = { content: { mode: 'takeable' }, structure: { mode: 'accepted' } };
let service: ReturnType<typeof createManagedActivationService>;
let catalog: ReturnType<typeof createAssetCatalogStore>;
let options: ManagedActivationOptions;
let request: AdoptionRequest;
let running: boolean;
let blockId: string;
beforeEach(async () => {
  W.home = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-activation-'));
  const projectPath = path.join(W.home, 'project');
  const workspacePath = path.join(projectPath, '.clubhouse', 'agents', 'agent');
  await fs.mkdir(workspacePath, { recursive: true });
  const binary = path.join(W.home, 'fake-claude'); await fs.writeFile(binary, 'fake CLI fixture, never executes a provider');
  const capability = await establishDeliveryCapability(binary, 'darwin', async (_bin, args) => args[0] === '--version' ? '2.1.316 (Claude Code)\n' : '  --append-system-prompt-file <path>\n  --plugin-dir <path>\n');
  catalog = createAssetCatalogStore({ dir: path.join(W.home, 'catalog') });
  const block = await catalog.createAsset({ kind: 'block', name: 'Identity', owner: { kind: 'agent', agentId: 'agent-1' }, payload: { content: 'Exact @@AgentName.\n日本語' } }); blockId = block.id;
  const skill = await catalog.createAsset({ kind: 'skill', name: 'Review', payload: { skillName: 'review', files: [{ path: 'SKILL.md', content: '---\nname: review\ndescription: Review a change\n---\nKeep @@AgentName literal.' }, { path: 'scripts/tool.sh', content: 'echo example', executable: true }] } });
  const composition = { ...emptyComposition(), entries: [{ localId: 'identity', source: { kind: 'local' as const, blockId } }], additions: [skill.id] };
  const plan = await catalog.plan({ agentId: 'agent-1', adoption, draft: composition });
  await catalog.saveComposition({ agentId: 'agent-1', adoption, composition, expectedRevision: 0, previewFingerprint: plan.fingerprint });
  options = { dir: path.join(W.home, 'private'), catalog, platform: 'darwin' };
  service = createManagedActivationService(options);
  request = { agentId: 'agent-1', expectedRevision: 0, adoption, capability,
    workspace: { projectPath, workspacePath, agentName: 'agent', provider: 'claude-code', otherWorkspaces: [] } };
  running = false;
});
afterEach(async () => { await fs.rm(W.home, { recursive: true, force: true }); });
async function adopt() {
  const preview = await service.preview(request);
  return service.adopt({ ...request, previewToken: preview.token });
}
const launch = (run: (lease: ManagedLaunchLease) => Promise<void>) => service.launch('agent-1', async () => request.workspace, () => running, async (lease) => { expect(lease).not.toBeNull(); await run(lease!); });

describe('explicit managed snapshots and private generation receipts', () => {
  it('previews namespace and ambient context before adoption, saves only app state, then stages exact bytes', async () => {
    const preview = await service.preview(request);
    expect(preview).toMatchObject({ instructionLabel: 'Appended managed instructions', ambientContext: expect.stringContaining('additional context'), instructions: 'Exact @@AgentName.\n日本語', skillNames: [`${pluginNameFor('agent-1')}:review`] });
    const state = await service.adopt({ ...request, previewToken: preview.token });
    expect(await fs.readdir(request.workspace.workspacePath)).toEqual([]);
    expect(state.materialized).toBeNull(); expect(state.generations[state.desired!].runs).toEqual([]);
    await launch(async (lease) => {
      expect(await fs.readFile(lease.instructionFile, 'utf8')).toBe(preview.instructions);
      expect(await fs.readFile(path.join(lease.pluginDir!, 'skills/review/SKILL.md'), 'utf8')).toContain('@@AgentName');
      expect(await fs.readdir(lease.pluginDir!)).toEqual(['.claude-plugin', 'skills']);
      const materialized = (await service.read('agent-1'))!;
      expect(materialized.generations[materialized.desired!].materializedAt).toBeDefined();
      await lease.beforeStart(request.capability.identity.path);
      running = true; await lease.started('pty:1:123'); running = false; await lease.exited();
    });
    const restarted = createManagedActivationService(options);
    const reread = (await restarted.read('agent-1'))!;
    expect(reread.generations[reread.desired!].runs[0]).toMatchObject({ runtimeIdentity: 'pty:1:123', outcome: 'pty_process_created', endedAt: expect.any(String) });
    expect(await fs.readdir(request.workspace.workspacePath)).toEqual([]);
  });
  it('binds explicit adoption to delivery preview and refuses stale catalog or receipt revisions', async () => {
    const preview = await service.preview(request);
    await expect(service.adopt({ ...request, previewToken: 'composition fingerprint is insufficient' })).rejects.toMatchObject({ code: 'activation_stale' });
    const impact = await catalog.previewAssetEdit({ assetId: blockId, payload: { content: 'Changed' } });
    await catalog.saveRevision({ assetId: blockId, expectedRevision: 1, payload: { content: 'Changed' }, impactFingerprint: impact.fingerprint });
    await expect(service.adopt({ ...request, previewToken: preview.token })).rejects.toMatchObject({ code: 'activation_stale' });
    await adopt();
    await expect(service.preview(request)).rejects.toMatchObject({ code: 'activation_stale' });
  });
  it('checks the trusted target guard after durable temp preparation for adoption and unassignment', async () => {
    const delivery = await service.preview(request);
    let prepared = false;
    const check = () => { expect(prepared).toBe(true); throw new Error('target changed'); };
    // Observe the temp preparation through the synchronous guard itself.
    const { readdirSync } = await import('fs');
    const guard = () => { prepared = readdirSync(path.join(options.dir, 'agent-1')).some((file) => file.endsWith('.tmp')); check(); };
    await expect(service.adopt({ ...request, previewToken: delivery.token }, guard)).rejects.toThrow('target changed');
    expect(await service.read('agent-1')).toBeNull();
    const adopted = await adopt();
    await expect(service.unassign('agent-1', adopted.revision, guard)).rejects.toThrow('target changed');
    expect(await service.read('agent-1')).toEqual(adopted);
    expect((await fs.readdir(path.join(options.dir, 'agent-1'))).some((file) => file.endsWith('.tmp'))).toBe(false);
  });
  it('keeps accepted frozen bytes after catalog edits and unassignment retains pins without deleting any edits', async () => {
    const state = await adopt(); const generation = state.generations[state.desired!];
    const impact = await catalog.previewAssetEdit({ assetId: blockId, payload: { content: 'Future' } });
    await catalog.saveRevision({ assetId: blockId, expectedRevision: 1, payload: { content: 'Future' }, impactFingerprint: impact.fingerprint });
    let file = '';
    await launch(async (lease) => { file = lease.instructionFile; expect(await fs.readFile(file, 'utf8')).toBe('Exact @@AgentName.\n日本語'); });
    await fs.chmod(file, 0o600); await fs.writeFile(file, 'intervening private edit');
    const latest = (await service.read('agent-1'))!;
    await service.unassign('agent-1', latest.revision);
    expect(await fs.readFile(file, 'utf8')).toBe('intervening private edit');
    await catalog.removeAgent({ agentId: 'agent-1', expectedRevision: 1 }); await catalog.sweep();
    expect((await readFrozenActivation(catalog, generation.pinId, generation.frozenHash)).instructions).toBe('Exact @@AgentName.\n日本語');
  });
  it('recovers interrupted private staging before any runtime callback and never uses a mixed generation', async () => {
    await adopt(); let count = 0;
    service = createManagedActivationService({ ...options, afterFile: async () => { if (++count === 2) throw new Error('simulated interruption'); } });
    const runtime = vi.fn();
    await expect(launch(runtime)).rejects.toThrow('simulated interruption'); expect(runtime).not.toHaveBeenCalled();
    expect((await service.read('agent-1'))!.pending).toBeDefined();
    service = createManagedActivationService(options);
    await launch(async (lease) => { expect(await fs.readFile(lease.instructionFile, 'utf8')).toBe('Exact @@AgentName.\n日本語'); });
    expect((await service.read('agent-1'))!.pending).toBeUndefined();
  });
  it('detects published edits and foreign paths without touching them or creating a runtime', async () => {
    await adopt(); let file = '';
    await launch(async (lease) => { file = lease.instructionFile; });
    await fs.chmod(file, 0o600); await fs.writeFile(file, 'native edit');
    const runtime = vi.fn(); await expect(launch(runtime)).rejects.toMatchObject({ code: 'activation_output_changed' });
    expect(runtime).not.toHaveBeenCalled(); expect(await fs.readFile(file, 'utf8')).toBe('native edit');
  });
  it('rejects a private staging parent swap observed before writing; repo aliases and edits cannot redirect staging', async () => {
    await adopt(); const outside = path.join(W.home, 'outside'); await fs.mkdir(outside);
    const repoFile = path.join(request.workspace.workspacePath, 'CLAUDE.md'); await fs.symlink(path.join(outside, 'native'), repoFile);
    let swapped = false;
    service = createManagedActivationService({ ...options, beforeWrite: async (root) => {
      if (swapped) return; swapped = true; await fs.rename(root, `${root}.owned`); await fs.symlink(outside, root);
    } });
    await expect(launch(vi.fn())).rejects.toMatchObject({ code: 'activation_foreign_output' });
    expect(await fs.readdir(outside)).toEqual([]);
    service = createManagedActivationService(options);
    await launch(async (lease) => { expect(lease.instructionFile.startsWith(options.dir)).toBe(true); });
    expect(await fs.readlink(repoFile)).toBe(path.join(outside, 'native'));
  });
  it('blocks aliased/shared workspaces and unsupported provider/platform before any staging', async () => {
    const alias = path.join(W.home, 'alias'); await fs.symlink(request.workspace.workspacePath, alias);
    await expect(service.preview({ ...request, workspace: { ...request.workspace, otherWorkspaces: [alias] } })).rejects.toMatchObject({ code: 'activation_workspace_shared' });
    await expect(service.preview({ ...request, workspace: { ...request.workspace, provider: 'codex-cli' } })).rejects.toMatchObject({ code: 'activation_unsupported' });
    await expect(createManagedActivationService({ ...options, platform: 'linux' }).preview(request)).rejects.toMatchObject({ code: 'activation_capability_stale' });
  });
  it('keeps materialized-but-not-running after spawn failure, and records fast exit as an ended process observation', async () => {
    await adopt();
    await launch(async (lease) => { await lease.beforeStart(request.capability.identity.path); await lease.notCreated(); });
    let latest = (await service.read('agent-1'))!;
    expect(latest.generations[latest.desired!].runs[0]).toMatchObject({ outcome: 'process_not_created', endedAt: expect.any(String) });
    await launch(async (lease) => { await lease.beforeStart(request.capability.identity.path); await lease.exited(); await lease.started('pty:2:124'); });
    latest = (await service.read('agent-1'))!;
    expect(latest.generations[latest.desired!].runs[1]).toMatchObject({ outcome: 'pty_process_created', startedAt: expect.any(String), endedAt: expect.any(String) });
  });
  it('preserves runtime identity after receipt-save failure, times out cleanup honestly and blocks retry until actual exit', async () => {
    await adopt(); let failStarted = true; let captured: ManagedLaunchLease;
    service = createManagedActivationService({ ...options, rename: async (from, to) => {
      const text = await fs.readFile(from, 'utf8');
      if (failStarted && text.includes('pty_process_created')) { failStarted = false; throw new Error('disk fault'); }
      await fs.rename(from, to);
    } });
    await expect(launch(async (lease) => {
      captured = lease; await lease.beforeStart(request.capability.identity.path); running = true;
      await recordManagedProcessStart(lease, 'pty:3:125', { requestIfCurrent: () => true, waitForExit: async () => undefined, exitConfirmed: () => false });
    })).rejects.toMatchObject({ code: 'process_started_receipt_failed', runtimeIdentity: 'pty:3:125', cleanupRequested: true, cleanupConfirmed: false });
    const state = (await service.read('agent-1'))!;
    expect(state.generations[state.desired!].runs[0]).toMatchObject({ outcome: 'process_started_receipt_failed', cleanupConfirmed: false, cleanupFailure: 'exit_unconfirmed' });
    running = false; // Even a missing manager record is not proof of exit.
    await expect(launch(vi.fn())).rejects.toMatchObject({ code: 'activation_busy' });
    await captured!.exited();
    await launch(async () => undefined);
  });
  it('refuses agent-surface adoption/unassignment and blocks unresolved persisted start intent after restart', async () => {
    await withSettingsSurface('mcp', 'agent-1', async () => { await expect(adopt()).rejects.toMatchObject({ code: 'activation_not_permitted' }); });
    await adopt();
    await launch(async (lease) => { await lease.beforeStart(request.capability.identity.path); });
    service = createManagedActivationService(options);
    await expect(launch(vi.fn())).rejects.toMatchObject({ code: 'activation_runtime_unreconciled' });
  });
});
