import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import type { DurableAgentConfig, DurableAgentCreation, DurableCreationEvent } from '../../shared/types';

// In-memory filesystem: files by path, plus a set of directories.
const files = new Map<string, string>();
const dirs = new Set<string>();

type GitCallback = (error: Error | null, stdout: string) => void;
type GitImpl = (args: string[], opts: { signal?: AbortSignal }, cb: GitCallback) => void;
let gitImpl: GitImpl;

vi.mock('child_process', () => ({
  execFile: vi.fn((_file: string, args: string[], opts: { signal?: AbortSignal }, cb: GitCallback) => {
    gitImpl(args, opts, cb);
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
  mkdir: vi.fn(async (p: string, opts?: { recursive?: boolean }) => {
    if (!opts?.recursive && dirs.has(String(p))) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    dirs.add(String(p));
  }),
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
  // Project personas only; the in-memory fs has no user personas.
  readSourcePersonaContent: vi.fn(async (projectPath: string, personaId: string, scope: string) =>
    (scope === 'project' && files.get(path.join(projectPath, '.clubhouse', 'personas', `${personaId}.md`))) || ''),
}));
vi.mock('./agent-system', () => ({
  resolveOrchestrator: vi.fn(async () => ({ writeInstructions: vi.fn(), conventions: {} })),
}));

import * as fsp from 'fs/promises';
import { execFile } from 'child_process';
import { setProducingRuntime } from '../telemetry/__test-utils__/producing-runtime';
import type { TelemetryRuntime } from '../telemetry/types';
import {
  INTERRUPTED_CREATION_REASON,
  branchFromProblem,
  checkDurableCreation,
  clearAgentConfigCache,
  createDurable,
  deleteDurable,
  deleteUnregister,
  flushAgentConfig,
  isDurableCreationActive,
  listDurable,
  disposeHelper,
  recoverInterruptedCreations,
  resolveHelpersForDelete,
} from './agent-config';
import { cancelDurableCreation, onDurableCreationEvent, startDurableCreation } from './agent-creation';

const PROJECT_PATH = path.resolve('test-project');
const CONFIG_PATH = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
const SHA = 'c'.repeat(40);
const agentPath = (folder: string) => path.join(PROJECT_PATH, '.clubhouse', 'agents', folder);
/** A pid no live process has. */
const DEAD_PID = 2 ** 30;

function gitArgv(): string[][] {
  return vi.mocked(execFile).mock.calls.map((c) => [...(c[1] as unknown as string[])]);
}

function diskAgents(): DurableAgentConfig[] {
  return JSON.parse(files.get(CONFIG_PATH) ?? '[]') as DurableAgentConfig[];
}

const isResolve = (args: string[]) => args[0] === 'rev-parse' && args[1] === '--verify';
const isBranchCreate = (args: string[]) => args[0] === 'branch' && args[1] === '--no-track';
const isWorktreeAdd = (args: string[]) => args[0] === 'worktree' && args[1] === 'add';
const branchDeletes = () => gitArgv().filter((a) => a[0] === 'branch' && (a[1] === '-D' || a[1] === '-d'));

/** Default git: base refs resolve to SHA, everything else succeeds; worktree add makes the folder. */
function defaultGit(args: string[], _opts: { signal?: AbortSignal }, cb: GitCallback): void {
  if (isResolve(args)) return cb(null, `${SHA}\n`);
  if (isWorktreeAdd(args)) dirs.add(args[3]);
  cb(null, '');
}

/** Hold `git worktree add` until released; it fails with an AbortError if its signal fires first. */
function slowWorktreeAdd(): { reached: Promise<void>; release: () => void } {
  let release!: () => void;
  let reached!: () => void;
  const reachedP = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  gitImpl = (args, opts, cb) => {
    if (isWorktreeAdd(args)) {
      reached();
      opts.signal?.addEventListener('abort', () => cb(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), ''));
      void gate.then(() => { if (!opts.signal?.aborted) { dirs.add(args[3]); cb(null, ''); } });
      return;
    }
    defaultGit(args, opts, cb);
  };
  return { reached: reachedP, release };
}

let events: DurableCreationEvent[];
let unsubscribe: () => void;

beforeEach(() => {
  clearAgentConfigCache();
  vi.mocked(execFile).mockClear();
  vi.mocked(fsp.rm).mockClear();
  files.clear();
  dirs.clear();
  gitImpl = defaultGit;
  events = [];
  unsubscribe = onDurableCreationEvent((e) => events.push(e));
});

afterEach(() => {
  unsubscribe();
  setProducingRuntime(null);
});

describe('createDurable worktree options (#2226)', () => {
  it('branches from the current commit into <name>/standby by default', async () => {
    const config = await createDurable(PROJECT_PATH, 'scout', 'indigo');
    expect(config.worktreePath).toBe(agentPath('scout'));
    expect(config.branch).toBe('scout/standby');
    expect(config).toMatchObject({ branchOwned: true, branchStartSha: SHA });
    expect(config).not.toHaveProperty('creation');
    expect(gitArgv()).toContainEqual(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    expect(gitArgv()).toContainEqual(['branch', '--no-track', '--', 'scout/standby', SHA]);
    expect(gitArgv()).toContainEqual(['worktree', 'add', '--', agentPath('scout'), 'scout/standby']);
  });

  it('resolves branch-from to a commit and passes folder, branch and SHA as separate arguments', async () => {
    const config = await createDurable(PROJECT_PATH, 'Helper for #12', 'indigo', undefined, true, undefined, undefined, undefined, undefined, undefined, {
      folderName: 'helper-12', branchName: 'helpers/helper-12', branchFrom: 'orchestrator/standby',
    });
    expect(config.name).toBe('Helper for #12');
    expect(config.worktreePath).toBe(agentPath('helper-12'));
    expect(config.branch).toBe('helpers/helper-12');
    expect(gitArgv()).toContainEqual(['rev-parse', '--verify', '--quiet', 'orchestrator/standby^{commit}']);
    expect(gitArgv()).toContainEqual(['branch', '--no-track', '--', 'helpers/helper-12', SHA]);
    expect(gitArgv()).toContainEqual(['worktree', 'add', '--', agentPath('helper-12'), 'helpers/helper-12']);
    for (const call of vi.mocked(execFile).mock.calls) expect(call[0]).toBe('git');
  });

  it.each([
    ['a traversing folder', { folderName: '../outside' }, /agent name/],
    ['a nested folder', { folderName: 'a/b' }, /agent name/],
    ['an option-like branch', { branchName: '--force' }, /branch name/],
    ['a shell branch', { branchName: 'x;rm -rf ~' }, /branch name/],
    ['an empty base', { branchFrom: '' }, /branch or commit to start from/],
    ['an option-like base', { branchFrom: '--upload-pack=touch' }, /cannot start with -/],
    ['a base with a space', { branchFrom: 'main evil' }, /spaces or control characters/],
    ['a base with a tab', { branchFrom: 'main\tevil' }, /spaces or control characters/],
    ['a base with a control character', { branchFrom: 'main\u0001' }, /spaces or control characters/],
    ['a base with a newline', { branchFrom: 'main\n--evil' }, /spaces or control characters/],
  ])('refuses %s before touching git or disk', async (_label, options, message) => {
    await expect(createDurable(PROJECT_PATH, 'ok-name', 'indigo', undefined, true, undefined, undefined, undefined, undefined, undefined, options))
      .rejects.toThrow(message);
    expect(execFile).not.toHaveBeenCalled();
    expect(files.has(CONFIG_PATH)).toBe(false);
  });

  it('accepts tags, remote branches and relative refs as a base, leaving resolution to git', () => {
    for (const ref of ['v1.2.3', 'origin/main', 'HEAD~1', SHA]) expect(branchFromProblem(ref)).toBeNull();
  });

  it('refuses a base git cannot resolve, before any branch is made', async () => {
    gitImpl = (args, opts, cb) => (isResolve(args) ? cb(new Error('exit 1'), '') : defaultGit(args, opts, cb));
    await expect(createDurable(PROJECT_PATH, 'based', 'indigo', undefined, true, undefined, undefined, undefined, undefined, undefined, { branchFrom: 'nope' }))
      .rejects.toThrow(/Could not find "nope" to start the branch from/);
    await flushAgentConfig(PROJECT_PATH);
    expect(diskAgents()).toEqual([]);
    expect(gitArgv().some(isBranchCreate)).toBe(false);
    expect(gitArgv().some(isWorktreeAdd)).toBe(false);
  });

  it('refuses a named branch that already exists, and never deletes it', async () => {
    gitImpl = (args, opts, cb) => (isBranchCreate(args) ? cb(new Error("fatal: a branch named 'user/feature' already exists"), '') : defaultGit(args, opts, cb));
    await expect(createDurable(PROJECT_PATH, 'adopt', 'indigo', undefined, true, undefined, undefined, undefined, undefined, undefined, { branchName: 'user/feature' }))
      .rejects.toThrow(/Could not create the branch "user\/feature".*does not exist yet/);
    expect(branchDeletes()).toEqual([]);
    expect(gitArgv().some(isWorktreeAdd)).toBe(false);
    await flushAgentConfig(PROJECT_PATH);
    expect(diskAgents()).toEqual([]);
  });

  it('reuses an existing default standby branch without owning it, so deleting the agent keeps it', async () => {
    gitImpl = (args, opts, cb) => (isBranchCreate(args) ? cb(new Error('already exists'), '') : defaultGit(args, opts, cb));
    const config = await createDurable(PROJECT_PATH, 'again', 'indigo');
    expect(config.branchOwned).toBe(false);
    expect(config).not.toHaveProperty('branchStartSha');
    await deleteDurable(PROJECT_PATH, config.id);
    expect(branchDeletes()).toEqual([]);
  });

  it('refuses a folder left by a removed agent, suggests another name, and never deletes it', async () => {
    dirs.add(agentPath('taken'));
    await expect(createDurable(PROJECT_PATH, 'taken', 'indigo')).rejects.toThrow(/left over from a removed agent.*"taken-2"/);
    expect(dirs.has(agentPath('taken'))).toBe(true);
    expect(fsp.rm).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('never deletes a folder that appeared before its own worktree add', async () => {
    gitImpl = (args, opts, cb) => {
      if (isBranchCreate(args)) dirs.add(agentPath('racy'));
      defaultGit(args, opts, cb);
    };
    await expect(createDurable(PROJECT_PATH, 'racy', 'indigo')).rejects.toThrow(/appeared while the agent was being created/);
    expect(dirs.has(agentPath('racy'))).toBe(true);
    expect(gitArgv().some((a) => a[0] === 'worktree' && a[1] === 'remove')).toBe(false);
    expect(gitArgv().some(isWorktreeAdd)).toBe(false);
    // The branch it did create is removed, by its start commit.
    expect(branchDeletes()).toEqual([['branch', '-D', '--', 'racy/standby']]);
  });
});

describe('concurrent creations (#2226 B1)', () => {
  it('lets only one of two same-name creations claim the folder; the loser touches nothing', async () => {
    const slow = slowWorktreeAdd();
    const [first, second] = await Promise.allSettled([
      startDurableCreation(PROJECT_PATH, { name: 'twin', color: 'indigo' }),
      startDurableCreation(PROJECT_PATH, { name: 'twin', color: 'amber' }),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect((second as PromiseRejectedResult).reason.message).toMatch(/Another agent is being created in \.clubhouse\/agents\/twin.*"twin-2"/);

    await slow.reached;
    slow.release();
    const winner = (first as PromiseFulfilledResult<Awaited<ReturnType<typeof startDurableCreation>>>).value;
    expect(await winner.done).toBe('ready');
    expect(dirs.has(agentPath('twin'))).toBe(true);
    expect(gitArgv().some((a) => a[0] === 'worktree' && a[1] === 'remove')).toBe(false);
    expect(fsp.rm).not.toHaveBeenCalled();
    expect((await listDurable(PROJECT_PATH)).map((a) => a.id)).toEqual([winner.agentId]);
  });

  it('refuses a second creation on a branch another creation has claimed', async () => {
    const slow = slowWorktreeAdd();
    const first = await startDurableCreation(PROJECT_PATH, { name: 'one', color: 'indigo', branchName: 'shared/work' });
    await expect(startDurableCreation(PROJECT_PATH, { name: 'two', color: 'indigo', branchName: 'shared/work' }))
      .rejects.toThrow(/already uses the branch "shared\/work"/);
    slow.release();
    expect(await first.done).toBe('ready');
  });

  it('releases the folder once a creation ends, so the name can be used again', async () => {
    gitImpl = (args, opts, cb) => (isWorktreeAdd(args) ? cb(new Error('boom'), '') : defaultGit(args, opts, cb));
    const failed = await startDurableCreation(PROJECT_PATH, { name: 'retry', color: 'indigo' });
    expect(await failed.done).toBe('failed');
    await deleteDurable(PROJECT_PATH, failed.agentId);
    gitImpl = defaultGit;
    const again = await startDurableCreation(PROJECT_PATH, { name: 'retry', color: 'indigo' });
    expect(await again.done).toBe('ready');
  });
});

describe('checkDurableCreation', () => {
  it('passes a creation that would start, and changes nothing', async () => {
    await expect(checkDurableCreation(PROJECT_PATH, { name: 'fresh', color: 'indigo', branchFrom: 'main' })).resolves.toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
    expect(await listDurable(PROJECT_PATH)).toEqual([]);
    // Nothing was reserved: the real creation still goes through.
    const started = await startDurableCreation(PROJECT_PATH, { name: 'fresh', color: 'indigo' });
    expect(await started.done).toBe('ready');
  });

  it('refuses what the creation would refuse: a bad name, a taken folder or branch, a leftover folder', async () => {
    await expect(checkDurableCreation(PROJECT_PATH, { name: 'x', color: 'indigo', folderName: '..' })).rejects.toThrow(/agent name/);
    const first = await startDurableCreation(PROJECT_PATH, { name: 'one', color: 'indigo', branchName: 'shared/work' });
    expect(await first.done).toBe('ready');
    await expect(checkDurableCreation(PROJECT_PATH, { name: 'one', color: 'indigo' })).rejects.toThrow(/Another agent already uses \.clubhouse\/agents\/one/);
    await expect(checkDurableCreation(PROJECT_PATH, { name: 'two', color: 'indigo', branchName: 'shared/work' }))
      .rejects.toThrow(/already uses the branch "shared\/work"/);
    dirs.add(agentPath('bad'));
    await expect(checkDurableCreation(PROJECT_PATH, { name: 'bad', color: 'indigo' })).rejects.toThrow(/left over from a removed agent/);
    await expect(checkDurableCreation(PROJECT_PATH, { name: 'kid', color: 'indigo', parentAgentId: 'nobody' })).rejects.toThrow(/Parent agent not found/);
  });
});

describe('startDurableCreation (#2226)', () => {
  it('returns the id while git worktree add is still running, then reports each stage', async () => {
    const slow = slowWorktreeAdd();
    const started = await startDurableCreation(PROJECT_PATH, { name: 'helper', color: 'indigo', branchFrom: 'main' });

    expect(started.agentId).toMatch(/^durable_/);
    expect(started.config.creation).toMatchObject({ state: 'creating', stage: 'config_created', owner: { pid: process.pid } });
    expect(started.config.branchOwned).toBe(false);
    expect(isDurableCreationActive(started.agentId)).toBe(true);
    // The creating record, branch ownership and folder claim are on disk before git does the slow part.
    await slow.reached;
    expect(diskAgents().find((a) => a.id === started.agentId)).toMatchObject({
      creation: { state: 'creating', folderOwned: true }, branchOwned: true, branchStartSha: SHA,
    });
    expect(events.map((e) => e.stage)).toEqual(['config_created']);

    slow.release();
    expect(await started.done).toBe('ready');
    expect(events.map((e) => e.stage)).toEqual(['config_created', 'worktree_added', 'config_injected', 'ready']);
    expect(events.every((e) => e.agentId === started.agentId && e.projectPath === PROJECT_PATH)).toBe(true);
    const ready = events.at(-1)!.config!;
    expect(ready).not.toHaveProperty('creation');
    expect(ready).toMatchObject({ worktreePath: agentPath('helper'), branchOwned: true, branchStartSha: SHA });

    // The ready write is flushed, without waiting for the debounce.
    expect(diskAgents().find((a) => a.id === started.agentId)).not.toHaveProperty('creation');
    expect(isDurableCreationActive(started.agentId)).toBe(false);
    expect(gitArgv()).toContainEqual(['branch', '--no-track', '--', 'helper/standby', SHA]);
  });

  it('runs the injection hook before ready', async () => {
    const inject = vi.fn(async () => undefined);
    const started = await startDurableCreation(PROJECT_PATH, { name: 'injected', color: 'indigo' }, { inject });
    expect(await started.done).toBe('ready');
    expect(inject).toHaveBeenCalledWith(expect.objectContaining({ id: started.agentId, worktreePath: agentPath('injected') }));
  });

  it('throws up front for a bad request, without a record', async () => {
    await expect(startDurableCreation(PROJECT_PATH, { name: 'x', color: 'indigo', folderName: '..' })).rejects.toThrow(/agent name/);
    expect(events).toEqual([]);
    expect(diskAgents()).toEqual([]);
  });

  it('reports failed with the reason, cleans up only what it made, and keeps the record marked failed', async () => {
    gitImpl = (args, opts, cb) => {
      if (isWorktreeAdd(args)) {
        dirs.add(args[3]); // git made the folder before it failed
        cb(new Error("fatal: 'helper/standby' is already checked out"), '');
      } else defaultGit(args, opts, cb);
    };
    const started = await startDurableCreation(PROJECT_PATH, { name: 'helper', color: 'indigo' });
    expect(await started.done).toBe('failed');

    const failed = events.find((e) => e.stage === 'failed')!;
    expect(failed.reason).toMatch(/Failed to create git worktree for "helper": fatal: 'helper\/standby' is already checked out/);
    expect(failed.config?.creation).toMatchObject({ state: 'failed', reason: failed.reason });
    expect(dirs.has(agentPath('helper'))).toBe(false);
    expect(branchDeletes()).toEqual([['branch', '-D', '--', 'helper/standby']]);
    // No repository-wide prune, ever.
    expect(gitArgv().some((a) => a[0] === 'worktree' && a[1] === 'prune')).toBe(false);
    await flushAgentConfig(PROJECT_PATH);
    const record = diskAgents().find((a) => a.id === started.agentId)!;
    expect(record.creation?.state).toBe('failed');
    expect(record.worktreePath).toBeUndefined();
    expect(record.branch).toBeUndefined();
    expect(record.branchOwned).toBeUndefined();
  });

  it('cancels mid worktree add: stops git, removes the partial worktree, branch and record', async () => {
    const slow = slowWorktreeAdd();
    const started = await startDurableCreation(PROJECT_PATH, { name: 'doomed', color: 'indigo' });
    await slow.reached;
    dirs.add(agentPath('doomed')); // partial checkout

    expect(await cancelDurableCreation(PROJECT_PATH, started.agentId)).toBe(true);
    expect(await started.done).toBe('cancelled');

    const addCall = vi.mocked(execFile).mock.calls.find((c) => isWorktreeAdd(c[1] as unknown as string[]))!;
    expect((addCall[2] as { signal?: AbortSignal }).signal?.aborted).toBe(true);
    expect(dirs.has(agentPath('doomed'))).toBe(false);
    expect(branchDeletes()).toEqual([['branch', '-D', '--', 'doomed/standby']]);
    expect(gitArgv().some((a) => a[0] === 'worktree' && a[1] === 'prune')).toBe(false);
    expect(events.map((e) => e.stage)).toEqual(['config_created', 'cancelled']);
    expect(await listDurable(PROJECT_PATH)).toEqual([]);
  });

  it('matches the project path loosely when cancelling', async () => {
    const slow = slowWorktreeAdd();
    const started = await startDurableCreation(PROJECT_PATH, { name: 'loose', color: 'indigo' });
    await slow.reached;
    expect(await cancelDurableCreation(`${PROJECT_PATH}${path.sep}`, started.agentId)).toBe(true);
    expect(await started.done).toBe('cancelled');
  });

  it('returns false when cancelling an agent that is not being created', async () => {
    const started = await startDurableCreation(PROJECT_PATH, { name: 'done-already', color: 'indigo' });
    await started.done;
    expect(await cancelDurableCreation(PROJECT_PATH, started.agentId)).toBe(false);
  });

  it('deletes the agent when a cancel lands just after the ready write (H1)', async () => {
    let cancelled: Promise<boolean> | undefined;
    const off = onDurableCreationEvent((e) => {
      if (e.stage === 'ready') cancelled = cancelDurableCreation(PROJECT_PATH, e.agentId);
    });
    const started = await startDurableCreation(PROJECT_PATH, { name: 'late', color: 'indigo' });
    expect(await started.done).toBe('ready');
    expect(await cancelled).toBe(true);
    off();
    expect(await listDurable(PROJECT_PATH)).toEqual([]);
    expect(dirs.has(agentPath('late'))).toBe(false);
    expect(branchDeletes()).toEqual([['branch', '-D', '--', 'late/standby']]);
  });

  it('deletes the agent when a delete lands just after the failed write (H1)', async () => {
    gitImpl = (args, opts, cb) => (isWorktreeAdd(args) ? cb(new Error('boom'), '') : defaultGit(args, opts, cb));
    let deleted: Promise<void> | undefined;
    const off = onDurableCreationEvent((e) => {
      if (e.stage === 'failed') deleted = deleteDurable(PROJECT_PATH, e.agentId);
    });
    const started = await startDurableCreation(PROJECT_PATH, { name: 'late-fail', color: 'indigo' });
    expect(await started.done).toBe('failed');
    await deleted;
    off();
    expect(await listDurable(PROJECT_PATH)).toEqual([]);
  });

  it('deleting an agent mid-create cancels the creation', async () => {
    const slow = slowWorktreeAdd();
    const started = await startDurableCreation(PROJECT_PATH, { name: 'deleted', color: 'indigo' });
    await slow.reached;
    await deleteDurable(PROJECT_PATH, started.agentId);
    expect(await started.done).toBe('cancelled');
    expect((await listDurable(PROJECT_PATH)).some((a) => a.id === started.agentId)).toBe(false);
  });

  it('refuses "Remove from list" while the agent is being created, keeping the creation (H4)', async () => {
    const slow = slowWorktreeAdd();
    const started = await startDurableCreation(PROJECT_PATH, { name: 'keepme', color: 'indigo' });
    await slow.reached;
    const result = await deleteUnregister(PROJECT_PATH, started.agentId);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/still being created/);
    slow.release();
    expect(await started.done).toBe('ready');
    expect(dirs.has(agentPath('keepme'))).toBe(true);
    expect((await listDurable(PROJECT_PATH)).map((a) => a.id)).toEqual([started.agentId]);
  });

  it('records the worktree creation as a step of the clubhouse.agent.create flow', async () => {
    const spans: string[] = [];
    setProducingRuntime({
      level: 'standard',
      flow: (name: string, _opts: unknown, fn: (s: unknown) => unknown) => { spans.push(`flow:${name}`); return fn({ set: () => {} }); },
      step: (name: string, fn: (s: unknown) => unknown) => { spans.push(`step:${name}`); return fn({ set: () => {} }); },
      count: vi.fn(),
      event: vi.fn(),
      exception: vi.fn(),
    } as unknown as TelemetryRuntime);
    const started = await startDurableCreation(PROJECT_PATH, { name: 'timed', color: 'indigo' });
    expect(await started.done).toBe('ready');
    expect(spans).toEqual(['flow:clubhouse.agent.create', 'step:clubhouse.git.worktree_add']);
  });

  it('records a refused request in the clubhouse.agent.create flow, typed validation', async () => {
    const flows: Array<{ name: string; thrown?: unknown }> = [];
    setProducingRuntime({
      level: 'standard',
      flow: (name: string, _opts: unknown, fn: (s: unknown) => unknown) => {
        const f: { name: string; thrown?: unknown } = { name };
        flows.push(f);
        return Promise.resolve(fn({ set: () => {} })).catch((err) => { f.thrown = err; throw err; });
      },
      step: (_n: string, fn: (s: unknown) => unknown) => fn({ set: () => {} }),
      count: vi.fn(),
      event: vi.fn(),
      exception: vi.fn(),
    } as unknown as TelemetryRuntime);
    await expect(startDurableCreation(PROJECT_PATH, { name: 'x', color: 'indigo', branchName: '-bad' })).rejects.toThrow(/branch name/);
    const { errorTypeOf } = await import('../telemetry/types');
    expect(flows).toHaveLength(1);
    expect(errorTypeOf(flows[0].thrown)).toBe('validation');
  });
});

describe('helpers (#2224) created asynchronously', () => {
  it('persists parentAgentId and disposable on the new agent', async () => {
    const orch = await createDurable(PROJECT_PATH, 'orch', 'indigo');
    const started = await startDurableCreation(PROJECT_PATH, { name: 'helper', color: 'indigo', parentAgentId: orch.id, disposable: true });
    expect(started.config).toMatchObject({ parentAgentId: orch.id, disposable: true });
    expect(await started.done).toBe('ready');
    expect((await listDurable(PROJECT_PATH)).find((a) => a.id === started.agentId)).toMatchObject({ parentAgentId: orch.id, disposable: true });
  });

  it('refuses an unknown parent before anything is created', async () => {
    await expect(startDurableCreation(PROJECT_PATH, { name: 'orphan', color: 'indigo', parentAgentId: 'durable_9_nope' }))
      .rejects.toThrow(/Parent agent not found/);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('disposing a helper mid-create cancels the creation and settles it first', async () => {
    const orch = await createDurable(PROJECT_PATH, 'orch', 'indigo');
    vi.mocked(execFile).mockClear();
    const slow = slowWorktreeAdd();
    const started = await startDurableCreation(PROJECT_PATH, { name: 'helper', color: 'indigo', parentAgentId: orch.id, disposable: true });
    await slow.reached;

    const result = await disposeHelper(PROJECT_PATH, started.agentId);
    expect(result.ok).toBe(true);
    expect(await started.done).toBe('cancelled');
    expect(dirs.has(agentPath('helper'))).toBe(false);
    expect(branchDeletes()).toEqual([['branch', '-D', '--', 'helper/standby']]);
    expect((await listDurable(PROJECT_PATH)).map((a) => a.id)).toEqual([orch.id]);
  });

  it('the delete cascade cancels a helper that is still being created', async () => {
    const orch = await createDurable(PROJECT_PATH, 'orch', 'indigo');
    const slow = slowWorktreeAdd();
    const started = await startDurableCreation(PROJECT_PATH, { name: 'helper', color: 'indigo', parentAgentId: orch.id, disposable: true });
    await slow.reached;

    const result = await resolveHelpersForDelete(PROJECT_PATH, orch.id, 'dispose');
    expect(result).toMatchObject({ ok: true, helperIds: [started.agentId] });
    expect(await started.done).toBe('cancelled');
    expect(dirs.has(agentPath('helper'))).toBe(false);
  });
});

describe('helpers in another project (#2511)', () => {
  const PARENT_PROJECT = path.resolve('test-parent-project');

  it('looks the parent up in its own project and records that project on the helper', async () => {
    const orch = await createDurable(PARENT_PROJECT, 'orch', 'indigo');
    const params = { name: 'helper', color: 'indigo', parentAgentId: orch.id, parentProjectPath: PARENT_PROJECT, disposable: true };
    await expect(checkDurableCreation(PROJECT_PATH, params)).resolves.toBeUndefined();
    const started = await startDurableCreation(PROJECT_PATH, params);
    expect(await started.done).toBe('ready');
    expect(diskAgents().find((a) => a.id === started.agentId))
      .toMatchObject({ parentAgentId: orch.id, parentProjectPath: PARENT_PROJECT, disposable: true });
  });

  it('refuses a parent missing from the named project, even when the target has it', async () => {
    const orch = await createDurable(PROJECT_PATH, 'orch', 'indigo');
    const params = { name: 'helper', color: 'indigo', parentAgentId: orch.id, parentProjectPath: PARENT_PROJECT };
    await expect(checkDurableCreation(PROJECT_PATH, params)).rejects.toThrow(/Parent agent not found/);
    await expect(startDurableCreation(PROJECT_PATH, params)).rejects.toThrow(/Parent agent not found/);
  });

  it('treats a parent project that is the target project as the same project', async () => {
    const orch = await createDurable(PROJECT_PATH, 'orch', 'indigo');
    const started = await startDurableCreation(PROJECT_PATH, {
      name: 'helper', color: 'indigo', parentAgentId: orch.id, parentProjectPath: path.join(PROJECT_PATH, '.'),
    });
    expect(await started.done).toBe('ready');
    const row = diskAgents().find((a) => a.id === started.agentId);
    expect(row?.parentAgentId).toBe(orch.id);
    expect(row).not.toHaveProperty('parentProjectPath');
  });
});

describe('persona ids (#2511)', () => {
  it('refuses an unknown persona id by name, before anything is created', async () => {
    const params = { name: 'agent', color: 'indigo', persona: 'no-such-persona' };
    await expect(checkDurableCreation(PROJECT_PATH, params)).rejects.toThrow(/Unknown persona "no-such-persona"/);
    await expect(startDurableCreation(PROJECT_PATH, params)).rejects.toThrow(/Unknown persona "no-such-persona"/);
    await expect(createDurable(PROJECT_PATH, 'agent', 'indigo', undefined, true, undefined, undefined, undefined, undefined, 'no-such-persona'))
      .rejects.toThrow(/Unknown persona/);
    expect(execFile).not.toHaveBeenCalled();
    expect(diskAgents()).toEqual([]);
  });

  it('accepts a built-in persona id', async () => {
    const params = { name: 'agent', color: 'indigo', persona: 'qa' };
    await expect(checkDurableCreation(PROJECT_PATH, params)).resolves.toBeUndefined();
    const started = await startDurableCreation(PROJECT_PATH, params);
    expect(await started.done).toBe('ready');
    expect(diskAgents().find((a) => a.id === started.agentId)?.persona).toBe('qa');
  });

  it('accepts a persona defined in the project', async () => {
    files.set(path.join(PROJECT_PATH, '.clubhouse', 'personas', 'house-style.md'), '# House style');
    await expect(checkDurableCreation(PROJECT_PATH, { name: 'agent', color: 'indigo', persona: 'house-style' })).resolves.toBeUndefined();
  });
});

describe('interrupted creation recovery (#2226)', () => {
  const creatingRecord = (overrides: Partial<DurableAgentConfig> = {}, creation: Partial<DurableAgentCreation> = {}): DurableAgentConfig => ({
    id: 'durable_1_crash',
    name: 'crashed',
    color: 'indigo',
    branch: 'crashed/standby',
    worktreePath: agentPath('crashed'),
    createdAt: '2026-10-18T00:00:00.000Z',
    branchOwned: true,
    branchStartSha: SHA,
    creation: { state: 'creating', startedAt: '2026-10-18T00:00:00.000Z', stage: 'config_created', folderOwned: true, owner: { pid: DEAD_PID, instanceId: 'gone' }, ...creation },
    ...overrides,
  });

  it('cleans up a creation a quit interrupted before the first list, and reports it failed', async () => {
    files.set(CONFIG_PATH, JSON.stringify([creatingRecord()]));
    dirs.add(agentPath('crashed'));

    const [listed] = await listDurable(PROJECT_PATH);
    expect(listed.creation).toMatchObject({ state: 'failed', reason: INTERRUPTED_CREATION_REASON });
    expect(listed.worktreePath).toBeUndefined();
    expect(listed.branch).toBeUndefined();
    expect(listed.creation).not.toHaveProperty('owner');
    expect(dirs.has(agentPath('crashed'))).toBe(false);
    expect(gitArgv()).toContainEqual(['worktree', 'remove', '--force', '--', agentPath('crashed')]);
    expect(gitArgv().some((a) => a[0] === 'worktree' && a[1] === 'prune')).toBe(false);
    expect(branchDeletes()).toEqual([['branch', '-D', '--', 'crashed/standby']]);
    expect(events).toEqual([expect.objectContaining({ agentId: 'durable_1_crash', stage: 'failed', reason: INTERRUPTED_CREATION_REASON })]);
    await flushAgentConfig(PROJECT_PATH);
    expect(diskAgents()[0].creation?.state).toBe('failed');
  });

  it('keeps a branch the interrupted creation did not make', async () => {
    files.set(CONFIG_PATH, JSON.stringify([creatingRecord({ branchOwned: false, branchStartSha: undefined })]));
    await listDurable(PROJECT_PATH);
    expect(branchDeletes()).toEqual([]);
  });

  it('never deletes a recorded folder outside .clubhouse/agents/', async () => {
    const outside = path.join(PROJECT_PATH, 'src');
    dirs.add(outside);
    files.set(CONFIG_PATH, JSON.stringify([creatingRecord({ worktreePath: outside })]));
    await listDurable(PROJECT_PATH);
    expect(dirs.has(outside)).toBe(true);
    expect(fsp.rm).not.toHaveBeenCalledWith(outside, expect.anything());
  });

  it('leaves alone a creation another live Clubhouse instance is running (H3)', async () => {
    files.set(CONFIG_PATH, JSON.stringify([creatingRecord({}, {
      owner: { pid: process.ppid, instanceId: 'other-instance' }, heartbeatAt: new Date().toISOString(),
    })]));
    dirs.add(agentPath('crashed'));
    const [listed] = await listDurable(PROJECT_PATH);
    expect(listed.creation?.state).toBe('creating');
    expect(dirs.has(agentPath('crashed'))).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('treats a creation stamped with this process id but another instance id as interrupted', async () => {
    files.set(CONFIG_PATH, JSON.stringify([creatingRecord({}, {
      owner: { pid: process.pid, instanceId: 'earlier-instance' }, heartbeatAt: new Date().toISOString(),
    })]));
    const [listed] = await listDurable(PROJECT_PATH);
    expect(listed.creation?.state).toBe('failed');
  });

  it('never deletes a folder the interrupted creation had not claimed', async () => {
    files.set(CONFIG_PATH, JSON.stringify([creatingRecord({}, { folderOwned: undefined })]));
    dirs.add(agentPath('crashed'));
    const [listed] = await listDurable(PROJECT_PATH);
    expect(listed.creation?.state).toBe('failed');
    expect(dirs.has(agentPath('crashed'))).toBe(true);
    expect(gitArgv().some((a) => a[0] === 'worktree' && a[1] === 'remove')).toBe(false);
  });

  it('recovers a live instance\'s creation once its heartbeat is stale (H3)', async () => {
    files.set(CONFIG_PATH, JSON.stringify([creatingRecord({}, {
      owner: { pid: process.ppid, instanceId: 'other-instance' }, heartbeatAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    })]));
    const [listed] = await listDurable(PROJECT_PATH);
    expect(listed.creation?.state).toBe('failed');
  });

  it('runs once per project per launch, not on every reload of agents.json (H3)', async () => {
    files.set(CONFIG_PATH, JSON.stringify([]));
    await listDurable(PROJECT_PATH);
    // Another instance writes a creating record; the watcher drops our cache.
    files.set(CONFIG_PATH, JSON.stringify([creatingRecord()]));
    clearAgentConfigCache(PROJECT_PATH);
    const [listed] = await listDurable(PROJECT_PATH);
    expect(listed.creation?.state).toBe('creating');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('leaves a creation running in this process alone', async () => {
    const slow = slowWorktreeAdd();
    const started = await startDurableCreation(PROJECT_PATH, { name: 'live', color: 'indigo' });
    await slow.reached;
    expect(await recoverInterruptedCreations(PROJECT_PATH)).toEqual([]);
    slow.release();
    expect(await started.done).toBe('ready');
  });
});
