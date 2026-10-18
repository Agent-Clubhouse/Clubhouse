import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

// In-memory filesystem plus a scriptable git, so the helper cascade (#2224)
// can be exercised against dirty, unpushed, unmerged and broken worktrees.
const files = new Map<string, string>();
const dirs = new Set<string>();

interface FakeRepo {
  branch: string;
  dirty: number;
  /** Commits on no remote. */
  unpushed: number;
  /** Commits on no other local branch; defaults to `unpushed`. */
  localOnly?: number;
  /** Commits not in the base branch. */
  unmerged: number;
  /** Git commands starting with this fail in this repo. */
  failOn?: string;
}
const repoByWorktree = new Map<string, FakeRepo>();
const repoByBranch = new Map<string, FakeRepo>();
const branches = new Set<string>();
const rmFailures = new Set<string>();
let remoteConfigured = true;
let baseBranch: string | null = 'main';
let showRefBroken = false;
let remoteFetched = true;
let probeError: string | null = null;
const gitCalls: Array<{ args: string[]; cwd: string }> = [];
const START_SHA = 'a'.repeat(40);
const MOVED_SHA = 'b'.repeat(40);
const movedBranches = new Set<string>();

function exitError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function repoForRefs(args: string[]): FakeRepo | undefined {
  for (const arg of args) {
    if (arg.startsWith('refs/heads/')) {
      const repo = repoByBranch.get(arg.slice('refs/heads/'.length));
      if (repo) return repo;
    }
  }
  return undefined;
}

function gitOutput(args: string[], cwd: string): string {
  const cmd = args.join(' ');
  const repo = repoByWorktree.get(cwd) ?? repoForRefs(args);
  if (repo?.failOn && cmd.startsWith(repo.failOn)) throw exitError(128, `fatal: simulated failure of git ${repo.failOn}`);
  if (cmd.startsWith('show-ref --verify --quiet refs/heads/')) {
    if (showRefBroken) throw exitError(128, 'fatal: not a git repository');
    const name = cmd.slice('show-ref --verify --quiet refs/heads/'.length);
    if (name === baseBranch || branches.has(name)) return '';
    throw exitError(1, '');
  }
  if (cmd.startsWith('rev-parse --verify --quiet refs/heads/')) {
    // An owned branch's tip (#2226): unmoved unless a test moves it.
    const name = args[3].slice('refs/heads/'.length);
    if (branches.has(name)) return `${movedBranches.has(name) ? MOVED_SHA : START_SHA}\n`;
    throw exitError(1, '');
  }
  if (cmd.startsWith('rev-parse --verify')) {
    if (args[2] === baseBranch) return 'abc\n';
    throw exitError(128, 'unknown revision');
  }
  if (cmd.startsWith('worktree remove')) {
    const wt = args[args.length - 1];
    if (rmFailures.has(wt)) throw exitError(128, 'fatal: busy');
    dirs.delete(wt);
    dirs.delete(path.join(wt, '.git'));
    return '';
  }
  if (cmd.startsWith('branch -D') || cmd.startsWith('branch -d')) {
    branches.delete(args[args.length - 1]);
    return '';
  }
  if (cmd === 'remote') return remoteConfigured ? 'origin\n' : '';
  if (cmd.startsWith('for-each-ref')) return remoteFetched ? 'refs/remotes/origin/main\n' : '';
  if (cmd === 'rev-parse --is-inside-work-tree') {
    if (probeError) throw exitError(128, probeError);
    return 'true\n';
  }
  if (cmd === 'symbolic-ref --quiet HEAD') {
    if (!repo) throw exitError(1, '');
    return `refs/heads/${repo.branch}\n`;
  }
  if (!repo) return '';
  if (cmd === 'status --porcelain') return Array.from({ length: repo.dirty }, (_, i) => ` M file${i}.ts`).join('\n');
  if (args[0] === 'rev-list' && args[1] === '--count') {
    if (args.includes('--remotes')) return `${repo.unpushed}\n`;
    if (args.includes('--branches')) return `${repo.localOnly ?? repo.unpushed}\n`;
    return `${repo.unmerged}\n`;
  }
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
  rm: vi.fn(async (p: string) => {
    if (rmFailures.has(String(p))) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    dirs.delete(String(p));
  }),
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
  helperCreationBlock,
  listDurable,
  listHelpers,
  normalizeHelperFields,
  renameDurable,
  resolveHelpersForDelete,
  setOrchestrationConfig,
  setParentAgent,
  updateDurableConfig,
} from './agent-config';
import { setPersonaChangeHook } from './persona-change-hook';
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

/** An agent with a worktree and branch whose git state is `repo`. */
function withWorktree(id: string, repo: Partial<FakeRepo> = {}, extra: Partial<DurableAgentConfig> = {}): DurableAgentConfig {
  const wt = worktree(id);
  const branch = `${id}/standby`;
  dirs.add(wt);
  dirs.add(path.join(wt, '.git'));
  branches.add(branch);
  const fake: FakeRepo = { branch, dirty: 0, unpushed: 0, unmerged: 0, ...repo };
  repoByWorktree.set(wt, fake);
  repoByBranch.set(branch, fake);
  return agent(id, { worktreePath: wt, branch, ...extra });
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
  repoByWorktree.clear();
  repoByBranch.clear();
  branches.clear();
  rmFailures.clear();
  movedBranches.clear();
  remoteConfigured = true;
  baseBranch = 'main';
  showRefBroken = false;
  remoteFetched = true;
  probeError = null;
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

describe('orchestration config (#2228)', () => {
  it('stores the policy fields across a restart and other writes, and clears them', async () => {
    seed([agent('durable_1_orch')]);
    await setOrchestrationConfig(PROJECT_PATH, 'durable_1_orch', { orchestrate: true, control: 'ask-before-start' });
    await updateDurableConfig(PROJECT_PATH, 'durable_1_orch', { model: 'opus' });
    await flushAllAgentConfigs();
    clearAgentConfigCache();
    expect((await listDurable(PROJECT_PATH))[0]).toMatchObject({
      model: 'opus', orchestration: { orchestrate: true, control: 'ask-before-start' },
    });

    await setOrchestrationConfig(PROJECT_PATH, 'durable_1_orch', undefined);
    await flushAllAgentConfigs();
    expect(onDisk('durable_1_orch')).not.toHaveProperty('orchestration');
  });

  it('is not written by updateDurableConfig', async () => {
    seed([agent('durable_1_orch')]);
    await updateDurableConfig(PROJECT_PATH, 'durable_1_orch', { orchestration: { orchestrate: true } } as never);
    expect((await listDurable(PROJECT_PATH))[0]).not.toHaveProperty('orchestration');
  });

  it('tells the persona hook about a persona change, with the old persona', async () => {
    seed([agent('durable_1_orch', { persona: 'orchestrator' })]);
    const hook = vi.fn(async () => undefined);
    setPersonaChangeHook(hook);
    try {
      await updateDurableConfig(PROJECT_PATH, 'durable_1_orch', { model: 'opus' });
      expect(hook).not.toHaveBeenCalled();
      await updateDurableConfig(PROJECT_PATH, 'durable_1_orch', { persona: 'developer' });
      expect(hook).toHaveBeenCalledWith({ kind: 'agent', projectPath: PROJECT_PATH, agentId: 'durable_1_orch', previousPersona: 'orchestrator' });
      // A failing hook doesn't fail the update.
      hook.mockRejectedValueOnce(new Error('boom'));
      await expect(updateDurableConfig(PROJECT_PATH, 'durable_1_orch', { persona: 'qa' })).resolves.toBeUndefined();
    } finally {
      setPersonaChangeHook(null);
    }
  });

  it('throws for an unknown agent', async () => {
    seed([]);
    await expect(setOrchestrationConfig(PROJECT_PATH, 'durable_9_missing', { orchestrate: true })).rejects.toThrow(/not found/);
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

  function branchDeletions(): string[] {
    return gitCalls.filter((c) => c.args[0] === 'branch' && (c.args[1] === '-D' || c.args[1] === '-d')).map((c) => c.args[c.args.length - 1]);
  }

  it('reports the dirty, unpushed and unmerged checks for a worktree', async () => {
    seedFamily({ durable_2_h: { dirty: 2, unpushed: 1, unmerged: 3 } });
    expect(await getDisposeChecks(PROJECT_PATH, 'durable_2_h')).toEqual({ dirty: 2, unpushed: 1, unmerged: 3 });
  });

  it('dispose: blocks on a dirty helper and changes nothing', async () => {
    seedFamily({ durable_2_dirty: { dirty: 1 }, durable_3_clean: {} });

    const result = await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose');

    expect(result.ok).toBe(false);
    expect(result.blocked).toEqual([
      { agentId: 'durable_2_dirty', name: 'durable_2_dirty', checks: { dirty: 1, unpushed: 0, unmerged: 0 } },
    ]);
    expect(worktreeRemovals()).toEqual([]);
    expect(branchDeletions()).toEqual([]);
    const helpers = await listHelpers(PROJECT_PATH, 'durable_1_orch');
    expect(helpers.map((a) => a.id)).toEqual(['durable_2_dirty', 'durable_3_clean']);
    expect(helpers.every((a) => !a.disposedAt && a.worktreePath)).toBe(true);
  });

  it('dispose: blocks on an unpushed helper', async () => {
    seedFamily({ durable_2_unpushed: { unpushed: 2, unmerged: 2 } });
    const result = await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose');
    expect(result.ok).toBe(false);
    expect(result.blocked?.map((b) => b.agentId)).toEqual(['durable_2_unpushed']);
    expect(worktreeRemovals()).toEqual([]);
  });

  it('dispose: allows a pushed helper whose work is not merged, and reports the unmerged count', async () => {
    seedFamily({ durable_2_pushed: { unpushed: 0, unmerged: 3 } });
    expect(await getDisposeChecks(PROJECT_PATH, 'durable_2_pushed')).toEqual({ dirty: 0, unpushed: 0, unmerged: 3 });

    const result = await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose');

    expect(result).toMatchObject({ ok: true, helperIds: ['durable_2_pushed'] });
    expect(branchDeletions()).toEqual(['durable_2_pushed/standby']);
  });

  it('B1: a missing worktree folder still checks the branch, and blocks on its unpushed commits', async () => {
    seedFamily({ durable_2_h: { unpushed: 2, unmerged: 2 } });
    dirs.delete(worktree('durable_2_h'));
    dirs.delete(path.join(worktree('durable_2_h'), '.git'));

    expect(await getDisposeChecks(PROJECT_PATH, 'durable_2_h')).toEqual({ dirty: 0, unpushed: 2, unmerged: 2 });
    const result = await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose');

    expect(result.ok).toBe(false);
    expect(result.blocked?.map((b) => b.agentId)).toEqual(['durable_2_h']);
    expect(branchDeletions()).toEqual([]);
    // The branch was checked from the project, not the missing folder.
    expect(gitCalls.some((c) => c.cwd === PROJECT_PATH && c.args.includes('refs/heads/durable_2_h/standby') && c.args[0] === 'rev-list')).toBe(true);
  });

  it('B1: a missing worktree folder and branch leave nothing to lose', async () => {
    seedFamily({ durable_2_h: {} });
    dirs.delete(worktree('durable_2_h'));
    dirs.delete(path.join(worktree('durable_2_h'), '.git'));
    branches.delete('durable_2_h/standby');

    expect(await getDisposeChecks(PROJECT_PATH, 'durable_2_h')).toEqual({ dirty: 0, unpushed: 0, unmerged: 0 });
    expect(await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose')).toMatchObject({ ok: true });
  });

  it('a project git says is not a repository has nothing to lose', async () => {
    seedFamily({ durable_2_h: {} });
    dirs.delete(worktree('durable_2_h'));
    probeError = 'fatal: not a git repository (or any of the parent directories): .git';
    expect(await getDisposeChecks(PROJECT_PATH, 'durable_2_h')).toEqual({ dirty: 0, unpushed: 0, unmerged: 0 });
  });

  it('any other failure of the repository probe blocks', async () => {
    seedFamily({ durable_2_h: {} });
    dirs.delete(worktree('durable_2_h'));
    probeError = 'fatal: detected dubious ownership in repository';
    const checks = await getDisposeChecks(PROJECT_PATH, 'durable_2_h');
    expect(checks.error).toMatch(/couldn't check, fatal: detected dubious ownership/);
    expect((await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose')).ok).toBe(false);
  });

  it('blocks when the remote was never fetched', async () => {
    remoteFetched = false;
    seedFamily({ durable_2_h: { unpushed: 4210 } });
    expect((await getDisposeChecks(PROJECT_PATH, 'durable_2_h')).error).toMatch(/never been fetched/);
  });

  it('blocks a worktree folder that is not a git worktree', async () => {
    seedFamily({ durable_2_h: {} });
    dirs.delete(path.join(worktree('durable_2_h'), '.git'));
    const checks = await getDisposeChecks(PROJECT_PATH, 'durable_2_h');
    expect(checks.error).toMatch(/couldn't check.*not a git worktree/);
    expect((await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose')).ok).toBe(false);
  });

  it('B2: with no remote and no main or master, blocks on commits found on no other branch', async () => {
    remoteConfigured = false;
    baseBranch = null;
    seedFamily({ durable_2_h: { unpushed: 5, localOnly: 2, unmerged: 9 } });

    const checks = await getDisposeChecks(PROJECT_PATH, 'durable_2_h');

    // The unmerged count falls back to the orchestrator's branch.
    expect(checks).toEqual({ dirty: 0, unpushed: 2, unmerged: 9 });
    const revList = gitCalls.find((c) => c.args[0] === 'rev-list' && c.args.includes('--branches'));
    expect(revList?.args).toEqual([
      'rev-list', '--count', 'refs/heads/durable_2_h/standby', 'HEAD', '--not', '--exclude=durable_2_h/standby', '--branches',
    ]);
    expect((await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose')).ok).toBe(false);
    expect(branchDeletions()).toEqual([]);
  });

  it('B2: with no remote, work saved on another branch can be disposed', async () => {
    remoteConfigured = false;
    baseBranch = null;
    seedFamily({ durable_2_h: { unpushed: 5, localOnly: 0, unmerged: 0 } });
    expect(await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose')).toMatchObject({ ok: true });
  });

  it('reports unmerged as unknown when no base branch can be found', async () => {
    baseBranch = null;
    seed([agent('durable_1_orch'), withWorktree('durable_2_h', {}, { parentAgentId: 'durable_1_orch' })]);
    expect(await getDisposeChecks(PROJECT_PATH, 'durable_2_h')).toEqual({ dirty: 0, unpushed: 0, unmerged: null });
  });

  it.each([
    ['git status', 'status'],
    ['git remote', 'remote'],
    ['git rev-list', 'rev-list'],
  ])('B3: a failing %s blocks with the reason', async (_label, failOn) => {
    seedFamily({ durable_2_h: { failOn } });

    const result = await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose');

    expect(result.ok).toBe(false);
    expect(result.blocked?.[0].checks.error).toMatch(new RegExp(`couldn't check, fatal: simulated failure of git ${failOn}`));
    expect(worktreeRemovals()).toEqual([]);
    expect(branchDeletions()).toEqual([]);
  });

  it('force overrides work at risk but never a check that couldn\'t run (#2228)', async () => {
    seedFamily({ durable_2_dirty: { dirty: 1 }, durable_3_broken: { failOn: 'status' } });

    for (const dryRun of [true, false]) {
      const result = await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose', { force: true, dryRun });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/even with force/);
      expect(result.blocked?.map((b) => b.agentId)).toEqual(['durable_3_broken']);
    }
    expect(worktreeRemovals()).toEqual([]);
    expect(branchDeletions()).toEqual([]);

    // With every check able to run, force does dispose work at risk.
    seedFamily({ durable_2_dirty: { dirty: 1 } });
    clearAgentConfigCache();
    expect(await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose', { force: true })).toMatchObject({ ok: true });
  });

  it('B3: a branch lookup that fails (not a missing branch) blocks', async () => {
    seedFamily({ durable_2_h: {} });
    showRefBroken = true;
    const checks = await getDisposeChecks(PROJECT_PATH, 'durable_2_h');
    expect(checks.error).toMatch(/couldn't check, fatal: not a git repository/);
  });

  it('B4: a helper another Clubhouse instance is still creating is never disposed, even forced', async () => {
    seed([
      withWorktree('durable_1_orch'),
      withWorktree('durable_2_new', {}, {
        parentAgentId: 'durable_1_orch',
        // Owned by a live process with a fresh heartbeat, so recovery leaves it alone (#2226).
        creation: { state: 'creating', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), owner: { pid: process.ppid, instanceId: 'other-window' } },
      }),
    ]);
    expect(helperCreationBlock((await listDurable(PROJECT_PATH))[1])).toMatch(/being created/);

    const result = await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose');
    expect(result.ok).toBe(false);
    expect(result.blocked?.[0].checks.error).toMatch(/being created/);

    expect(await disposeHelper(PROJECT_PATH, 'durable_2_new', { force: true })).toMatchObject({ ok: false });
    // Nor through the cascade (orchestrate turn-off with force, #2228).
    const forced = await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose', { force: true });
    expect(forced.ok).toBe(false);
    expect(forced.blocked?.[0].checks.error).toMatch(/being created/);
    expect(worktreeRemovals()).toEqual([]);
    expect((await listDurable(PROJECT_PATH)).find((a) => a.id === 'durable_2_new')?.disposedAt).toBeUndefined();
  });

  it('disposes an owned helper branch only while it is unmoved (#2226)', async () => {
    seed([
      withWorktree('durable_1_orch'),
      withWorktree('durable_2_owned', {}, { parentAgentId: 'durable_1_orch', branchOwned: true, branchStartSha: START_SHA }),
      withWorktree('durable_3_moved', {}, { parentAgentId: 'durable_1_orch', branchOwned: true, branchStartSha: START_SHA }),
      withWorktree('durable_4_theirs', {}, { parentAgentId: 'durable_1_orch', branchOwned: false }),
    ]);
    movedBranches.add('durable_3_moved/standby');

    const result = await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose');

    expect(result).toMatchObject({ ok: true, helperIds: ['durable_2_owned', 'durable_3_moved', 'durable_4_theirs'] });
    // Only the unmoved owned branch goes, with -D after the tip check; the folders all go first.
    expect(branchDeletions()).toEqual(['durable_2_owned/standby']);
    expect(gitCalls.map((c) => c.args)).toContainEqual(['branch', '-D', '--', 'durable_2_owned/standby']);
    expect(worktreeRemovals()).toHaveLength(3);
  });

  it('reports exactly which helpers were disposed when one fails part way', async () => {
    seedFamily({ durable_2_ok: {}, durable_3_busy: {}, durable_4_ok: {} });
    rmFailures.add(worktree('durable_3_busy'));

    const result = await resolveHelpersForDelete(PROJECT_PATH, 'durable_1_orch', 'dispose');
    await flushAllAgentConfigs();

    expect(result.ok).toBe(false);
    expect(result.helperIds).toEqual(['durable_2_ok', 'durable_4_ok']);
    expect(result.failed).toEqual([
      { agentId: 'durable_3_busy', name: 'durable_3_busy', reason: expect.stringMatching(/EBUSY/) },
    ]);
    expect(onDisk('durable_2_ok')?.disposedAt).toEqual(expect.any(String));
    expect(onDisk('durable_4_ok')?.disposedAt).toEqual(expect.any(String));
    // The failed helper keeps its row, worktree path and branch.
    expect(onDisk('durable_3_busy')).not.toHaveProperty('disposedAt');
    expect(onDisk('durable_3_busy')?.worktreePath).toBe(worktree('durable_3_busy'));
    expect(branchDeletions()).not.toContain('durable_3_busy/standby');
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

  it('a failed folder removal keeps the branch on a plain delete too', async () => {
    seed([withWorktree('durable_1_a')]);
    rmFailures.add(worktree('durable_1_a'));
    await expect(deleteDurable(PROJECT_PATH, 'durable_1_a')).rejects.toThrow(/EBUSY/);
    expect(branchDeletions()).toEqual([]);
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
