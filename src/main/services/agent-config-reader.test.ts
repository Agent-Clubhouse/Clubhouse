import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { DurableAgentConfig } from '../../shared/types';
import type { ManagedPartContent } from '../../shared/managed-agents-types';

vi.mock('fs/promises', async (original) => {
  const real = await original<typeof import('fs/promises')>();
  return { ...real, open: vi.fn(real.open) };
});

const state = vi.hoisted(() => ({ provider: 'claude-code', agents: [] as DurableAgentConfig[], parts: new Map<string, { entry: { name: string; source: { kind: string; projectId?: string }; headRevision: number }; content: ManagedPartContent; droppedEnvValues: string[] }>() }));
vi.mock('./dispatcher/dispatcher-service', () => ({ getDispatcherState: () => ({}) }));
vi.mock('./agent-config', () => ({ peekDurableConfigs: async () => state.agents }));
vi.mock('./project-store', () => ({ peekProjects: async () => [{ id: 'p', path: '/project', name: 'Project' }] }));
vi.mock('./agent-system', () => ({ resolveOrchestrator: async () => ({ id: state.provider, conventions: { configDir: '.github', legacyInstructionsFile: state.provider === 'copilot-cli' ? 'copilot-instructions.md' : 'CLAUDE.md' } }) }));
vi.mock('./managed-agents', () => ({ managedAgents: () => ({ headContent: async (id: string) => state.parts.get(id) ?? null }) }));
import { CONFIG_MAX_BYTES, CONFIG_TEXT_BYTES, readAgentConfig } from './agent-config-reader';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'config-read-')));
  state.parts.clear(); state.provider = 'claude-code';
  state.agents = [{ id: 'target', name: 'Reader', color: '', createdAt: '', worktreePath: root }];
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
const part = (id: string, content: ManagedPartContent, kind = 'user') => state.parts.set(id, { entry: { name: id, source: { kind }, headRevision: 2 }, content, droppedEnvValues: [] });

describe('bounded agent config evidence', () => {
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
