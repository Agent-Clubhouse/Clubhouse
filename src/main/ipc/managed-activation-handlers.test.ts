import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { ActivationPreviewRequest, ActivationUiResult } from '../../shared/managed-activation-ui';
const W = vi.hoisted(() => ({ home: '', projects: [] as Array<{ id: string; path: string }>, registry: { generation: 0, pending: false }, generation: 0, agents: [] as Array<Record<string, unknown>> }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => W.home }, ipcMain: { handle: vi.fn() } }));
vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
vi.mock('../services/project-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/project-store')>();
  return { ...actual, peekProjects: async () => W.projects, projectRegistryMutationState: () => {
    const real = actual.projectRegistryMutationState();
    return { generation: real.generation + W.registry.generation, pending: real.pending || W.registry.pending };
  } };
});
vi.mock('../services/agent-config', () => ({ peekDurableConfigs: async () => W.agents, agentConfigGeneration: () => W.generation }));
import { registerManagedActivationHandlers } from './managed-activation-handlers';
import { createAssetCatalogStore } from '../services/asset-catalog/store';
import { emptyComposition } from '../services/asset-catalog/planner';
import { update as updateProject, projectRegistryMutationState } from '../services/project-store';
import { currentSettingsOrigin } from '../services/settings-audit';
import type { ActivationReceipt } from '../services/managed-activation/types';
import type { ManagedMutationGuard } from '../services/managed-activation';
import { ManagedActivationError } from '../services/managed-activation/types';

let handlers: Map<string, (...args: unknown[]) => Promise<ActivationUiResult<unknown>>>;
let store: ReturnType<typeof createAssetCatalogStore>;
let state: ActivationReceipt | null;
let request: ActivationPreviewRequest;
let blockId: string;
let commitInterleave: () => Promise<void>;
const api = {
  readManagedActivation: vi.fn(async () => state),
  previewManagedActivation: vi.fn(), adoptManagedActivation: vi.fn(), unassignManagedActivation: vi.fn(),
};
beforeEach(async () => {
  W.home = await fs.mkdtemp(path.join(os.tmpdir(), 'adoption-ipc-'));
  const projectPath = path.join(W.home, 'project'); const workspace = path.join(projectPath, '.clubhouse/agents/agent');
  await fs.mkdir(workspace, { recursive: true });
  W.projects = [{ id: 'project-1', path: projectPath }]; W.agents = [{ id: 'agent-1', name: 'agent', worktreePath: workspace }];
  handlers = new Map(); state = null; W.generation = 0; W.registry = { generation: 0, pending: false }; commitInterleave = async () => undefined;
  vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => { handlers.set(channel, handler as never); });
  store = createAssetCatalogStore({ dir: path.join(W.home, 'catalog') });
  const block = await store.createAsset({ kind: 'block', name: 'Identity', owner: { kind: 'agent', agentId: 'agent-1' }, payload: { content: 'Literal @@AgentName' } }); blockId = block.id;
  const skill = await store.createAsset({ kind: 'skill', name: 'Review', payload: { skillName: 'review', files: [{ path: 'SKILL.md', content: '# Review' }] } });
  const composition = { ...emptyComposition(), entries: [{ localId: 'identity', source: { kind: 'local' as const, blockId } }], additions: [skill.id] };
  const adoption = { content: { mode: 'takeable' as const }, structure: { mode: 'accepted' as const } };
  const plan = await store.plan({ agentId: 'agent-1', projectId: 'project-1', adoption, draft: composition });
  await store.saveComposition({ agentId: 'agent-1', projectId: 'project-1', adoption, composition, expectedRevision: 0, previewFingerprint: plan.fingerprint });
  request = { target: { projectId: 'project-1', agentId: 'agent-1' }, compositionRevision: 1, receiptRevision: 0, policy: { content: 'hold-preview', structure: 'accepted' } };
  api.previewManagedActivation.mockImplementation(async () => ({ token: 'a'.repeat(64), compositionFingerprint: 'f'.repeat(64), compositionRevision: 1,
    instructions: 'Literal @@AgentName', instructionLabel: 'Appended managed instructions', ambientContext: 'Ambient CLAUDE.md is additional context.', skillNames: ['clubhouse-agent-safe:review'],
    capability: { version: '2.1.316', identity: { path: '/private/binary', sha256: 'binary-secret-hash' } } }));
  api.adoptManagedActivation.mockImplementation(async (_agent: string, _token: string, guard: ManagedMutationGuard) => {
    const commit = await guard.prepare();
    expect(currentSettingsOrigin()).toEqual({ surface: 'ui' });
    const next: ActivationReceipt = { version: 1, agentId: 'agent-1', revision: 1, scope: { projectPath: await fs.realpath(projectPath), workspacePath: await fs.realpath(workspace), workspaceKey: 'private-key', provider: 'claude-code' },
      desired: 'generation-1', materialized: null, generations: { 'generation-1': { id: 'generation-1', pinId: 'activation-pin-private', frozenHash: 'private-frozen-hash', adoption, compositionRevision: 1,
        planFingerprint: 'f'.repeat(64), instructionHash: 'h'.repeat(64), preparedAt: '2026-11-05T00:00:00Z', files: [{ path: 'private/staging', hash: 'private-file-hash', executable: false }], skillRoots: [],
        skillNames: ['clubhouse-agent-safe:review'], capability: { provider: 'claude-code', platform: 'darwin', version: '2.1.316', flags: ['--append-system-prompt-file', '--plugin-dir'], identity: { path: '/private/binary', dev: 1, ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1, sha256: 'binary-secret-hash' } }, runs: [] } } };
    await commitInterleave(); commit(); state = next; return state;
  });
  api.unassignManagedActivation.mockImplementation(async (_agent: string, _revision: number, guard: ManagedMutationGuard) => { const commit = await guard.prepare(); await commitInterleave(); commit(); state!.desired = null; state!.revision++; return state!; });
  registerManagedActivationHandlers(store, api as never);
});
afterEach(async () => { await fs.rm(W.home, { recursive: true, force: true }); });
const invoke = (channel: string, value: unknown) => handlers.get(channel)!({}, value);
const preview = () => invoke(IPC.AGENT.ACTIVATION_PREVIEW, request);

describe('typed local-user activation IPC', () => {
  it('resolves registered target and separates saved composition and receipt revisions', async () => {
    expect(handlers.size).toBe(4);
    expect(await invoke(IPC.AGENT.ACTIVATION_READ, request.target)).toMatchObject({ ok: true, view: { compositionRevision: 1, receiptRevision: 0, desiredGenerationId: null } });
    await expect(invoke(IPC.AGENT.ACTIVATION_PREVIEW, { ...request, compositionRevision: 0 })).resolves.toEqual({ ok: false, code: 'stale' });
    await expect(invoke(IPC.AGENT.ACTIVATION_PREVIEW, { ...request, receiptRevision: 1 })).resolves.toEqual({ ok: false, code: 'stale' });
    expect(api.previewManagedActivation).not.toHaveBeenCalled();
  });
  it('previews explicit Hold from the complete saved catalog selection and returns only safe DTOs', async () => {
    const result = await preview(); expect(result).toMatchObject({ ok: true, view: { compositionRevision: 1, receiptRevision: 0, instructions: 'Literal @@AgentName', skillNames: ['clubhouse-agent-safe:review'], cliVersion: '2.1.316' } });
    const passed = api.previewManagedActivation.mock.calls[0][0];
    expect(passed).toMatchObject({ projectId: 'project-1', agentId: 'agent-1', expectedRevision: 0, adoption: { content: { mode: 'hold' }, structure: { mode: 'accepted' } } });
    expect(Object.values(passed.adoption.content.revisions)).toEqual([1, 1]); expect(passed.adoption.content.revisions[blockId]).toBe(1);
    expect(JSON.stringify(result)).not.toContain('/private/binary'); expect(JSON.stringify(result)).not.toContain('binary-secret-hash');
    expect(JSON.stringify(result)).not.toContain('capability');
    await expect(invoke(IPC.AGENT.ACTIVATION_ADOPT, { ...request, deliveryToken: 'a'.repeat(64) })).resolves.toMatchObject({ ok: true, view: { receiptRevision: 1, desiredGenerationId: 'generation-1' } });
    const read = await invoke(IPC.AGENT.ACTIVATION_READ, request.target);
    expect(JSON.stringify(read)).not.toContain('private/'); expect(JSON.stringify(read)).not.toContain('frozenHash'); expect(JSON.stringify(read)).not.toContain('capability');
    await expect(invoke(IPC.AGENT.ACTIVATION_UNASSIGN, { target: request.target, receiptRevision: 1 })).resolves.toMatchObject({ ok: true, view: { receiptRevision: 2, desiredGenerationId: null, generations: [{ id: 'generation-1' }] } });
  });
  it('passes Takeable only after explicit choice and never uses Builder snapshot adoption implicitly', async () => {
    request.policy = { content: 'takeable', structure: 'latest-if-clean' }; await preview();
    expect(api.previewManagedActivation.mock.calls[0][0].adoption).toEqual({ content: { mode: 'takeable' }, structure: { mode: 'latest-if-clean' } });
  });
  it.each(['project', 'agent', 'helper', 'disposed', 'dispatcher', 'creation'] as const)('refuses unavailable current %s before backend calls', async (kind) => {
    if (kind === 'project') W.projects = [];
    if (kind === 'agent') W.agents = [];
    if (kind === 'helper') W.agents[0].parentAgentId = 'parent';
    if (kind === 'disposed') W.agents[0].disposedAt = 'now';
    if (kind === 'dispatcher') W.agents[0].persona = 'dispatcher';
    if (kind === 'creation') W.agents[0].creation = { state: 'creating' };
    expect(await preview()).toEqual({ ok: false, code: 'target_unavailable' }); expect(api.previewManagedActivation).not.toHaveBeenCalled();
  });
  it('rejects renderer paths/capability/manifests, omitted policy and forged hold maps at validation', () => {
    for (const value of [ { ...request, binary: '/escape' }, { ...request, capability: {} }, { ...request, instructions: 'text' }, { ...request, projectId: 'arbitrary' },
      { ...request, policy: undefined }, { ...request, policy: { content: 'hold', revisions: {}, structure: 'accepted' } }, { ...request, policy: { content: '', structure: '' } },
      { ...request, target: { ...request.target, projectPath: '/escape' } }, { ...request, receiptRevision: Number.MAX_SAFE_INTEGER + 1 } ]) expect(() => invoke(IPC.AGENT.ACTIVATION_PREVIEW, value)).toThrow();
    expect(api.previewManagedActivation).not.toHaveBeenCalled();
  });
  it('binds token to current target/policy/revisions and refuses stale composition at commit', async () => {
    await preview();
    expect(await invoke(IPC.AGENT.ACTIVATION_ADOPT, { ...request, policy: { ...request.policy, content: 'takeable' }, deliveryToken: 'a'.repeat(64) })).toEqual({ ok: false, code: 'stale' });
    const index = await store.read(); const composition = { ...emptyComposition(), entries: index.compositions['agent-1'].entries };
    const adoption = { content: { mode: 'takeable' as const }, structure: { mode: 'accepted' as const } };
    const plan = await store.plan({ agentId: 'agent-1', adoption, draft: composition });
    await store.saveComposition({ agentId: 'agent-1', adoption, composition, expectedRevision: 1, previewFingerprint: plan.fingerprint });
    expect(await invoke(IPC.AGENT.ACTIVATION_ADOPT, { ...request, deliveryToken: 'a'.repeat(64) })).toEqual({ ok: false, code: 'stale' }); expect(api.adoptManagedActivation).not.toHaveBeenCalled();
  });
  it.each(['adopt', 'unassign'] as const)('rechecks removal/remap/disposal after deferred receipt read for %s', async (operation) => {
    for (const change of ['remove', 'remap', 'dispose'] as const) {
      request.receiptRevision = state?.revision ?? 0; await preview();
      if (operation === 'unassign' && !state) await invoke(IPC.AGENT.ACTIVATION_ADOPT, { ...request, deliveryToken: 'a'.repeat(64) });
      const before = JSON.stringify(state); const projects = W.projects; const agents = structuredClone(W.agents);
      let release!: () => void; let entered!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      api.readManagedActivation.mockImplementationOnce(async () => { entered(); await hold; return state; });
      const pending = operation === 'adopt'
        ? invoke(IPC.AGENT.ACTIVATION_ADOPT, { ...request, deliveryToken: 'a'.repeat(64) })
        : invoke(IPC.AGENT.ACTIVATION_UNASSIGN, { target: request.target, receiptRevision: state!.revision });
      await waiting;
      if (change === 'remove') W.projects = [];
      if (change === 'remap') { const other = path.join(W.home, 'other'); await fs.mkdir(other, { recursive: true }); W.projects = [{ id: 'project-1', path: other }]; }
      if (change === 'dispose') W.agents[0].disposedAt = 'now';
      release(); expect(await pending).toEqual({ ok: false, code: 'stale' }); expect(JSON.stringify(state)).toBe(before);
      W.projects = projects; W.agents = agents;
    }
  });
  it.each(['adopt', 'unassign'] as const)('rechecks registration bytes and config generation at actual %s commit', async (operation) => {
    await preview();
    if (operation === 'unassign') await invoke(IPC.AGENT.ACTIVATION_ADOPT, { ...request, deliveryToken: 'a'.repeat(64) });
    const before = JSON.stringify(state);
    for (const change of ['registration', 'config', 'pending'] as const) {
      commitInterleave = async () => {
        if (change === 'pending') W.registry = { generation: W.registry.generation + 1, pending: true };
        else if (change === 'config') W.generation++;
        else { await fs.mkdir(path.join(W.home, '.clubhouse-dev'), { recursive: true }); await fs.writeFile(path.join(W.home, '.clubhouse-dev/projects.json'), 'changed registration'); }
      };
      const result = operation === 'adopt'
        ? await invoke(IPC.AGENT.ACTIVATION_ADOPT, { ...request, deliveryToken: 'a'.repeat(64) })
        : await invoke(IPC.AGENT.ACTIVATION_UNASSIGN, { target: request.target, receiptRevision: state!.revision });
      expect(result).toEqual({ ok: false, code: 'stale' }); expect(JSON.stringify(state)).toBe(before);
    }
  });
  it.each(['adopt', 'unassign'] as const)('blocks %s while an actual registry rename is pending with old registration readable', async (operation) => {
    await preview();
    if (operation === 'unassign') await invoke(IPC.AGENT.ACTIVATION_ADOPT, { ...request, deliveryToken: 'a'.repeat(64) });
    const before = JSON.stringify(state);
    const file = path.join(W.home, '.clubhouse-dev/projects.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const original = JSON.stringify({ version: 1, projects: W.projects.map((project) => ({ ...project, name: 'Project' })) });
    await fs.writeFile(file, original);
    let release!: () => void; let entered!: () => void; let pending!: Promise<unknown>;
    const holding = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => { entered(); await holding; await actual.rename(from, to); });
    commitInterleave = async () => {
      pending = updateProject('project-1', { displayName: 'Updated' }); await waiting;
      expect(projectRegistryMutationState().pending).toBe(true);
      expect(await fs.readFile(file, 'utf8')).toBe(original);
    };
    try {
      const result = operation === 'adopt'
        ? await invoke(IPC.AGENT.ACTIVATION_ADOPT, { ...request, deliveryToken: 'a'.repeat(64) })
        : await invoke(IPC.AGENT.ACTIVATION_UNASSIGN, { target: request.target, receiptRevision: state!.revision });
      expect(result).toEqual({ ok: false, code: 'stale' }); expect(JSON.stringify(state)).toBe(before);
    } finally { release(); await pending; }
    expect(projectRegistryMutationState().pending).toBe(false);
  });
  it('ignores raw private errors and reports visible closed block reasons', async () => {
    api.previewManagedActivation.mockRejectedValueOnce(new ManagedActivationError('activation_incompatible_config'));
    expect(await preview()).toEqual({ ok: false, code: 'incompatible' });
    api.previewManagedActivation.mockRejectedValueOnce(new Error('PRIVATE instructions /secret/path'));
    expect(await preview()).toEqual({ ok: false, code: 'failed' });
  });
});
