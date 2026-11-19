import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { constants } from 'node:fs';
import type { DurableAgentConfig } from '../../shared/types';
import type { OrchestratorProvider } from '../orchestrators/types';
import { managedProviderMarker, managedProviderStartGuard, prepareManagedProviderTransition, previewManagedProviderTransition } from './managed-provider-transition';
import { setGrantedSkills } from './managed-agents/delivery';

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>(), open: vi.fn() }));
const state = vi.hoisted(() => ({ catalog: '', revision: 1, text: 'managed instructions', missing: false, runtime: 'terminal' }));
vi.mock('./asset-catalog/store', async (original) => ({ ...await original<typeof import('./asset-catalog/store')>(), assetCatalogDir: () => state.catalog }));
vi.mock('./agent-config', () => ({ peekDurableConfigsChecked: async () => ({ readable: true, agents: [] }) }));
vi.mock('./agent-registry', () => ({ agentRegistry: { getAllRegistrations: () => new Map() } }));
vi.mock('./managed-agents', () => ({ managedAgents: () => ({
  headContent: async (id: string) => state.missing ? null : ({
    entry: { name: id, source: { kind: 'library' }, headRevision: state.revision },
    content: id === 'block' ? { kind: 'block', content: state.text }
      : id === 'skill' ? { kind: 'skill', skillName: 'kept', files: [] }
        : { kind: 'mcp', serverKey: 'clubhouse' }, droppedEnvValues: [],
  }),
}) }));
vi.mock('./chat-runtime-settings', () => ({ resolveRuntimeMode: () => ({ mode: state.runtime }) }));

const provider = (id: string) => ({ id, conventions: { legacyInstructionsFile: id === 'codex-cli' ? 'AGENTS.md' : 'CLAUDE.md', settingsFormat: id === 'codex-cli' ? 'toml' : 'json' }, buildMcpArgs: () => [] }) as unknown as OrchestratorProvider;
let root: string;
let project: string;
let agent: DurableAgentConfig;
const preview = () => previewManagedProviderTransition(project, agent, provider('claude-code'), provider('codex-cli'));
beforeEach(async () => {
  vi.mocked(fs.open).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open);
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-provider-'));
  project = path.join(root, 'project');
  state.catalog = path.join(root, 'catalog'); state.revision = 1; state.missing = false; state.text = 'managed instructions'; state.runtime = 'terminal';
  await fs.mkdir(project); await fs.mkdir(state.catalog);
  const cwd = path.join(project, 'work'); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'CLAUDE.md'), state.text, { mode: 0o640 });
  agent = { id: 'a', name: 'a', color: 'indigo', createdAt: 'now', worktreePath: cwd, orchestrator: 'claude-code',
    sessionHistory: [{ sessionId: 'old', startedAt: 'then', lastActiveAt: 'then', orchestrator: 'claude-code' }], managed: { version: 1, blocks: ['block'], skills: [], mcps: [] } };
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe('managed native preparation', () => {
  it('is read-only at preview, creates private target only, and conditionally rolls back', async () => {
    const original = structuredClone(agent);
    const plan = await preview(); expect(plan.blocked).toBeNull();
    await expect(fs.stat(plan.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const undo = await prepareManagedProviderTransition(plan, async () => {});
    expect(await fs.readFile(plan.targetPath, 'utf8')).toBe(state.text);
    expect((await fs.stat(plan.targetPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(plan.sourcePath)).mode & 0o777).toBe(0o640);
    expect(agent).toEqual(original);
    await undo(); await expect(fs.stat(plan.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps custom source and target content, and binds same-byte file replacements', async () => {
    await fs.writeFile(path.join(agent.worktreePath!, 'AGENTS.md'), 'custom');
    expect(await preview()).toMatchObject({ blocked: 'managed_target_conflict' });
    await fs.unlink(path.join(agent.worktreePath!, 'AGENTS.md'));
    const before = await preview();
    await fs.rename(before.sourcePath, `${before.sourcePath}.kept`);
    await fs.writeFile(before.sourcePath, state.text);
    expect((await preview()).fingerprint).not.toBe(before.fingerprint);
    await fs.writeFile(before.sourcePath, 'custom source');
    expect(await preview()).toMatchObject({ blocked: 'managed_source_conflict' });
  });
  it('refuses stale target creation, authorization revocation and source edits during preparation', async () => {
    const plan = await preview();
    await expect(prepareManagedProviderTransition(plan, async () => { throw new Error('revoked'); })).rejects.toThrow('revoked');
    await expect(fs.stat(plan.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.writeFile(plan.targetPath, 'custom');
    await expect(prepareManagedProviderTransition(plan, async () => {})).rejects.toMatchObject({ code: 'stale_state' });
    expect(await fs.readFile(plan.targetPath, 'utf8')).toBe('custom');
    await fs.unlink(plan.targetPath);
    await expect(prepareManagedProviderTransition(plan, async () => { await fs.writeFile(plan.sourcePath, 'changed'); })).rejects.toMatchObject({ code: 'stale_state' });
    await expect(fs.stat(plan.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('never rolls back a person’s edit or replacement and never overwrites an equivalent target', async () => {
    const plan = await preview();
    const undo = await prepareManagedProviderTransition(plan, async () => {});
    await fs.writeFile(plan.targetPath, 'person edit');
    await expect(undo()).rejects.toMatchObject({ code: 'managed_rollback_conflict' });
    expect(await fs.readFile(plan.targetPath, 'utf8')).toBe('person edit');
    await fs.writeFile(plan.targetPath, state.text);
    const equivalent = await preview();
    const unchanged = await prepareManagedProviderTransition(equivalent, async () => {});
    await unchanged(); expect((await fs.stat(plan.targetPath)).ino).toBe(equivalent.target!.ino);
  });
  it('supports retry after interruption between native preparation and config commit', async () => {
    const original = structuredClone(agent);
    const plan = await preview(); await prepareManagedProviderTransition(plan, async () => {});
    // Simulated crash: no undo and no config commit. A new preview sees equivalent inert bytes.
    const retry = await preview(); expect(retry.blocked).toBeNull(); expect(retry.target).not.toBeNull();
    expect(agent).toEqual(original); expect(retry.fingerprint).not.toBe(plan.fingerprint);
  });
  it('undoes a partial target write and refuses a workspace swap before opening output', async () => {
    const plan = await preview();
    const open = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      if (file === plan.targetPath && typeof flags === 'number' && (flags & constants.O_CREAT)) {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => { await write('partial', 'utf8'); throw new Error('disk full'); });
      }
      return handle;
    });
    await expect(prepareManagedProviderTransition(plan, async () => {})).rejects.toThrow('disk full');
    await expect(fs.stat(plan.targetPath)).rejects.toMatchObject({ code: 'ENOENT' }); vi.mocked(fs.open).mockImplementation(open);
    await expect(prepareManagedProviderTransition(plan, async () => {
      await fs.rename(agent.worktreePath!, `${agent.worktreePath}.old`); await fs.mkdir(agent.worktreePath!);
    })).rejects.toMatchObject({ code: 'stale_state' });
    await expect(fs.stat(plan.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses skills, chat, missing parts, ambient folders and links before any write', async () => {
    agent.managed!.skills = ['skill']; await expect(preview()).rejects.toMatchObject({ code: 'managed_delivery_unsupported' }); agent.managed!.skills = [];
    state.runtime = 'chat'; await expect(preview()).rejects.toMatchObject({ code: 'managed_delivery_unsupported' }); state.runtime = 'terminal';
    state.missing = true; await expect(preview()).rejects.toMatchObject({ code: 'managed_delivery_unsupported' }); state.missing = false;
    await fs.mkdir(path.join(agent.worktreePath!, '.agents', 'skills', 'custom'), { recursive: true });
    await expect(preview()).rejects.toMatchObject({ code: 'managed_delivery_unsupported' });
    await fs.rm(path.join(agent.worktreePath!, '.agents'), { recursive: true });
    await fs.symlink(root, path.join(agent.worktreePath!, '.agents'));
    await expect(preview()).rejects.toMatchObject({ code: 'managed_delivery_unsupported' });
    await fs.unlink(path.join(agent.worktreePath!, '.agents'));
    await fs.symlink(path.join(agent.worktreePath!, 'CLAUDE.md'), path.join(agent.worktreePath!, 'AGENTS.md'));
    await expect(preview()).rejects.toThrow();
  });
});

describe('persisted read-only managed start contract', () => {
  async function ready() {
    await prepareManagedProviderTransition(await preview(), async () => {});
    agent.providerTransition = managedProviderMarker(agent.id, await preview()); agent.orchestrator = 'codex-cli';
    await fs.mkdir(path.join(project, '.clubhouse'), { recursive: true });
    await fs.writeFile(path.join(project, '.clubhouse', 'agents.json'), JSON.stringify([agent]));
    return managedProviderStartGuard(project, agent, provider('codex-cli'), agent.worktreePath!, () => agent);
  }
  it('revalidates a serialized marker and performs zero managed writes at wake', async () => {
    await ready(); agent = JSON.parse(JSON.stringify(agent));
    const before = await fs.readdir(agent.worktreePath!);
    const guard = await managedProviderStartGuard(project, agent, provider('codex-cli'), agent.worktreePath!, () => agent);
    expect(() => guard()).not.toThrow(); expect(await fs.readdir(agent.worktreePath!)).toEqual(before);
    expect(agent.sessionHistory![0].sessionId).toBe('old');
    await expect(fs.stat(path.join(agent.worktreePath!, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('refuses native edits, workspace swaps and setup changes after preparation', async () => {
    const guard = await ready();
    await fs.writeFile(path.join(agent.worktreePath!, 'AGENTS.md'), 'custom');
    expect(guard).toThrow();
    await expect(managedProviderStartGuard(project, agent, provider('codex-cli'), agent.worktreePath!, () => agent)).rejects.toMatchObject({ code: 'managed_transition_stale' });
  });
  it('uses current config and grant-derived skills at the last synchronous boundary', async () => {
    const guard = await ready();
    agent.model = 'someone-selected'; expect(guard).toThrow(); delete agent.model;
    const reset = setGrantedSkills(() => ['builtin-skill-prepare-handoff']);
    try { expect(guard).toThrow(); } finally { reset(); }
    await fs.mkdir(path.join(agent.worktreePath!, '.agents', 'skills', 'custom'), { recursive: true });
    expect(guard).toThrow();
  });
  it('rejects changed catalog payloads and wrapper/default evidence before creation', async () => {
    const guard = await ready();
    await fs.writeFile(path.join(state.catalog, 'catalog.json'), '{}'); expect(guard).toThrow();
    await fs.unlink(path.join(state.catalog, 'catalog.json'));
    await fs.mkdir(path.join(project, '.clubhouse'), { recursive: true });
    await fs.writeFile(path.join(project, '.clubhouse', 'settings.json'), JSON.stringify({ launchWrapper: { command: 'custom' } }));
    expect(guard).toThrow();
    await expect(preview()).rejects.toMatchObject({ code: 'managed_delivery_unsupported' });
  });
  it('sees an external saved-config edit even while the in-memory record is unchanged', async () => {
    const guard = await ready();
    await fs.writeFile(path.join(project, '.clubhouse', 'agents.json'), JSON.stringify([{ ...agent, model: 'external' }]));
    expect(guard).toThrow();
    expect(agent.model).toBeUndefined();
  });
  it('refuses a copied marker for a different agent/provider/path and later composition revisions', async () => {
    await ready(); const history = structuredClone(agent.sessionHistory);
    const copied = { ...agent, id: 'other' };
    await expect(managedProviderStartGuard(project, copied, provider('codex-cli'), agent.worktreePath!, () => copied)).rejects.toMatchObject({ code: 'managed_transition_stale' });
    state.revision++;
    await expect(managedProviderStartGuard(project, agent, provider('codex-cli'), agent.worktreePath!, () => agent)).rejects.toMatchObject({ code: 'managed_transition_stale' });
    expect(agent.sessionHistory).toEqual(history);
  });
});
