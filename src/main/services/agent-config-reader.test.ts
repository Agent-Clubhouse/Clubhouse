import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../shared/types';
import type { ManagedPartContent } from '../../shared/managed-agents-types';
import type { AssetOwner } from '../../shared/asset-catalog-types';

vi.mock('fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>();
  return { ...real, open: vi.fn(real.open) };
});

const state = vi.hoisted(() => ({ provider: 'claude-code', agents: [] as DurableAgentConfig[], dispatcher: {} as { enabled?: boolean; config?: DurableAgentConfig; path?: string; chatAgentId?: string; chatPath?: string }, roles: {} as Record<string, DurableAgentConfig[]>, rolesReadable: true, afterInventory: undefined as (() => void) | undefined, parts: new Map<string, { entry: { name: string; owner?: AssetOwner; source: { kind: string; projectId?: string }; headRevision: number }; content: ManagedPartContent; droppedEnvValues: string[] }>() }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherState: vi.fn(() => state.dispatcher), getDispatcherAgentId: () => state.dispatcher.config?.id ?? null, getDispatcherChatAgentId: () => state.dispatcher.chatAgentId ?? null }));
vi.mock('./dispatcher/dispatcher-paths', () => ({ getDispatcherPath: () => state.dispatcher.path, getDispatcherChatPath: () => state.dispatcher.chatPath }));
vi.mock('./agent-config', () => ({ peekDurableConfigs: async (p: string) => state.roles[p] ?? state.agents,
  peekDurableConfigsChecked: async (p: string) => { const result = { agents: state.roles[p] ?? state.agents, readable: state.rolesReadable }; state.afterInventory?.(); return result; } }));
vi.mock('./project-store', () => ({ peekProjects: async () => [{ id: 'p', path: '/project', name: 'Project' }], peekProjectsChecked: async () => ({ projects: [{ id: 'p', path: '/project', name: 'Project' }], readable: true }) }));
vi.mock('./agent-system', () => ({ resolveOrchestrator: async () => ({ id: state.provider, conventions: { configDir: '.github', legacyInstructionsFile: state.provider === 'copilot-cli' ? 'copilot-instructions.md' : 'CLAUDE.md' } }) }));
vi.mock('./managed-agents', () => ({ managedAgents: () => ({ headContent: async (id: string) => state.parts.get(id) ?? null }) }));
import { getDispatcherState } from './dispatcher/dispatcher-service';
import { CONFIG_MAX_BYTES, CONFIG_TEXT_BYTES, readAgentConfig, readResolvedAgentConfig, resolveAgentConfigTarget } from './agent-config-reader';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'config-read-')));
  vi.mocked(getDispatcherState).mockReset().mockImplementation(() => state.dispatcher as ReturnType<typeof getDispatcherState>);
  state.parts.clear(); state.provider = 'claude-code';
  state.dispatcher = {}; state.roles = {}; state.rolesReadable = true; state.afterInventory = undefined;
  state.agents = [{ id: 'target', name: 'Reader', color: '', createdAt: '', worktreePath: root }];
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
const part = (id: string, content: ManagedPartContent, kind = 'user') => state.parts.set(id, { entry: { name: id, source: { kind }, headRevision: 2 }, content, droppedEnvValues: [] });

describe('bounded agent config evidence', () => {
  it('strict identity resolution avoids full Dispatcher state even when that reader fails', async () => {
    vi.mocked(getDispatcherState).mockImplementationOnce(() => { throw new Error('recovering full state'); });
    expect(await resolveAgentConfigTarget('target', undefined, { strict: true })).toMatchObject({ agent: { id: 'target' } });
    expect(getDispatcherState).not.toHaveBeenCalled();
  });
  it.each([true, false])('resolves exact Dispatcher controller and chat in separate host folders while enabled=%s', async (enabled) => {
    const config = (id: string) => ({ id, name: 'Dispatcher', color: '', createdAt: '' });
    state.dispatcher = { enabled, config: config('controller'), path: '/work', chatAgentId: 'chat', chatPath: '/chat' };
    state.roles = { '/work': [config('controller')], '/chat': [config('chat')] };
    expect(await resolveAgentConfigTarget('chat', undefined, { strict: true })).toMatchObject({ agent: { id: 'chat' }, project: { path: '/chat' } });
    expect(await resolveAgentConfigTarget('controller', undefined, { strict: true })).toMatchObject({ agent: { id: 'controller' }, project: { path: '/work' } });
  });
  it('never resolves a removed or disposed canonical Dispatcher id to an unrelated project record', async () => {
    state.dispatcher = { chatAgentId: 'chat', chatPath: '/chat' };
    state.roles = { '/chat': [] };
    state.agents.push({ id: 'chat', name: 'Unrelated collision', color: '', createdAt: '' });
    await expect(resolveAgentConfigTarget('chat', undefined, { strict: true })).rejects.toThrow('No registered agent');
    state.roles['/chat'] = [{ id: 'chat', name: 'Removed chat', color: '', createdAt: '', disposedAt: '2026-11-19' }];
    await expect(resolveAgentConfigTarget('chat', undefined, { strict: true })).rejects.toThrow('No registered agent');
    state.rolesReadable = false;
    await expect(resolveAgentConfigTarget('chat', undefined, { strict: true })).rejects.toThrow('unreadable');
  });
  it.each(['replacement', undefined])('refuses a role cache changed to %s while its strict inventory is awaited', async (replacement) => {
    state.dispatcher = { chatAgentId: 'chat', chatPath: '/chat' };
    state.roles = { '/chat': [{ id: 'chat', name: 'Chat', color: '', createdAt: '' }] };
    state.afterInventory = () => { state.dispatcher.chatAgentId = replacement; };
    await expect(resolveAgentConfigTarget('chat', undefined, { strict: true })).rejects.toThrow('No registered agent');
  });
  it('does not resolve role ids in a caller-supplied project or promote a project collision after an await', async () => {
    state.dispatcher = { chatAgentId: 'target', chatPath: '/chat' };
    await expect(resolveAgentConfigTarget('target', 'Project', { strict: true })).rejects.toThrow('No registered agent');
    state.dispatcher = {};
    state.afterInventory = () => { state.dispatcher = { chatAgentId: 'target', chatPath: '/chat' }; };
    await expect(resolveAgentConfigTarget('target', undefined, { strict: true })).rejects.toThrow('role identity changed');
  });
  it('does not invent a Dispatcher identity when its cached id is absent', async () => {
    state.roles = { '/chat': [{ id: 'unknown-role', name: 'Chat', color: '', createdAt: '' }] };
    await expect(resolveAgentConfigTarget('unknown-role', undefined, { strict: true })).rejects.toThrow('No registered agent');
    expect(getDispatcherState).not.toHaveBeenCalled();
  });
  it('reads custom instructions without changing files', async () => {
    await fs.writeFile(path.join(root, 'CLAUDE.md'), 'Own instructions');
    expect(await readAgentConfig('target')).toMatchObject({ instructions: { text: 'Own instructions', provenance: 'custom' }, parts: [], evidence: 'instruction_file', providerLoaded: 'not_confirmed' });
    expect(await fs.readdir(root)).toEqual(['CLAUDE.md']);
  });

  it('includes ordered managed text, skill files and built-in/library/custom provenance', async () => {
    state.agents[0].managed = { version: 1, blocks: ['b', 'c'], skills: ['s'], mcps: [] };
    part('b', { kind: 'block', content: 'Hello @@AgentName' }, 'builtin');
    part('c', { kind: 'block', content: 'Custom rules' });
    part('s', { kind: 'skill', skillName: 'review', files: [{ path: 'SKILL.md', content: '# Review' }, { path: 'guide.txt', content: 'Support file' }] }, 'import');
    const result = await readAgentConfig('Reader', 'Project');
    expect(result.instructions.text).toContain('Hello Reader');
    expect(result.instructions.text.indexOf('Hello')).toBeLessThan(result.instructions.text.indexOf('Custom'));
    expect(result.parts.map((p) => (p.provenance as { kind: string }).kind)).toEqual(['built-in', 'custom', 'library']);
    expect(result.parts[2]).toMatchObject({ content: { kind: 'skill', files: [{ content: '# Review' }, { content: 'Support file' }] } });
    expect(result.missing).toContain('builtin-mcp-clubhouse');
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('labels project-owned parts with their owning project', async () => {
    state.agents[0].managed = { version: 1, blocks: ['p'], skills: [], mcps: [] };
    part('p', { kind: 'block', content: 'Project rules' }, 'project');
    state.parts.get('p')!.entry.source.projectId = 'p';
    expect((await readAgentConfig('target')).parts[0]).toMatchObject({ provenance: { kind: 'project', label: 'project-owned', projectId: 'p', source: { kind: 'project', projectId: 'p' } } });
  });

  it('uses project ownership while preserving the separate user origin', async () => {
    state.agents[0].managed = { version: 1, blocks: ['p'], skills: [], mcps: [] };
    part('p', { kind: 'block', content: 'Project rules' });
    state.parts.get('p')!.entry.owner = { kind: 'project', projectId: 'owning-project' };
    expect((await readAgentConfig('target')).parts[0]).toMatchObject({ provenance: { kind: 'project', label: 'project-owned', projectId: 'owning-project', source: { kind: 'user' } } });
  });

  it('bounds UTF-8 text, individual files and the complete serialized response', async () => {
    await fs.writeFile(path.join(root, 'CLAUDE.md'), '😀'.repeat(CONFIG_TEXT_BYTES));
    const plain = await readAgentConfig('target');
    expect(plain.truncated).toBe(true);
    expect(Buffer.byteLength(plain.instructions.text)).toBeLessThanOrEqual(CONFIG_TEXT_BYTES);
    state.agents[0].managed = { version: 1, blocks: ['b'], skills: ['s'], mcps: [] };
    part('b', { kind: 'block', content: 'b'.repeat(CONFIG_TEXT_BYTES * 2) });
    part('s', { kind: 'skill', skillName: 'huge', files: Array.from({ length: 100 }, (_, i) => ({ path: `${i}.txt`, content: 's'.repeat(CONFIG_TEXT_BYTES * 2) })) });
    const managed = await readAgentConfig('target');
    expect(managed.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(managed))).toBeLessThanOrEqual(CONFIG_MAX_BYTES);
    expect(managed.parts[0]).toMatchObject({ contentTruncated: true });
    expect(managed.parts[1]).toMatchObject({ id: 's', content: { omitted: 'response_limit' }, contentTruncated: true });
  });

  it.skipIf(process.platform === 'win32')('refuses instruction links', async () => {
    await fs.writeFile(path.join(root, 'other.md'), 'Outside instructions');
    await fs.symlink(path.join(root, 'other.md'), path.join(root, 'CLAUDE.md'));
    await expect(readAgentConfig('target')).rejects.toThrow('links');
  });

  it('rejects an unknown project even when the id exists globally', async () => {
    await expect(readAgentConfig('target', 'does-not-exist')).rejects.toThrow('registered project');
  });

  it('reports omitted missing references explicitly', async () => {
    state.agents[0].managed = { version: 1, blocks: Array.from({ length: 100 }, (_, i) => `missing-${i}`), skills: [], mcps: [] };
    const result = await readAgentConfig('target');
    // resolveManagedSetup also adds the implicit Clubhouse MCP reference.
    expect(result.missing).toHaveLength(100);
    expect(result.omittedMissing).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('rejects an ancestor swapped for an outside link between lstat and open', async () => {
    state.provider = 'copilot-cli';
    const worktree = path.join(root, 'worktree');
    await fs.mkdir(worktree); state.agents[0].worktreePath = worktree;
    const config = path.join(worktree, '.github');
    const outside = path.join(root, 'outside');
    await fs.mkdir(config); await fs.mkdir(outside);
    await fs.writeFile(path.join(config, 'copilot-instructions.md'), 'Authorized instructions');
    await fs.writeFile(path.join(outside, 'copilot-instructions.md'), 'Outside private instructions');
    const { open } = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    let swapped = false;
    const read = vi.fn();
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (String(args[0]) === path.join(config, 'copilot-instructions.md')) {
        swapped = true;
        await fs.rename(config, path.join(root, '.github-original'));
        await fs.symlink(outside, config, process.platform === 'win32' ? 'junction' : 'dir');
      }
      const file = await open(...args);
      vi.spyOn(file, 'read').mockImplementation(read);
      return file;
    });
    await expect(readAgentConfig('target')).rejects.toThrow('changed');
    expect(swapped).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses non-files and oversized saved setups', async () => {
    await fs.mkdir(path.join(root, 'CLAUDE.md'));
    await expect(readAgentConfig('target')).rejects.toThrow('ordinary file');
    state.agents[0].managed = { version: 1, blocks: Array(101).fill('x'), skills: [], mcps: [] };
    await expect(readAgentConfig('target')).rejects.toThrow('read limit');
  });
});


describe('selected instruction display receipts', () => {
  const selected = () => ({ agent: state.agents[0], project: { id: 'p', name: 'Project', path: root } });
  it('uses the admitted provider path and carries actual file evidence through later writes', async () => {
    const file = path.join(root, 'SELECTED.md'); await fs.writeFile(file, 'Selected instructions\n'); await fs.writeFile(path.join(root, 'CLAUDE.md'), 'PRIVATE_WRONG_PROVIDER');
    const provider = { id: 'codex-cli', conventions: { legacyInstructionsFile: 'SELECTED.md' } } as import('../orchestrators').OrchestratorProvider;
    const receipts: Array<{ current(): boolean }> = []; const result = await readResolvedAgentConfig(selected(), { provider, receipts });
    expect(result.instructions.text).toBe('Selected instructions\n'); expect(receipts).toHaveLength(1); expect(receipts[0].current()).toBe(true);
    await fs.writeFile(file, 'Changed selected instructions\n'); expect.soft(receipts[0].current()).toBe(false);
    expect.soft(await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8')).toBe('PRIVATE_WRONG_PROVIDER');
  });
  it('keeps a verified missing instruction file distinct from a missing root, and invalidates late creation', async () => {
    const provider = { id: 'claude-code', conventions: { legacyInstructionsFile: 'CLAUDE.md' } } as import('../orchestrators').OrchestratorProvider;
    const receipts: Array<{ current(): boolean }> = []; expect((await readResolvedAgentConfig(selected(), { provider, receipts })).instructions.text).toBe('');
    expect(receipts).toHaveLength(1); expect(receipts[0].current()).toBe(true);
    await fs.writeFile(path.join(root, 'CLAUDE.md'), 'Created later'); expect.soft(receipts[0].current()).toBe(false);
    const missing = selected(); missing.agent = { ...missing.agent, worktreePath: path.join(root, 'missing-root') };
    await expect(readResolvedAgentConfig(missing, { provider, receipts: [] })).rejects.toThrow();
  });
  it('invalidates actual selected-file replacement and refuses a linked instruction path', async () => {
    const file = path.join(root, 'CLAUDE.md'); await fs.writeFile(file, 'Selected');
    const provider = { id: 'claude-code', conventions: { legacyInstructionsFile: 'CLAUDE.md' } } as import('../orchestrators').OrchestratorProvider;
    const receipts: Array<{ current(): boolean }> = []; await readResolvedAgentConfig(selected(), { provider, receipts }); expect(receipts[0].current()).toBe(true);
    await fs.rename(file, file + '.saved'); await fs.writeFile(file, 'Selected'); expect.soft(receipts[0].current()).toBe(false);
    await fs.rm(file); await fs.symlink(file + '.saved', file);
    await expect(readResolvedAgentConfig(selected(), { provider, receipts: [] })).rejects.toThrow('instruction_link');
  });
});
