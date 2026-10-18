import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

// In-memory filesystem plus a scriptable git, so the helper cascade (#2224)
// can be exercised against dirty, unpushed and unmerged worktrees.
const files = new Map<string, string>();
const dirs = new Set<string>();

interface FakeRepo { dirty: number; unpushed: number; unmerged: number; remote: boolean }
const repos = new Map<string, FakeRepo>();
const gitCalls: Array<{ args: string[]; cwd: string }> = [];

function gitOutput(args: string[], cwd: string): string {
  const repo = repos.get(cwd);
  const cmd = args.join(' ');
  if (cmd === 'rev-parse --verify main') return 'abc\n';
  if (cmd.startsWith('rev-parse --verify')) throw new Error('unknown revision');
  if (cmd.startsWith('worktree remove')) {
    const wt = args[args.length - 1];
    dirs.delete(wt);
    dirs.delete(path.join(wt, '.git'));
    return '';
  }
  if (cmd.startsWith('branch -D')) return '';
  if (!repo) return '';
  if (cmd === 'status --porcelain') return Array.from({ length: repo.dirty }, (_, i) => ` M file${i}.ts`).join('\n');
  if (cmd === 'remote') return repo.remote ? 'origin\n' : '';
  if (cmd === 'rev-list --count main..HEAD') return `${repo.unmerged}\n`;
  if (cmd === 'rev-list --count HEAD --not --remotes') return `${repo.unpushed}\n`;
  return '';
}

vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, _opts: unknown, cb: (...args: unknown[]) => void) => { cb(null, ''); return {}; }),
  execFile: vi.fn((_f: string, args: string[], opts: { cwd: string }, cb: (...args: unknown[]) => void) => {
    gitCalls.push({ args, cwd: opts.cwd });
    let out: string;
    try {
      out = gitOutput(args, opts.cwd);
    } catch (err) {
      cb(err, '');
      return {};
    }
    cb(null, out);
    return {};
  }),
}));

vi.mock('fs', () => ({
  watch: vi.fn(() => ({ on: vi.fn().mockReturnThis(), close: vi.fn() })),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async (p: string) => {
    const data = files.get(String(p));
    if (data === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return data;
  }),
  writeFile: vi.fn(async (p: string, data: string) => { files.set(String(p), String(data)); }),
  rename: vi.fn(async (src: string, dest: string) => {
    const data = files.get(String(src));
    if (data !== undefined) files.set(String(dest), data);
    files.delete(String(src));
  }),
  stat: vi.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
  copyFile: vi.fn(async () => undefined),
  appendFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async (p: string) => { dirs.delete(String(p)); }),
  readdir: vi.fn(async () => []),
  unlink: vi.fn(async () => undefined),
}));

vi.mock('./fs-utils', () => ({
  pathExists: vi.fn(async (p: string) => files.has(String(p)) || dirs.has(String(p))),
}));

vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./git-service', () => ({ isInsideGitRepo: vi.fn(async () => true) }));
vi.mock('./agent-settings-service', () => ({
  applyAgentDefaults: vi.fn(async () => undefined),
  readProjectAgentDefaults: vi.fn(async () => ({})),
}));
vi.mock('./agent-system', () => ({ resolveOrchestrator: vi.fn() }));
vi.mock('./chat-idle-settings', () => ({ setAgentIdleSleep: vi.fn() }));

import {
  clearAgentConfigCache,
  deleteDurable,
  deleteUnregister,
  disposeHelper,
  flushAllAgentConfigs,
  getDisposeChecks,
  getParentAgent,
  getWorktreeStatus,
  listDurable,
  listHelpers,
  normalizeHelperFields,
  renameDurable,
  resolveHelpersForDelete,
  setParentAgent,
  updateDurableConfig,
} from './agent-config';
import type { DurableAgentConfig } from '../../shared/types';

const PROJECT_PATH = path.resolve('helpers-project');
const CONFIG_PATH = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
const OTHER_PROJECT_PATH = path.resolve('helpers-other-project');
const OTHER_CONFIG_PATH = path.join(OTHER_PROJECT_PATH, '.clubhouse', 'agents.json');
const DISPOSED_AT = '2026-10-18T01:00:00.000Z';

function worktree(name: string): string {
  return path.join(PROJECT_PATH, '.clubhouse', 'agents', name);
}

function agent(id: string, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  return { id, name: id, color: 'blue', createdAt: '2026-10-18T00:00:00.000Z', ...extra };
}

/** An agent with a worktree whose git state is `repo`. */
function withWorktree(id: string, repo: Partial<FakeRepo> = {}, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  const wt = worktree(id);
  dirs.add(wt);
  dirs.add(path.join(wt, '.git'));
  repos.set(wt, { dirty: 0, unpushed: 0, unmerged: 0, remote: true, ...repo });
  return agent(id, { worktreePath: wt, branch: `${id}/standby`, ...extra });
}

function seed(agents: DurableAgentConfig[], configPath = CONFIG_PATH): void {
  files.set(configPath, JSON.stringify(agents, null, 2));
}

function disk(configPath = CONFIG_PATH): DurableAgentConfig[] {
  return JSON.parse(files.get(configPath) ?? '[]') as DurableAgentConfig[];
}

function onDisk(id: string): DurableAgentConfig | undefined {
  return disk().find((a) => a.id === id);
}

function worktreeRemovals(): string[] {
  return gitCalls
    .filter((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')
    .map((c) => c.args[c.args.length - 1]);
}

beforeEach(() => {
  clearAgentConfigCache();
  files.clear();
  dirs.clear();
  repos.clear();
  gitCalls.length = 0;
});

describe('helper fields round-trip', () => {
  it('keeps parentAgentId, disposable and disposedAt across a restart and other writes', async () => {
    seed([
      agent('durable_1_orch'),
      agent('durable_2_help', { parentAgentId: 'durable_1_orch', disposable: true }),
      agent('durable_3_gone', { parentAgentId: 'durable_1_orch', disposable: true, disposedAt: DISPOSED_AT }),
    ]);

    await listDurable(PROJECT_PATH);
    await renameDurable(PROJECT_PATH, 'durable_2_help', 'renamed');
    await updateDurableConfig(PROJECT_PATH, 'durable_2_help', { model: 'opus' });
    await flushAllAgentConfigs();

    clearAgentConfigCache();
    const reloaded = await listDurable(PROJECT_PATH);
    expect(reloaded.find((a) => a.id === 'durable_2_help')).toMatchObject({
      name: 'renamed', model: 'opus', parentAgentId: 'durable_1_orch', disposable: true,
    });
    expect(reloaded.find((a) => a.id === 'durable_3_gone')).toMatchObject({
      parentAgentId: 'durable_1_orch', disposedAt: DISPOSED_AT,
    });
    expect(onDisk('durable_2_help')).toMatchObject({ parentAgentId: 'durable_1_orch', disposable: true });
  });

  it('keeps unknown fields on rows it rewrites', async () => {
    seed([agent('durable_1_a', { futureField: 'kept' } as Partial<DurableAgentConfig>)]);
    await renameDurable(PROJECT_PATH, 'durable_1_a', 'renamed');
    await flushAllAgentConfigs();
    expect(onDisk('durable_1_a')).toMatchObject({ name: 'renamed', futureField: 'kept' });
  });
});

describe('old configs', () => {
  it('loads agents without helper fields unchanged and does not rewrite the file', async () => {
    const old = [agent('durable_1_a', { worktreePath: worktree('a'), branch: 'a/standby' }), agent('durable_2_b')];
    seed(old);
    const before = files.get(CONFIG_PATH);

    const loaded = await listDurable(PROJECT_PATH);
    await flushAllAgentConfigs();

    expect(loaded).toEqual(old);
    for (const a of loaded) {
      expect(a).not.toHaveProperty('parentAgentId');
      expect(a).not.toHaveProperty('disposable');
      expect(a).not.toHaveProperty('disposedAt');
    }
    expect(files.get(CONFIG_PATH)).toBe(before);
    expect(await listHelpers(PROJECT_PATH, 'durable_1_a')).toEqual([]);
    expect(await getParentAgent(PROJECT_PATH, 'durable_1_a')).toBeNull();
  });

  it('repairs self-parenting, cycles, malformed values and live orphans on load', async () => {
    seed([
      agent('durable_1_self', { parentAgentId: 'durable_1_self' }),
      agent('durable_2_x', { parentAgentId: 'durable_3_y' }),
      agent('durable_3_y', { parentAgentId: 'durable_2_x' }),
      agent('durable_4_orphan', { parentAgentId: 'durable_9_missing', disposable: true }),
      agent('durable_5_disposed', { parentAgentId: 'durable_9_missing', disposedAt: DISPOSED_AT }),
      agent('durable_6_bad', { parentAgentId: 42, disposable: 'yes', disposedAt: '' } as unknown as Partial<DurableAgentConfig>),
    ]);

    const loaded = await listDurable(PROJECT_PATH);
    const byId = new Map(loaded.map((a) => [a.id, a]));

    expect(byId.get('durable_1_self')).not.toHaveProperty('parentAgentId');
    // Exactly one link of the two-agent cycle is broken.
    const cycleLinks = [byId.get('durable_2_x')?.parentAgentId, byId.get('durable_3_y')?.parentAgentId].filter(Boolean);
    expect(cycleLinks).toHaveLength(1);
    expect(byId.get('durable_4_orphan')).not.toHaveProperty('parentAgentId');
    expect(byId.get('durable_4_orphan')).not.toHaveProperty('disposable');
    // A disposed helper keeps its link for history.
    expect(byId.get('durable_5_disposed')?.parentAgentId).toBe('durable_9_missing');
    expect(byId.get('durable_6_bad')).toEqual(agent('durable_6_bad'));
    // The repair is persisted.
    expect(disk().find((a) => a.id === 'durable_1_self')).not.toHaveProperty('parentAgentId');
  });

  it('normalizeHelperFields leaves valid links alone', () => {
    const agents = [agent('durable_1_a'), agent('durable_2_b', { parentAgentId: 'durable_1_a', disposable: true })];
    expect(normalizeHelperFields(agents)).toBe(0);
    expect(agents[1]).toMatchObject({ parentAgentId: 'durable_1_a', disposable: true });
  });

  it('moves a helper with its parent when the parent ID is reassigned', async () => {
    seed([agent('durable_1_shared')], OTHER_CONFIG_PATH);
    await listDurable(OTHER_PROJECT_PATH);

    seed([agent('durable_1_shared'), agent('durable_2_help', { parentAgentId: 'durable_1_shared' })]);
    const loaded = await listDurable(PROJECT_PATH);
    const parent = loaded.find((a) => a.name === 'durable_1_shared');
    expect(parent?.id).not.toBe('durable_1_shared');
    expect(loaded.find((a) => a.id === 'durable_2_help')?.parentAgentId).toBe(parent?.id);
  });
});

describe('setParentAgent', () => {
  beforeEach(() => {
    seed([agent('durable_1_a'), agent('durable_2_b'), agent('durable_3_c'), agent('durable_4_d', { disposedAt: DISPOSED_AT })]);
  });

  it('links a helper, lists it and finds its parent', async () => {
    await setParentAgent(PROJECT_PATH, 'durable_2_b', 'durable_1_a', { disposable: true });
    expect((await listHelpers(PROJECT_PATH, 'durable_1_a')).map((a) => a.id)).toEqual(['durable_2_b']);
    expect((await getParentAgent(PROJECT_PATH, 'durable_2_b'))?.id).toBe('durable_1_a');
    expect((await listDurable(PROJECT_PATH)).find((a) => a.id === 'durable_2_b')?.disposable).toBe(true);

    await setParentAgent(PROJECT_PATH, 'durable_2_b', null);
    const released = (await listDurable(PROJECT_PATH)).find((a) => a.id === 'durable_2_b');
    expect(released).not.toHaveProperty('parentAgentId');
    expect(released).not.toHaveProperty('disposable');
  });

  it('rejects self-parenting', async () => {
    await expect(setParentAgent(PROJECT_PATH, 'durable_1_a', 'durable_1_a')).rejects.toThrow(/own parent/);
  });

  it('rejects direct and transitive cycles', async () => {
    await setParentAgent(PROJECT_PATH, 'durable_2_b', 'durable_1_a');
    await setParentAgent(PROJECT_PATH, 'durable_3_c', 'durable_2_b');
    await expect(setParentAgent(PROJECT_PATH, 'durable_1_a', 'durable_2_b')).rejects.toThrow(/cycle/);
    await expect(setParentAgent(PROJECT_PATH, 'durable_1_a', 'durable_3_c')).rejects.toThrow(/cycle/);
    expect((await listDurable(PROJECT_PATH)).find((a) => a.id === 'durable_1_a')).not.toHaveProperty('parentAgentId');
  });

  it('rejects unknown and disposed agents', async () => {
    await expect(setParentAgent(PROJECT_PATH, 'durable_1_a', 'durable_9_missing')).rejects.toThrow(/not found/);
    await expect(setParentAgent(PROJECT_PATH, 'durable_9_missing', 'durable_1_a')).rejects.toThrow(/not found/);
    await expect(setParentAgent(PROJECT_PATH, 'durable_1_a', 'durable_4_d')).rejects.toThrow(/disposed/);
    await expect(setParentAgent(PROJECT_PATH, 'durable_4_d', 'durable_1_a')).rejects.toThrow(/disposed/);
  });

  it('lists every helper below an agent with recursive', async () => {
    await setParentAgent(PROJECT_PATH, 'durable_2_b', 'durable_1_a');
    await setParentAgent(PROJECT_PATH, 'durable_3_c', 'durable_2_b');
    expect((await listHelpers(PROJECT_PATH, 'durable_1_a', { recursive: true })).map((a) => a.id))
      .toEqual(['durable_2_b', 'durable_3_c']);
  });
});

describe('delete cascade', () => {
  function seedFamily(helperRepos: Record<string, Partial<FakeRepo>>): void {
    seed([
      withWorktree('durable_1_orch'),
      ...Object.entries(helperRepos).map(([id, repo]) =>
        withWorktree(id, repo, { parentAgentId: 'durable_1_orch', disposable: true })),
    ]);
  }

  it('reports the dirty, unpushed and unmerged checks for a worktree', async () => {
    seedFamily({ durable_2_h: { dirty: 2, unpushed: 1, unmerged: 3 } });
    expect(await getDisposeChecks(PROJECT_PATH, 'durable_2_h')).toEqual({ dirty: 2, unpushed: 1, unmerged: 3 });
  });

  it('treats unmerged work as unpushed when the worktree has no remote', async () => {
    seedFamily({ durable_2_h: { remote: false, unmerged: 2, unpushed: 0 } });
    expect(await getDisposeChecks(PROJECT_PATH, 'durable_2_h')).toEqual({ dirty: 0, unpushed: 2, unmerged: 2 });
  });

  it('dispose: blocks on a dirty helper and changes nothing', async () => {
    seedFamily({ durable_2_dirty: { dirty: 1 }, durable_3_clean: {} });

    const result = await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose');

    expect(result.ok).toBe(false);
    expect(result.blocked).toEqual([
      { agentId: 'durable_2_dirty', name: 'durable_2_dirty', checks: { dirty: 1, unpushed: 0, unmerged: 0 } },
    ]);
    expect(worktreeRemovals()).toEqual([]);
    const helpers = await listHelpers(PROJECT_PATH, 'durable_1_orch');
    expect(helpers.map((a) => a.id)).toEqual(['durable_2_dirty', 'durable_3_clean']);
    expect(helpers.every((a) => !a.disposedAt && a.worktreePath)).toBe(true);
  });

  it('dispose: blocks on unpushed and unmerged helpers', async () => {
    seedFamily({ durable_2_unpushed: { unpushed: 2, unmerged: 2 }, durable_3_unmerged: { unmerged: 1 } });

    const result = await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose');

    expect(result.ok).toBe(false);
    expect(result.blocked?.map((b) => b.agentId)).toEqual(['durable_2_unpushed', 'durable_3_unmerged']);
    expect(worktreeRemovals()).toEqual([]);
  });

  it('dispose: a dry run reports without changing anything', async () => {
    seedFamily({ durable_2_clean: {} });
    const result = await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose', { dryRun: true });
    expect(result).toMatchObject({ ok: true, helperIds: ['durable_2_clean'] });
    expect(worktreeRemovals()).toEqual([]);
    expect((await listHelpers(PROJECT_PATH, 'durable_1_orch')).map((a) => a.id)).toEqual(['durable_2_clean']);
  });

  it('dispose: removes clean helpers worktrees, helpers of helpers too, and keeps their rows', async () => {
    seed([
      withWorktree('durable_1_orch'),
      withWorktree('durable_2_h', {}, {
        parentAgentId: 'durable_1_orch',
        sessionHistory: [{ sessionId: 's1', startedAt: 'a', lastActiveAt: 'b' }],
      }),
      withWorktree('durable_3_nested', {}, { parentAgentId: 'durable_2_h' }),
    ]);

    const result = await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose');
    await flushAllAgentConfigs();

    expect(result).toMatchObject({ ok: true, helperIds: ['durable_2_h', 'durable_3_nested'] });
    expect(worktreeRemovals()).toEqual([worktree('durable_2_h'), worktree('durable_3_nested')]);
    for (const id of ['durable_2_h', 'durable_3_nested']) {
      const row = onDisk(id);
      expect(row?.disposedAt).toEqual(expect.any(String));
      expect(row).not.toHaveProperty('worktreePath');
    }
    expect(onDisk('durable_2_h')?.sessionHistory).toHaveLength(1);
    expect(onDisk('durable_2_h')?.parentAgentId).toBe('durable_1_orch');

    // The orchestrator delete that follows leaves the disposed rows in place.
    await deleteDurable(PROJECT_PATH, 'durable_1_orch');
    await flushAllAgentConfigs();
    expect(disk().map((a) => a.id)).toEqual(['durable_2_h', 'durable_3_nested']);
  });

  it('keep: releases dirty and unpushed helpers as ordinary agents without touching worktrees', async () => {
    seedFamily({ durable_2_dirty: { dirty: 3 }, durable_3_unpushed: { unpushed: 1, unmerged: 1 } });

    const result = await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'keep');
    await deleteDurable(PROJECT_PATH, 'durable_1_orch');
    await flushAllAgentConfigs();

    expect(result).toMatchObject({ ok: true, helperIds: ['durable_2_dirty', 'durable_3_unpushed'] });
    expect(worktreeRemovals()).toEqual([worktree('durable_1_orch')]);
    for (const id of ['durable_2_dirty', 'durable_3_unpushed']) {
      const row = onDisk(id);
      expect(row?.worktreePath).toBe(worktree(id));
      expect(row).not.toHaveProperty('parentAgentId');
      expect(row).not.toHaveProperty('disposable');
      expect(row).not.toHaveProperty('disposedAt');
    }
  });

  it('keep: a helper keeps its own helpers attached', async () => {
    seed([
      agent('durable_1_orch'),
      agent('durable_2_h', { parentAgentId: 'durable_1_orch' }),
      agent('durable_3_nested', { parentAgentId: 'durable_2_h' }),
    ]);
    await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'keep');
    expect((await listHelpers(PROJECT_PATH, 'durable_2_h')).map((a) => a.id)).toEqual(['durable_3_nested']);
  });

  it('a delete without a choice never leaves a helper pointing at a deleted parent', async () => {
    seed([
      agent('durable_1_orch'),
      agent('durable_2_h', { parentAgentId: 'durable_1_orch', disposable: true }),
      agent('durable_3_gone', { parentAgentId: 'durable_1_orch', disposedAt: DISPOSED_AT }),
      agent('durable_4_orch'),
      agent('durable_5_h', { parentAgentId: 'durable_4_orch' }),
    ]);

    await deleteDurable(PROJECT_PATH, 'durable_1_orch');
    await deleteUnregister(PROJECT_PATH, 'durable_4_orch');
    const agents = await listDurable(PROJECT_PATH);

    expect(agents.find((a) => a.id === 'durable_2_h')).not.toHaveProperty('parentAgentId');
    expect(agents.find((a) => a.id === 'durable_5_h')).not.toHaveProperty('parentAgentId');
    expect(agents.find((a) => a.id === 'durable_3_gone')?.parentAgentId).toBe('durable_1_orch');
  });

  it('disposeHelper honours the checks unless forced', async () => {
    seedFamily({ durable_2_dirty: { dirty: 1 } });
    expect(await disposeHelper(PROJECT_PATH, 'durable_2_dirty')).toMatchObject({ ok: false, checks: { dirty: 1 } });
    expect(worktreeRemovals()).toEqual([]);
    expect(await disposeHelper(PROJECT_PATH, 'durable_2_dirty', { force: true })).toMatchObject({ ok: true });
    expect(worktreeRemovals()).toEqual([worktree('durable_2_dirty')]);
  });
});

describe('disposed rows', () => {
  beforeEach(() => {
    seed([
      agent('durable_1_orch'),
      agent('durable_2_gone', { parentAgentId: 'durable_1_orch', disposable: true, disposedAt: DISPOSED_AT, branch: 'gone/standby' }),
    ]);
  });

  it('reads as a row with no worktree', async () => {
    expect(await getWorktreeStatus(PROJECT_PATH, 'durable_2_gone')).toMatchObject({ isValid: false });
    expect(await getDisposeChecks(PROJECT_PATH, 'durable_2_gone')).toEqual({ dirty: 0, unpushed: 0, unmerged: 0 });
    expect(gitCalls).toEqual([]);
  });

  it('is left out of helper lists unless asked for', async () => {
    expect(await listHelpers(PROJECT_PATH, 'durable_1_orch')).toEqual([]);
    expect((await listHelpers(PROJECT_PATH, 'durable_1_orch', { includeDisposed: true })).map((a) => a.id))
      .toEqual(['durable_2_gone']);
    expect(await listHelpers(PROJECT_PATH, 'durable_1_orch', { recursive: true })).toEqual([]);
  });

  it('is not disposed twice and is skipped by the cascade', async () => {
    expect(await disposeHelper(PROJECT_PATH, 'durable_2_gone')).toMatchObject({ ok: true, message: 'Already disposed' });
    expect(await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose')).toMatchObject({ ok: true, helperIds: [] });
    expect(gitCalls).toEqual([]);
  });

  it('can be removed by the user without touching git', async () => {
    await deleteDurable(PROJECT_PATH, 'durable_2_gone');
    expect((await listDurable(PROJECT_PATH)).map((a) => a.id)).toEqual(['durable_1_orch']);
    expect(gitCalls).toEqual([]);
  });
});
