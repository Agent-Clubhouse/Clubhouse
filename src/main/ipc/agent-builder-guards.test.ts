import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import type { BuilderCommand, BuilderResult } from '../../shared/agent-builder-types';
import { registerAgentBuilderHandlers } from './agent-builder-handlers';
import { assetCatalogDir, createAssetCatalogStore, type AssetCatalogStore } from '../services/asset-catalog/store';
import { withAgentTransition, agentTransitionBusy } from '../services/agent-transition';
import { createAgentBuilder } from '../services/asset-catalog/builder';
import { _resetSettingsAuditForTesting } from '../services/settings-audit';

const control = vi.hoisted(() => ({
  root: '', pending: false, registry: 0, config: 0, indexRenames: 0,
  projects: [] as Array<{ id: string; path: string }>,
  agents: [] as Array<{ id: string; parentAgentId?: string; disposedAt?: string; creation?: { state: string } }>,
  afterProjectSnapshot: undefined as undefined | (() => Promise<void>),
  beforeIndexRename: undefined as undefined | (() => Promise<void>),
}));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../services/base-dir', () => ({ getBaseDirPath: () => control.root }));
vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));
vi.mock('../services/project-store', () => ({
  projectRegistryMutationState: () => ({ generation: control.registry, pending: control.pending }),
  peekProjects: async () => {
    const snapshot = structuredClone(control.projects);
    const pause = control.afterProjectSnapshot; control.afterProjectSnapshot = undefined;
    await pause?.();
    return snapshot;
  },
}));
vi.mock('../services/agent-config', () => ({
  agentConfigGeneration: () => control.config,
  peekDurableConfigs: async () => structuredClone(control.agents),
}));
// Observe the real synchronous rename. A refused guard must stop before this call,
// not merely return failed after the index has already changed.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === path.join(control.root, 'asset-catalog', 'catalog.json')) control.indexRenames++;
    actual.renameSync(from, to);
  } };
});
// Pause the existing atomic write after disk sync and before close/rename. The
// production Builder still constructs its own store and guarded rename closure.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (!String(args[0]).startsWith(path.join(control.root, 'asset-catalog', 'catalog.json.tmp.'))) return handle;
    return {
      writeFile: handle.writeFile.bind(handle), close: handle.close.bind(handle),
      sync: async () => { await handle.sync(); await control.beforeIndexRename?.(); },
    };
  } };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
type Gate = { entered: Promise<void>; hold: () => Promise<void>; release: () => void };
const gates: Gate[] = [];
function gate(): Gate {
  const entered = deferred(), released = deferred();
  const value = {
    entered: entered.promise,
    hold: async () => { entered.resolve(); await released.promise; },
    release: () => { released.resolve(); entered.resolve(); },
  };
  gates.push(value); return value;
}
type Observed<T> = { ok: true; value: T } | { ok: false; error: unknown };
const owned: Array<Promise<unknown>> = [];
function observe<T>(promise: Promise<T>): Promise<Observed<T>> {
  const observed = promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  owned.push(observed); return observed;
}
function value<T>(observed: Observed<T>): T {
  if (observed.ok === false) throw observed.error;
  return observed.value;
}
async function reached(pause: ReturnType<typeof gate>, operation: Promise<unknown>) {
  expect(await Promise.race([pause.entered.then(() => true), operation.then(() => false)])).toBe(true);
}
let handlers: Map<string, (...args: unknown[]) => Promise<BuilderResult>>;
let store: AssetCatalogStore;
let projectPath: string;
const read = () => handlers.get(IPC.AGENT.BUILDER_READ)!({}, projectPath, 'agent-1');
const command = (revision: number, action: BuilderCommand) => handlers.get(IPC.AGENT.BUILDER_COMMAND)!({}, projectPath, 'agent-1', revision, action);
function successful(result: BuilderResult) { expect(result.ok).toBe(true); if (result.ok === false) throw new Error(result.code); return result.view; }
const indexBytes = () => fs.readFileSync(path.join(assetCatalogDir(), 'catalog.json'));

beforeEach(async () => {
  control.root = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-production-guards-'));
  projectPath = path.join(control.root, 'registered-project');
  control.projects = [{ id: 'project-1', path: projectPath }]; control.agents = [{ id: 'agent-1' }];
  control.pending = false; control.registry = 0; control.config = 0; control.indexRenames = 0;
  control.afterProjectSnapshot = undefined; control.beforeIndexRename = undefined;
  _resetSettingsAuditForTesting(false);
  handlers = new Map();
  vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => { handlers.set(channel, handler as never); });
  registerAgentBuilderHandlers(); // Intentionally NO injectedStore: exercise production construction/guard closure.
  successful(await read()); // Await and observe startup seeding before arming any gate.
  const preview = successful(await command(0, { type: 'template', templateId: 'builtin-builder-custom', confirm: false }));
  successful(await command(0, { type: 'template', templateId: 'builtin-builder-custom', confirm: true, binding: preview.templateBinding }));
  store = createAssetCatalogStore({ dir: assetCatalogDir() });
});
afterEach(async () => {
  control.beforeIndexRename = undefined; control.afterProjectSnapshot = undefined;
  for (const pause of gates.splice(0)) pause.release();
  await Promise.all(owned.splice(0));
  _resetSettingsAuditForTesting(false);
  fs.rmSync(control.root, { recursive: true, force: true });
});
async function selection() {
  const skill = await store.createAsset({ kind: 'skill', name: 'Complete skill', payload: { skillName: 'complete', files: [{ path: 'SKILL.md', content: 'Complete' }] } });
  const preview = successful(await command(1, { type: 'skill', assetId: skill.id, expectedRevision: 1, confirm: false }));
  return { type: 'skill' as const, assetId: skill.id, expectedRevision: 1, confirm: true, fingerprint: preview.skillFingerprint };
}

it('commits a reviewed skill through the real production guarded rename', async () => {
  const action = await selection(), before = control.indexRenames;
  const saved = successful(await command(1, action));
  expect(control.indexRenames).toBe(before + 1);
  expect(saved.skills?.map((skill) => skill.assetId)).toEqual([action.assetId]);
  expect((await store.read()).compositions['agent-1'].revision).toBe(2);
});
it('refuses a registered path remap between path lookup and ID resolution without a commit', async () => {
  const action = await selection(), before = indexBytes(), renames = control.indexRenames;
  const pause = gate(); control.afterProjectSnapshot = pause.hold;
  const operation = observe(command(1, action));
  try {
    await reached(pause, operation);
    // Keep generation unchanged to prove exact expected-path validation itself.
    control.projects[0].path = path.join(control.root, 'remapped-project');
    pause.release();
    expect(value(await operation)).toEqual({ ok: false, code: 'failed' });
    expect(control.indexRenames).toBe(renames); expect(indexBytes()).toEqual(before);
  } finally { pause.release(); await operation; }
});
it.each(['pending registry', 'registry generation', 'config generation'] as const)('refuses %s changed at the final production commit boundary', async (change) => {
  const action = await selection(), before = indexBytes(), renames = control.indexRenames;
  const pause = gate(); control.beforeIndexRename = pause.hold;
  const operation = observe(command(1, action));
  try {
    await reached(pause, operation);
    if (change === 'pending registry') control.pending = true;
    else if (change === 'registry generation') control.registry++;
    else control.config++;
    control.beforeIndexRename = undefined; pause.release();
    expect(value(await operation)).toEqual({ ok: false, code: 'failed' });
    expect(control.indexRenames).toBe(renames); expect(indexBytes()).toEqual(before);
    expect((await store.read()).compositions['agent-1'].revision).toBe(1);
    expect((await store.read()).compositions['agent-1'].additions).toEqual([]);
  } finally { control.beforeIndexRename = undefined; pause.release(); await operation; }
});
it.each([
  { parentAgentId: 'parent' }, { disposedAt: 'fixture-disposed' },
  { creation: { state: 'creating' } }, { creation: { state: 'failed' } },
])('refuses an unavailable durable target %j before writing', async (invalid) => {
  const action = await selection(), before = indexBytes(), renames = control.indexRenames;
  control.agents = [{ id: 'agent-1', ...invalid }];
  expect(await command(1, action)).toEqual({ ok: false, code: 'failed' });
  expect(control.indexRenames).toBe(renames); expect(indexBytes()).toEqual(before);
});
it('refuses transition contention without a commit and releases the held transition', async () => {
  const action = await selection(), before = indexBytes(), renames = control.indexRenames;
  const pause = gate(); const holder = observe(withAgentTransition('agent-1', pause.hold));
  try {
    await reached(pause, holder);
    expect(agentTransitionBusy('agent-1')).toBe(true);
    expect(await command(1, action)).toEqual({ ok: false, code: 'failed' });
    expect(control.indexRenames).toBe(renames); expect(indexBytes()).toEqual(before);
  } finally { pause.release(); value(await holder); }
  expect(agentTransitionBusy('agent-1')).toBe(false);
});
it.each(['mcp', 'native'] as const)('returns explicit unsupported for stored %s composition without snapshot or mutation', async (kind) => {
  const composition = structuredClone(await createAgentBuilder(store).compositionOf('agent-1'));
  if (kind === 'mcp') {
    const asset = await store.createAsset({ kind: 'mcp', name: 'Unsupported server', payload: { serverKey: 'fixture', transport: 'stdio', command: 'fixture-command' } });
    composition.additions.push(asset.id);
  } else {
    const asset = await store.createAsset({ kind: 'subagent', name: 'Unsupported native', owner: { kind: 'agent', agentId: 'agent-1' },
      payload: { agentName: 'fixture-native', description: 'Fixture', blocks: [{ entryId: 'role', blockId: 'builtin-builder-identity', blockRevision: 1 }], skills: [], mcps: [] } });
    composition.subagents.push({ localId: 'native', source: { kind: 'local', subagentId: asset.id } });
  }
  const adoption = { content: { mode: 'takeable' as const }, structure: { mode: 'accepted' as const } };
  // Fixture arrangement uses the ordinary catalog API, not the unsupported Builder.
  const plan = await store.plan({ agentId: 'agent-1', adoption, draft: composition });
  await store.saveComposition({ agentId: 'agent-1', expectedRevision: 1, composition, adoption, previewFingerprint: plan.fingerprint });
  const before = indexBytes(), renames = control.indexRenames;
  expect(await read()).toEqual({ ok: false, code: 'unsupported' });
  expect(await command(2, { type: 'baseOrder' })).toEqual({ ok: false, code: 'unsupported' });
  expect(control.indexRenames).toBe(renames); expect(indexBytes()).toEqual(before);
});
