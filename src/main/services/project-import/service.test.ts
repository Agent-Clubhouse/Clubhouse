import { afterAll, afterEach, beforeAll, beforeEach as rawBeforeEach, describe, expect, it as rawIt, onTestFailed, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawn } from 'child_process';
import type { Project } from '../../../shared/types';
import { CheckpointFixtureLifetime } from '../../../../test/checkpoint-fixture-lifetime';
import { ownedRegistration, preservingFailure } from '../../../../test/dispatcher-work-owner';

const lifetime = vi.hoisted(() => ({
  current: undefined as CheckpointFixtureLifetime | undefined,
  closing: false,
  controllers: new Set<AbortController>(),
  releases: [] as Array<() => void>,
  restores: [] as Array<() => void>,
  directories: [] as string[],
  ignores: new Map<string, typeof import('../agent-config').ensureGitignore>(),
}));

const temp = vi.hoisted(() => {
  const f = require('fs') as typeof import('fs');
  const p = require('path') as typeof import('path');
  const o = require('os') as typeof import('os');
  const root = f.realpathSync.native(f.mkdtempSync(p.join(o.tmpdir(), 'project-import-')));
  return { root, base: p.join(root, 'app') };
});
const executions = vi.hoisted(() => ({
  active: false, blocked: [] as string[],
  denied: [] as Array<{ api: string; command: string }>,
  allowed: [] as Array<{ api: string; command: string }>,
}));

vi.mock('child_process', async (original) => {
  const child = await original<typeof import('child_process')>();
  const { ownCheckpointExecFile } = await import('../../../../test/checkpoint-fixture-lifetime');
  const paths = await import('path');
  const key = (command: string) => process.platform === 'win32' ? paths.normalize(command).toLowerCase() : paths.normalize(command);
  const admit = (api: string, command: string) => {
    if (!executions.active) return;
    if (executions.blocked.some((blocked) => key(blocked) === key(command))) {
      executions.denied.push({ api, command });
      throw new Error('test-only untrusted Git admission');
    }
    executions.allowed.push({ api, command });
  };
  return {
    ...child,
    execFile: ownCheckpointExecFile(child.execFile, () => lifetime.current),
    spawn: (...args: Parameters<typeof child.spawn>) => { admit('spawn', args[0]); return child.spawn(...args); },
    execFileSync: (...args: Parameters<typeof child.execFileSync>) => { admit('execFileSync', args[0]); return child.execFileSync(...args); },
  };
});
vi.mock('../base-dir', () => ({ getBaseDirPath: () => temp.base }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../badge-settings', () => ({ getSettings: () => ({}), saveSettings: vi.fn() }));
vi.mock('../sound-service', () => ({ getSettings: () => ({}), saveSettings: vi.fn() }));
vi.mock('../agent-config', () => ({
  ensureGitignore: vi.fn((folder: string, guard?: () => void) => {
    const implementation = lifetime.ignores.get(folder);
    if (!implementation || !lifetime.current) throw new Error('Ignore write has no destination-bound fixture owner');
    return lifetime.current.observeDirect(implementation(folder, guard));
  }),
}));

import { ProjectImportService, type ImportAuthorization } from './service';
import { ImportStore } from './store';
import { createImportGit, importGitEnvironment, parseRemoteIdentity, type ImportGit } from './git';
import { ACTIVE_PHASES, ImportError, type ImportReceipt } from './types';
import * as projectStore from '../project-store';
import { registerProjectFolder } from '../project-add';
import { ensureGitignore } from '../agent-config';

function owner(): CheckpointFixtureLifetime {
  if (!lifetime.current) throw new Error('Import fixture is missing');
  return lifetime.current;
}
const it = ownedRegistration(rawIt, 1, (promise) => { owner().observeRaw(promise); });
const beforeEach = ownedRegistration(rawBeforeEach, 0, (promise) => { owner().observeRaw(promise); });

// start() intentionally detaches perform(). Capture that full causal root, not
// just its terminal store update, without changing production or its scheduling.
const performDescriptor = Object.getOwnPropertyDescriptor(ProjectImportService.prototype, 'perform');
if (!performDescriptor || typeof performDescriptor.value !== 'function') throw new Error('Import job observation is unavailable');
Object.defineProperty(ProjectImportService.prototype, 'perform', {
  ...performDescriptor,
  value: new Proxy(performDescriptor.value, {
    apply(target, receiver, args: unknown[]) {
      const controller = args[1];
      if (!(controller instanceof AbortController)) throw new Error('Import job has no owned controller');
      const current = owner();
      lifetime.controllers.add(controller);
      if (lifetime.closing) controller.abort();
      const result: unknown = Reflect.apply(target, receiver, args);
      if (!(result instanceof Promise)) throw new Error('Import job has no completion promise');
      return current.observeDirect(result);
    },
  }),
});

let n = 0;
let caseNumber = 0;
const environment = () => ({ PATH: process.env.PATH, HOME: temp.root, USERPROFILE: temp.root, XDG_CONFIG_HOME: path.join(temp.root, 'xdg') });
const fixtureConfig = path.join(temp.root, 'empty.config');
fs.writeFileSync(fixtureConfig, '', { flag: 'wx', mode: 0o600 });
const fixturePath = (process.env.PATH ?? '').split(path.delimiter).filter((directory) => path.isAbsolute(directory));
const gitProgram = process.platform === 'win32' ? 'git.exe' : 'git';
const fixtureCandidate = fixturePath.map((directory) => path.join(directory, gitProgram)).find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
if (!fixtureCandidate) throw new Error('The fixture requires Git in the existing absolute PATH');
const fixtureBinary = fs.realpathSync.native(fixtureCandidate);
const fixtureEnv = importGitEnvironment({ ...environment(), PATH: fixturePath.join(path.delimiter) }, fixtureConfig);
const git = (cwd: string, ...args: string[]) => execFileSync(fixtureBinary, ['-c', 'protocol.file.allow=always', ...args], { cwd, env: fixtureEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const assertCurrent = async (): Promise<void> => {};
const authorized: ImportAuthorization = vi.fn(async () => ({ kind: 'approved', assertCurrent }));
const projects: Project[] = [];
const terminalUpdates = new Map<string, { promise: Promise<void>; resolve: () => void }>();
const seed = path.join(temp.root, 'source-baseline');
let seedCommit: string;
let actualEnsureGitignore: typeof ensureGitignore;

beforeAll(async () => {
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '--initial-branch=trunk', '--template=');
  fs.writeFileSync(path.join(seed, 'readme.txt'), 'hello\n');
  git(seed, 'add', '.');
  git(seed, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '-qm', 'initial');
  seedCommit = git(seed, 'rev-parse', 'HEAD');
  actualEnsureGitignore = (await vi.importActual<typeof import('../agent-config')>('../agent-config')).ensureGitignore;
});

function realRegistration(f: ReturnType<typeof fixture>): void {
  lifetime.ignores.set(f.destination, actualEnsureGitignore);
  f.service = new ProjectImportService({ store: f.store, git: f.runner, listProjects: async () => [], register: registerProjectFolder });
}

function gitAdmission(source: string, destination: string) {
  executions.active = true;
  executions.blocked = [source, destination, 'git', 'git.exe'];
  return {
    // This observes pre-launch admission, not native launchability of Windows script bytes.
    probe: (file: string) => {
      expect(fs.lstatSync(file).isFile()).toBe(true);
      expect(() => spawn(file, ['--version'])).toThrow('test-only untrusted Git admission');
      expect(() => execFileSync(file, ['--version'])).toThrow('test-only untrusted Git admission');
      expect(executions.denied).toEqual([{ api: 'spawn', command: file }, { api: 'execFileSync', command: file }]);
      executions.denied.length = 0;
      executions.allowed.length = 0;
    },
    verify: () => {
      expect(executions.denied).toEqual([]);
      const observed = executions.allowed.filter((call) => call.api === 'spawn');
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((call) => path.isAbsolute(call.command))).toBe(true);
    },
    close: () => { executions.active = false; },
  };
}

function fixture(sourceEnvironment = environment) {
  const work = path.join(temp.root, `case-${++n}`);
  lifetime.directories.push(work);
  const source = path.join(work, 'source');
  fs.cpSync(seed, source, { recursive: true });
  const commit = seedCommit;
  const destination = path.join(work, 'imported');
  const url = 'https://github.com/example/repository.git';
  const safeGit = createImportGit(sourceEnvironment);
  const runner: ImportGit = {
    remote: vi.fn(async (remote, branch) => parseRemoteIdentity(remote, git(source, 'ls-remote', '--symref', source, 'HEAD', 'refs/heads/*'), branch)),
    run: vi.fn(async (args, options) => {
      // Only this test adapter permits local fixture transport. Production never enables file://.
      if (args[0] === 'fetch') {
        args = ['-c', 'protocol.file.allow=always', ...args.map((arg) => arg === 'origin' ? source : arg)];
      }
      return safeGit.run(args, options);
    }),
  };
  const store = new ImportStore(path.join(work, 'state.json'));
  const update = store.update.bind(store);
  vi.spyOn(store, 'update').mockImplementation(async (fn) => {
    const state = await update(fn);
    for (const receipt of state.receipts) {
      let terminal = terminalUpdates.get(receipt.id);
      if (!terminal) {
        let resolve!: () => void;
        const promise = new Promise<void>((complete) => { resolve = complete; });
        terminal = { promise, resolve };
        terminalUpdates.set(receipt.id, terminal);
      }
      if (!ACTIVE_PHASES.has(receipt.phase)) terminal.resolve();
    }
    return state;
  });
  const register = vi.fn(async (folder: string) => {
    const project: Project = { id: `proj_${n}`, name: path.basename(folder), path: folder };
    projects.push(project);
    return { project, created: true, gitignore: 'updated' as const };
  });
  const listProjects = vi.fn(async () => projects);
  const service = new ProjectImportService({ store, git: runner, listProjects, origin: async () => url, register, reserveMembership: vi.fn(async () => {}) });
  return { service, store, runner, register, source, destination, url, commit, work, listProjects };
}

async function preview(f: ReturnType<typeof fixture>) {
  const result = await f.service.preview('dispatcher', { url: f.url, destination: f.destination });
  if (result.status !== 'ready') throw new Error('expected ready');
  return result.plan;
}

async function start(f: ReturnType<typeof fixture>, approval = authorized) {
  const plan = await preview(f);
  const result = await f.service.start('dispatcher', plan.id, plan.destination, approval);
  if (!('receipt' in result)) throw new Error('expected receipt');
  return { plan, receipt: result.receipt };
}

async function finished(service: ProjectImportService, id: string): Promise<Awaited<ReturnType<ProjectImportService['status']>>> {
  const terminal = terminalUpdates.get(id);
  if (!terminal) throw new Error('Import has no persisted receipt/completion observable');
  let persisted = false;
  onTestFailed(async () => {
    if (persisted) return;
    const receipt = await service.status('dispatcher', id);
    console.error(`Import did not persist a terminal outcome before the test deadline: phase=${receipt.phase}, reason=${receipt.reason ?? 'none'}`);
  });
  await terminal.promise;
  persisted = true;
  return service.status('dispatcher', id);
}

beforeEach(() => {
  lifetime.current?.assertRetired();
  lifetime.current = new CheckpointFixtureLifetime();
  lifetime.closing = false;
  lifetime.controllers.clear();
  lifetime.releases = [];
  lifetime.restores = [];
  lifetime.directories = [];
  lifetime.ignores.clear();
  temp.base = path.join(temp.root, `registry-${++caseNumber}`);
  lifetime.directories.push(temp.base);
  projects.length = 0;
  terminalUpdates.clear();
  executions.active = false;
  executions.denied.length = 0;
  executions.allowed.length = 0;
  vi.mocked(authorized).mockResolvedValue({ kind: 'approved', assertCurrent });
});

function stopImports(): void {
  lifetime.closing = true;
  for (const controller of lifetime.controllers) controller.abort();
  for (const release of lifetime.releases) release();
}

function settleImports(): Promise<void> {
  stopImports();
  return owner().settleEpoch(() => Promise.resolve());
}

afterEach(async () => {
  const directories = lifetime.directories;
  const restores = lifetime.restores;
  stopImports();
  await owner().close(() => Promise.resolve(), () => {
    for (const restore of restores) restore();
    lifetime.ignores.clear();
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  });
});

afterAll(() => {
  lifetime.current?.assertRetired();
  Object.defineProperty(ProjectImportService.prototype, 'perform', performDescriptor);
  fs.rmSync(temp.root, { recursive: true, force: true });
});

describe('bounded import user flow using isolated real Git fixtures', () => {
  it('previews actual trunk/tip without a checkout, reuses the same preview and requires a real approval decision', async () => {
    const f = fixture();
    const first = await preview(f);
    const again = await preview(f);
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ branch: 'trunk', defaultBranch: 'trunk', commit: f.commit, destination: f.destination });
    expect(fs.existsSync(f.destination)).toBe(false);
    const ask: ImportAuthorization = vi.fn(async () => ({ kind: 'asked', text: 'Needs you' }));
    expect(await f.service.start('dispatcher', first.id, first.destination, ask)).toEqual({ status: 'approval_required', message: 'Needs you' });
    expect(ask).toHaveBeenCalledWith(first);
    expect(fs.existsSync(f.destination)).toBe(false);
    expect(f.register).not.toHaveBeenCalled();
  });

  it('downloads the approved tip, registers once, reports no agent creation/start and returns the receipt on repeat', async () => {
    const f = fixture();
    const { plan, receipt } = await start(f);
    const result = await finished(f.service, receipt.id);
    expect(result).toMatchObject({ phase: 'completed', cloneCompleted: true, projectId: `proj_${n}`, agentCreated: false, agentStarted: false });
    expect(fs.readFileSync(path.join(f.destination, 'readme.txt'), 'utf8')).toBe('hello\n');
    expect(git(f.destination, 'rev-parse', 'HEAD')).toBe(f.commit);
    expect(git(f.destination, 'symbolic-ref', '--short', 'HEAD')).toBe('trunk');
    expect(git(f.destination, 'config', '--get', 'remote.origin.url')).toBe(f.url);
    expect(f.register).toHaveBeenCalledTimes(1);
    const again = await f.service.start('dispatcher', plan.id, plan.destination, authorized);
    expect(again.status).toBe('existing_import');
    expect('receipt' in again && again.receipt.id).toBe(receipt.id);
    expect(authorized).toHaveBeenCalledTimes(1);
    expect(f.register).toHaveBeenCalledTimes(1);
  });

  it('uses the existing project registration implementation and preserves the registered id on ignore-rule failure', async () => {
    const f = fixture();
    lifetime.ignores.set(f.destination, async () => { throw new Error('unwritable'); });
    const service = new ProjectImportService({ store: f.store, git: f.runner, listProjects: projectStore.list, register: registerProjectFolder });
    const planResult = await service.preview('dispatcher', { url: f.url, destination: f.destination });
    if (planResult.status !== 'ready') throw new Error('expected ready');
    const started = await service.start('dispatcher', planResult.plan.id, f.destination, authorized);
    if (!('receipt' in started)) throw new Error('expected receipt');
    const result = await finished(service, started.receipt.id);
    expect(result).toMatchObject({ phase: 'partial', cloneCompleted: true, gitignore: 'failed', reason: 'gitignore_failed', agentCreated: false });
    expect(result.projectId).toMatch(/^proj_/);
    expect(await projectStore.findByPath(f.destination)).toMatchObject({ id: result.projectId });
    const again = await service.start('dispatcher', planResult.plan.id, f.destination, authorized);
    expect('receipt' in again && again.receipt.projectId).toBe(result.projectId);
  });

  it('preserves completed checkout and precise partial recovery when project registration fails', async () => {
    const f = fixture();
    f.register.mockRejectedValueOnce(new Error('private diagnostic must not escape'));
    const { receipt } = await start(f);
    const result = await finished(f.service, receipt.id);
    expect(result).toMatchObject({ phase: 'partial', cloneCompleted: true, failedAt: 'registering', reason: 'operation_failed' });
    expect(result.projectId).toBeUndefined();
    expect(result.recovery).toContain('add_project');
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
    expect(fs.readFileSync(path.join(f.destination, 'readme.txt'), 'utf8')).toBe('hello\n');
  });

  it('uses an explicitly chosen existing branch without changing the advertised default', async () => {
    const f = fixture();
    git(f.source, 'branch', 'release/stable');
    const result = await f.service.preview('dispatcher', { url: f.url, destination: f.destination, branch: 'release/stable' });
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(result.plan).toMatchObject({ branch: 'release/stable', defaultBranch: 'trunk' });
    const started = await f.service.start('dispatcher', result.plan.id, f.destination, authorized);
    if (!('receipt' in started)) throw new Error('expected receipt');
    expect(await finished(f.service, started.receipt.id)).toMatchObject({ phase: 'completed', cloneCompleted: true });
    expect(git(f.destination, 'symbolic-ref', '--short', 'HEAD')).toBe('release/stable');
  });

  it('refuses another caller’s status, cancellation, preview reuse and import receipt', async () => {
    const f = fixture();
    const { plan, receipt } = await start(f);
    await finished(f.service, receipt.id);
    await expect(f.service.status('different-agent', receipt.id)).rejects.toMatchObject({ reason: 'import_not_found' });
    await expect(f.service.cancel('different-agent', receipt.id, f.destination)).rejects.toMatchObject({ reason: 'import_not_found' });
    await expect(f.service.start('different-agent', plan.id, plan.destination, authorized)).rejects.toMatchObject({ reason: 'plan_mismatch' });
  });
});

describe('approval and placement change invalidation', () => {
  it('refuses model-changed destination and another caller before approval', async () => {
    const f = fixture();
    const plan = await preview(f);
    await expect(f.service.start('dispatcher', plan.id, `${f.destination}-other`, authorized)).rejects.toMatchObject({ reason: 'plan_mismatch' });
    await expect(f.service.start('other', plan.id, f.destination, authorized)).rejects.toMatchObject({ reason: 'plan_mismatch' });
    expect(authorized).not.toHaveBeenCalled();
    expect(fs.existsSync(f.destination)).toBe(false);
  });

  it('refuses a new destination conflict created during approval and preserves its content', async () => {
    const f = fixture();
    const plan = await preview(f);
    const approval: ImportAuthorization = async () => {
      fs.mkdirSync(f.destination);
      fs.writeFileSync(path.join(f.destination, 'user.txt'), 'keep');
      return { kind: 'approved', assertCurrent };
    };
    await expect(f.service.start('dispatcher', plan.id, f.destination, approval)).rejects.toMatchObject({ reason: 'destination_exists' });
    expect(fs.readFileSync(path.join(f.destination, 'user.txt'), 'utf8')).toBe('keep');
    expect(f.register).not.toHaveBeenCalled();
  });

  it('refuses changed remote tip after approval without creating a directory', async () => {
    const f = fixture();
    const plan = await preview(f);
    const approval: ImportAuthorization = async () => {
      fs.writeFileSync(path.join(f.source, 'readme.txt'), 'changed');
      git(f.source, 'add', '.');
      git(f.source, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '-qm', 'changed');
      return { kind: 'approved', assertCurrent };
    };
    await expect(f.service.start('dispatcher', plan.id, f.destination, approval)).rejects.toMatchObject({ reason: 'remote_changed' });
    expect(fs.existsSync(f.destination)).toBe(false);
  });

  it('refuses a changed advertised default branch even when the selected commit is unchanged', async () => {
    const f = fixture();
    const plan = await preview(f);
    git(f.source, 'branch', 'next');
    git(f.source, 'symbolic-ref', 'HEAD', 'refs/heads/next');
    await expect(f.service.start('dispatcher', plan.id, f.destination, authorized)).rejects.toMatchObject({ reason: 'remote_changed' });
    expect(authorized).not.toHaveBeenCalled();
    expect(fs.existsSync(f.destination)).toBe(false);
  });

  it('refuses expired previews before asking', async () => {
    const f = fixture();
    const plan = await preview(f);
    const later = new ProjectImportService({ store: f.store, git: f.runner, now: () => plan.expiresAt, listProjects: async () => [] });
    await expect(later.start('dispatcher', plan.id, f.destination, authorized)).rejects.toMatchObject({ reason: 'plan_expired' });
    expect(authorized).not.toHaveBeenCalled();
  });

  it('detects a changed canonical parent identity after approval', async () => {
    const f = fixture();
    const parent = path.join(f.work, 'parent');
    fs.mkdirSync(parent);
    const result = await f.service.preview('dispatcher', { url: f.url, destination: path.join(parent, 'repo') });
    if (result.status !== 'ready') throw new Error('expected ready');
    const approval: ImportAuthorization = async () => {
      fs.renameSync(parent, `${parent}-old`);
      fs.mkdirSync(parent);
      return { kind: 'approved', assertCurrent };
    };
    await expect(f.service.start('dispatcher', result.plan.id, result.plan.destination, approval)).rejects.toMatchObject({ reason: 'placement_changed' });
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it('reuses an existing registered repository instead of cloning another copy', async () => {
    const f = fixture();
    projects.push({ id: 'proj_existing', name: 'Existing', path: f.source });
    const result = await f.service.preview('dispatcher', { url: f.url, destination: f.destination });
    expect(result).toMatchObject({ status: 'existing_project', projectId: 'proj_existing' });
    expect(f.runner.remote).not.toHaveBeenCalled();
    expect(fs.existsSync(f.destination)).toBe(false);
  });

  it.each(['existing-empty', 'existing-content', 'symlink'])('never repurposes an %s destination', async (kind) => {
    const f = fixture();
    if (kind === 'symlink') fs.symlinkSync(f.source, f.destination, 'junction');
    else {
      fs.mkdirSync(f.destination);
      if (kind === 'existing-content') fs.writeFileSync(path.join(f.destination, 'user.txt'), 'keep');
    }
    await expect(preview(f)).rejects.toMatchObject({ reason: 'destination_exists' });
    expect(f.runner.remote).not.toHaveBeenCalled();
    expect(fs.existsSync(f.destination)).toBe(true);
  });

  it.each(['relative/path', '/tmp/.clubhouse/agents/repo', '/tmp/.clubhouse-dev/repo'])('refuses unsafe placement %s before network access', async (destination) => {
    const f = fixture();
    await expect(f.service.preview('dispatcher', { url: f.url, destination })).rejects.toBeInstanceOf(ImportError);
    expect(f.runner.remote).not.toHaveBeenCalled();
  });
});

describe('QA engine regressions with real Git and harmless isolated markers', () => {
  it('keeps a late previous registration from consuming another destination\'s real ignore writer', async () => {
    const previous = fixture();
    const next = fixture();
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    lifetime.releases.push(release);
    lifetime.ignores.set(previous.source, async () => { throw new Error('previous destination refused'); });
    lifetime.ignores.set(next.source, actualEnsureGitignore);
    const late = owner().observeDirect(registerProjectFolder(previous.source, {
      beforeGitignore: async () => { entered(); await paused; }, assertSafe: () => {},
    }));
    await preservingFailure(async () => {
      await Promise.race([ready, late.then(() => { throw new Error('Previous registration settled before its gate'); })]);
      const result = await registerProjectFolder(next.source, { beforeGitignore: assertCurrent, assertSafe: () => {} });
      expect(result).toMatchObject({ created: true, gitignore: 'updated' });
      expect(fs.readFileSync(path.join(next.source, '.gitignore'), 'utf8')).toContain('.clubhouse/agents/');
      release();
      expect(await late).toMatchObject({ created: true, gitignore: 'failed' });
      expect(fs.existsSync(path.join(previous.source, '.gitignore'))).toBe(false);
      expect(vi.mocked(ensureGitignore).mock.calls.map(([folder]) => folder)).toEqual([next.source, previous.source]);
      expect(fs.readFileSync(path.join(previous.source, 'readme.txt'), 'utf8')).toBe('hello\n');
    }, async () => { release(); await late; });
  });

  it('drains a detached approved job before permitting registry removal after its caller stops waiting', async () => {
    const f = fixture();
    realRegistration(f);
    fs.mkdirSync(temp.base);
    const marker = path.join(temp.base, 'keep.txt');
    fs.writeFileSync(marker, 'owned registry bytes\n');
    let checks = 0;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    lifetime.releases.push(release);
    const approval: ImportAuthorization = async () => ({
      kind: 'approved',
      assertCurrent: async () => { if (++checks === 2) { entered(); await paused; } },
    });
    const { receipt } = await start(f, approval);
    const terminal = terminalUpdates.get(receipt.id);
    if (!terminal) throw new Error('Detached job has no terminal persistence observable');
    await preservingFailure(async () => {
      await Promise.race([ready, terminal.promise.then(() => { throw new Error('Detached job settled before its gate'); })]);
      expect(owner().evidence().teardown.directPending).toBeGreaterThan(0);
      expect(() => owner().mutateEpoch(() => { fs.rmSync(temp.base, { recursive: true }); })).toThrow('accounting is incomplete');
      expect(fs.readFileSync(marker, 'utf8')).toBe('owned registry bytes\n');
      await settleImports();
      expect(await f.service.status('dispatcher', receipt.id)).toMatchObject({ phase: 'cancelled', cloneCompleted: false });
      expect(fs.existsSync(f.destination)).toBe(false);
      expect(ensureGitignore).not.toHaveBeenCalled();
      const late = fixture();
      const admitted = await start(late);
      expect(await finished(late.service, admitted.receipt.id)).toMatchObject({ phase: 'cancelled', cloneCompleted: false });
      expect(fs.existsSync(late.destination)).toBe(false);
      await settleImports();
      owner().mutateEpoch(() => { fs.rmSync(temp.base, { recursive: true }); });
      expect(fs.existsSync(temp.base)).toBe(false);
    }, async () => { await settleImports(); await terminal.promise; });
  });

  it('awaits actual terminal persistence while a completed Git status callback remains pending beyond 300 polling turns', async () => {
    const f = fixture();
    let release!: () => void;
    let reached!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    lifetime.releases.push(() => { vi.useRealTimers(); release(); });
    const statusCompleted = new Promise<void>((resolve) => { reached = resolve; });
    const run = f.runner.run;
    f.runner.run = vi.fn(async (args, options) => {
      const result = await run(args, options);
      if (args[0] === 'status') { reached(); await blocked; }
      return result;
    });
    const { receipt } = await start(f);
    const terminalSaved = terminalUpdates.get(receipt.id);
    if (!terminalSaved) throw new Error('Import has no persisted receipt/completion observable');
    await statusCompleted;
    expect(await f.service.status('dispatcher', receipt.id)).toMatchObject({ phase: 'cloned', cloneCompleted: true });
    vi.useFakeTimers();
    let outcome = 'pending';
    const waiting = finished(f.service, receipt.id).then(
      (result) => { outcome = 'finished'; return result; },
      (error: unknown) => { outcome = 'rejected'; return error; },
    );
    try {
      await vi.advanceTimersByTimeAsync(3_100);
      expect(outcome).toBe('pending');
    } finally {
      vi.useRealTimers();
      release();
      await terminalSaved.promise;
    }
    expect(await waiting).toMatchObject({ phase: 'completed', cloneCompleted: true });
    expect(f.register).toHaveBeenCalledOnce();
  });

  it('skips inherited script shims instead of treating an absolute wrapper path as a native Git pin', async () => {
    let wrapper = '';
    const f = fixture(() => ({ ...environment(), PATH: `${wrapper}${path.delimiter}${fixtureEnv.PATH ?? ''}` }));
    wrapper = f.source;
    const marker = path.join(f.work, 'executed-wrapper');
    const program = path.join(wrapper, gitProgram);
    fs.writeFileSync(program, `#!/bin/sh\nprintf ran > '${marker}'\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
    const admission = gitAdmission(program, path.join(f.destination, gitProgram));
    try {
      admission.probe(program);
      const { receipt } = await start(f);
      expect(await finished(f.service, receipt.id)).toMatchObject({ phase: 'completed', cloneCompleted: true });
      expect(fs.existsSync(marker)).toBe(false);
      expect(f.register).toHaveBeenCalledOnce();
      admission.verify();
    } finally { admission.close(); }
  });

  it('does not execute a checked-out git program through a cwd-relative inherited PATH', async () => {
    const f = fixture(() => ({ ...environment(), PATH: `.${path.delimiter}${fixtureEnv.PATH ?? ''}` }));
    const marker = path.join(f.work, 'executed-git');
    const program = path.join(f.source, gitProgram);
    fs.writeFileSync(program, `#!/bin/sh\nprintf ran > '${marker}'\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
    git(f.source, 'add', '.');
    git(f.source, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '-qm', 'untrusted git executable');
    const admission = gitAdmission(program, path.join(f.destination, gitProgram));
    try {
      admission.probe(program);
      const { receipt } = await start(f);
      const result = await finished(f.service, receipt.id);
      expect(fs.existsSync(marker)).toBe(false);
      expect(result.phase).toBe('completed');
      expect(f.register).toHaveBeenCalledTimes(1);
      admission.verify();
      admission.probe(path.join(f.destination, gitProgram));
    } finally { admission.close(); }
  });

  it('seals regular local Git configuration against an after-fetch smudge filter injection', async () => {
    const f = fixture();
    const marker = path.join(f.work, 'executed-filter');
    fs.writeFileSync(path.join(f.source, '.gitattributes'), 'readme.txt filter=danger\n');
    git(f.source, 'add', '.');
    git(f.source, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '-qm', 'untrusted filter name');
    const original = f.runner.run;
    f.runner.run = vi.fn(async (args, options) => {
      const result = await original(args, options);
      if (args[0] === 'fetch') fs.appendFileSync(path.join(f.destination, '.git', 'config'), `\n[filter "danger"]\n smudge = ${JSON.stringify(`sh -c 'printf ran > "${marker}"; cat'`)}\n`);
      return result;
    });
    const { receipt } = await start(f);
    const result = await finished(f.service, receipt.id);
    expect(fs.existsSync(marker)).toBe(false);
    expect(result).toMatchObject({ phase: 'failed', cloneCompleted: false, reason: 'checkout_changed' });
    expect(f.register).not.toHaveBeenCalled();
  });

  it('rechecks the approved parent after the final asynchronous authority assertion and creates nothing in a replacement symlink target', async () => {
    const f = fixture();
    const parent = path.join(f.work, 'approved-parent');
    const other = path.join(f.work, 'unapproved-parent');
    fs.mkdirSync(parent);
    fs.mkdirSync(other);
    f.destination = path.join(parent, 'repo');
    let checks = 0;
    const policy: ImportAuthorization = async () => ({
      kind: 'approved',
      assertCurrent: async () => {
        if (++checks === 2) {
          await Promise.resolve();
          fs.renameSync(parent, `${parent}-old`);
          fs.symlinkSync(other, parent, 'junction');
        }
      },
    });
    const { receipt } = await start(f, policy);
    const result = await finished(f.service, receipt.id);
    expect(fs.existsSync(path.join(other, 'repo'))).toBe(false);
    expect(result.phase).toBe('failed');
    expect(f.register).not.toHaveBeenCalled();
  });

  it('does not register an origin changed after checkout as a completed approved import', async () => {
    const f = fixture();
    const original = f.runner.run;
    f.runner.run = vi.fn(async (args, options) => {
      const result = await original(args, options);
      if (args[0] === 'checkout') git(f.destination, 'remote', 'set-url', 'origin', 'https://github.com/example/other.git');
      return result;
    });
    const { receipt } = await start(f);
    const result = await finished(f.service, receipt.id);
    expect(f.register).not.toHaveBeenCalled();
    expect(result).toMatchObject({ phase: 'partial', cloneCompleted: true });
    expect(git(f.destination, 'config', '--get', 'remote.origin.url')).toBe('https://github.com/example/other.git');
  });

  it('rejects configuration injected during credential preparation, after the earlier ownership checkpoint', async () => {
    let inject: (() => void) | undefined;
    const f = fixture(() => {
      inject?.();
      inject = undefined;
      return environment();
    });
    const original = f.runner.run;
    f.runner.run = vi.fn(async (args, options) => {
      if (args[0] === 'checkout') inject = () => fs.appendFileSync(path.join(f.destination, '.git', 'config'), '\n[filter "danger"]\n smudge = unexpected-command\n');
      return original(args, options);
    });
    const { receipt } = await start(f);
    expect(await finished(f.service, receipt.id)).toMatchObject({ phase: 'failed', reason: 'checkout_changed', cloneCompleted: false });
    expect(fs.existsSync(path.join(f.destination, 'readme.txt'))).toBe(false);
    expect(f.register).not.toHaveBeenCalled();
  });

  it.each(['commondir', 'objects', 'refs'])('rejects after-fetch Git %s indirection without using or replacing its outside target', async (changed) => {
    const f = fixture();
    const original = f.runner.run;
    f.runner.run = vi.fn(async (args, options) => {
      const result = await original(args, options);
      if (args[0] === 'fetch') {
        const target = path.join(f.destination, '.git', changed);
        if (changed === 'commondir') fs.writeFileSync(target, `${path.join(f.source, '.git')}\n`);
        else {
          fs.renameSync(target, `${target}-owned`);
          fs.symlinkSync(path.join(f.source, '.git', changed), target, 'junction');
        }
      }
      return result;
    });
    const { receipt } = await start(f);
    expect(await finished(f.service, receipt.id)).toMatchObject({ phase: 'failed', cloneCompleted: false, reason: changed === 'commondir' ? 'checkout_changed' : 'owned_directory_changed' });
    expect(f.register).not.toHaveBeenCalled();
    expect(git(f.source, 'rev-parse', 'HEAD')).toBe(f.commit);
  });

  describe('final registration identity after prepared checkout', () => {
    let f: ReturnType<typeof fixture>;
    let receipt: ImportReceipt;
    let marker: string;
    let resume!: () => void;
    let waiting: boolean;
    beforeEach(async () => {
      f = fixture();
      waiting = false;
      let finalRemoteChecked = false;
      let arrived!: () => void;
      const entered = new Promise<void>((resolve) => { arrived = resolve; });
      const released = new Promise<void>((resolve) => { resume = resolve; });
      lifetime.releases.push(() => { resume(); arrived(); });
      const original = f.runner.remote;
      f.runner.remote = vi.fn(async (...args) => {
        const result = await original(...args);
        if ((await f.store.get()).receipts.some((entry) => entry.phase === 'registering')) finalRemoteChecked = true;
        return result;
      });
      marker = path.join(f.work, 'preserved-user-file');
      fs.writeFileSync(marker, 'keep');
      const approval: ImportAuthorization = async () => ({
        kind: 'approved',
        assertCurrent: async () => {
          if (!finalRemoteChecked || waiting) return;
          waiting = true;
          arrived();
          await released;
        },
      });
      ({ receipt } = await start(f, approval));
      await entered;
    });

    it.each(['origin', 'HEAD', 'branch', 'gitignore'])('rechecks actual %s after the final registration authority await', async (changed) => {
      expect(waiting).toBe(true);
      if (changed === 'origin') git(f.destination, 'remote', 'set-url', 'origin', 'https://github.com/example/other.git');
      if (changed === 'HEAD') fs.writeFileSync(path.join(f.destination, '.git', 'HEAD'), `${f.commit}\n`);
      if (changed === 'branch') fs.writeFileSync(path.join(f.destination, '.git', 'refs', 'heads', 'trunk'), `${'b'.repeat(40)}\n`);
      if (changed === 'gitignore') fs.symlinkSync(marker, path.join(f.destination, '.gitignore'));
      resume();
      expect(await finished(f.service, receipt.id)).toMatchObject({ phase: 'partial', cloneCompleted: true, reason: changed === 'gitignore' ? 'unsafe_gitignore' : 'checkout_changed' });
      expect(f.register).not.toHaveBeenCalled();
      expect(fs.readFileSync(marker, 'utf8')).toBe('keep');
    });
  });

  it('honors cancellation while the final registration authority assertion is awaiting', async () => {
    const f = fixture();
    let finalRemote = false;
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    lifetime.releases.push(release);
    const remote = f.runner.remote;
    f.runner.remote = vi.fn(async (...args) => {
      const result = await remote(...args);
      if ((await f.store.get()).receipts.some((receipt) => receipt.phase === 'registering')) finalRemote = true;
      return result;
    });
    const approval: ImportAuthorization = async () => ({
      kind: 'approved',
      assertCurrent: async () => { if (finalRemote) { entered(); await paused; } },
    });
    const { receipt } = await start(f, approval);
    await ready;
    expect(await f.service.cancel('dispatcher', receipt.id, f.destination)).toMatchObject({ status: 'cancellation_requested' });
    release();
    expect(await finished(f.service, receipt.id)).toMatchObject({ phase: 'cancelled', cloneCompleted: true, reason: 'cancelled' });
    expect(f.register).not.toHaveBeenCalled();
  });

  it.each(['tracked-file', 'runtime-state', 'ignored-content'])('preserves and refuses %s changes during the last registration authority await', async (changed) => {
    const f = fixture();
    fs.writeFileSync(path.join(f.source, '.gitignore'), 'scratch/\n');
    git(f.source, 'add', '.');
    git(f.source, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '-qm', 'ignored fixture directory');
    let finalRemote = false;
    let injected = false;
    const remote = f.runner.remote;
    f.runner.remote = vi.fn(async (...args) => {
      const result = await remote(...args);
      if ((await f.store.get()).receipts.some((receipt) => receipt.phase === 'registering')) finalRemote = true;
      return result;
    });
    const file = changed === 'tracked-file' ? path.join(f.destination, 'readme.txt')
      : path.join(f.destination, changed === 'runtime-state' ? '.clubhouse' : 'scratch', 'user.txt');
    const approval: ImportAuthorization = async () => ({
      kind: 'approved',
      assertCurrent: async () => {
        if (!finalRemote || injected) return;
        await Promise.resolve();
        injected = true;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'user edit\n');
      },
    });
    const { receipt } = await start(f, approval);
    expect(await finished(f.service, receipt.id)).toMatchObject({ phase: 'partial', cloneCompleted: true });
    expect(injected).toBe(true);
    expect(f.register).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe('user edit\n');
  });

  it.each(['logs/HEAD', 'logs/refs/heads/trunk'])('rejects a post-fetch %s file symlink before checkout can append outside the import', async (relative) => {
    const f = fixture();
    const outside = path.join(f.work, 'outside-user-file');
    fs.writeFileSync(outside, 'keep\n');
    const run = f.runner.run;
    f.runner.run = vi.fn(async (args, options) => {
      const result = await run(args, options);
      if (args[0] === 'fetch') {
        const target = path.join(f.destination, '.git', relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.symlinkSync(outside, target);
      }
      return result;
    });
    const { receipt } = await start(f);
    expect(await finished(f.service, receipt.id)).toMatchObject({ phase: 'failed', cloneCompleted: false });
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep\n');
    expect(f.register).not.toHaveBeenCalled();
  });

  describe('real registration with prepared checkout sources', () => {
    let f: ReturnType<typeof fixture>;
    beforeEach(() => {
      f = fixture();
      realRegistration(f);
    });

    describe('gitignore identity replacement', () => {
      let outside: string;
      beforeEach(() => {
        fs.writeFileSync(path.join(f.source, '.gitignore'), '# fixture\n');
        git(f.source, 'add', '.');
        git(f.source, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '-qm', 'gitignore fixture');
        outside = path.join(f.work, 'outside-user-file');
        fs.writeFileSync(outside, 'keep\n');
        const addProject = projectStore.addProject;
        const spy = vi.spyOn(projectStore, 'addProject').mockImplementation(async (folder) => {
          const result = await addProject(folder);
          fs.renameSync(path.join(folder, '.gitignore'), path.join(f.work, 'original-ignore'));
          fs.symlinkSync(outside, path.join(folder, '.gitignore'));
          return result;
        });
        lifetime.restores.push(() => { spy.mockRestore(); });
      });

      it('preserves the registered id and refuses a gitignore symlink swapped during real addProject', async () => {
        const { receipt } = await start(f);
        const result = await finished(f.service, receipt.id);
        expect(result).toMatchObject({ phase: 'partial', cloneCompleted: true, gitignore: 'failed' });
        expect(result.projectId).toBeDefined();
        expect(await projectStore.findByPath(f.destination)).toMatchObject({ id: result.projectId });
        expect(fs.readFileSync(outside, 'utf8')).toBe('keep\n');
      });
    });

    it('registers a normal checkout through real addProject and guarded creation of its missing gitignore', async () => {
      const { receipt } = await start(f);
      const result = await finished(f.service, receipt.id);
      expect(result).toMatchObject({ phase: 'completed', cloneCompleted: true, gitignore: 'updated' });
      expect(await projectStore.findByPath(f.destination)).toMatchObject({ id: result.projectId });
      expect(fs.readFileSync(path.join(f.destination, '.gitignore'), 'utf8')).toContain('.clubhouse/agents/');
      expect(ensureGitignore).toHaveBeenCalledExactlyOnceWith(f.destination, expect.any(Function));
    });
  });

  it('retains the real project id and reports partial cancellation after the actual registry commit', async () => {
    const f = fixture();
    realRegistration(f);
    let importId = '';
    const addProject = projectStore.addProject;
    const spy = vi.spyOn(projectStore, 'addProject').mockImplementation(async (folder) => {
      const result = await addProject(folder);
      expect(await f.service.cancel('dispatcher', importId, folder)).toMatchObject({ status: 'cancellation_requested' });
      return result;
    });
    lifetime.restores.push(() => { spy.mockRestore(); });
    const { receipt } = await start(f);
    importId = receipt.id;
    const result = await finished(f.service, receipt.id);
    expect(result).toMatchObject({ phase: 'partial', reason: 'cancelled', gitignore: 'failed', cloneCompleted: true });
    expect(result.projectId).toBeDefined();
    expect(await projectStore.findByPath(f.destination)).toMatchObject({ id: result.projectId });
    expect(fs.existsSync(path.join(f.destination, '.gitignore'))).toBe(false);
  });

  it('rejects index replacement during read-only status rather than accepting it as an optional index refresh', async () => {
    const f = fixture();
    const run = f.runner.run;
    f.runner.run = vi.fn(async (args, options) => {
      const result = await run(args, options);
      if (args[0] === 'status') {
        const index = path.join(f.destination, '.git', 'index');
        fs.renameSync(index, `${index}-original`);
        fs.copyFileSync(`${index}-original`, index);
      }
      return result;
    });
    const { receipt } = await start(f);
    expect(await finished(f.service, receipt.id)).toMatchObject({ phase: 'partial', cloneCompleted: true, reason: 'checkout_changed' });
    expect(f.register).not.toHaveBeenCalled();
  });

  it('rejects regular control-file replacement not written by fetch instead of adopting its new identity', async () => {
    const f = fixture();
    const run = f.runner.run;
    let replaced = '';
    f.runner.run = vi.fn(async (args, options) => {
      const result = await run(args, options);
      if (args[0] === 'fetch') {
        const head = path.join(f.destination, '.git', 'HEAD');
        replaced = fs.readFileSync(head, 'utf8');
        fs.renameSync(head, `${head}-original`);
        fs.writeFileSync(head, replaced);
      }
      return result;
    });
    const { receipt } = await start(f);
    expect(await finished(f.service, receipt.id)).toMatchObject({ phase: 'failed', cloneCompleted: false, reason: 'checkout_changed' });
    expect(fs.readFileSync(path.join(f.destination, '.git', 'HEAD'), 'utf8')).toBe(replaced);
    expect(f.register).not.toHaveBeenCalled();
  });

  it.each(['HEAD', 'index', 'shallow', 'packed-refs'])('rejects a post-fetch %s symlink without modifying its outside target', async (relative) => {
    const f = fixture();
    const outside = path.join(f.work, 'outside-user-file');
    fs.writeFileSync(outside, 'keep\n');
    const run = f.runner.run;
    f.runner.run = vi.fn(async (args, options) => {
      const result = await run(args, options);
      if (args[0] === 'fetch') {
        const target = path.join(f.destination, '.git', relative);
        if (fs.existsSync(target)) fs.renameSync(target, `${target}-original`);
        fs.symlinkSync(outside, target);
      }
      return result;
    });
    const { receipt } = await start(f);
    expect(await finished(f.service, receipt.id)).toMatchObject({ phase: 'failed', cloneCompleted: false, reason: 'owned_directory_changed' });
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep\n');
    expect(f.register).not.toHaveBeenCalled();
  });
});

describe('guarded standard ignore writes', () => {
  it.each([false, true])('preserves ordinary formatting with an initially existing gitignore: %s', async (exists) => {
    const f = fixture();
    const ordinary = path.join(f.work, 'ordinary');
    const guarded = path.join(f.work, 'guarded');
    fs.mkdirSync(ordinary);
    fs.mkdirSync(guarded);
    if (exists) {
      fs.writeFileSync(path.join(ordinary, '.gitignore'), '# existing\nnode_modules/\n');
      fs.writeFileSync(path.join(guarded, '.gitignore'), '# existing\nnode_modules/\n');
    }
    const actual = await vi.importActual<typeof import('../agent-config')>('../agent-config');
    expect(await actual.ensureGitignore(guarded, () => {})).toBe(await actual.ensureGitignore(ordinary));
    expect(fs.readFileSync(path.join(guarded, '.gitignore'), 'utf8')).toBe(fs.readFileSync(path.join(ordinary, '.gitignore'), 'utf8'));
  });

  it.each(['symlink', 'hardlink'])('refuses a gitignore %s without modifying either target', async (kind) => {
    const f = fixture();
    const outside = path.join(f.work, 'outside');
    const ignore = path.join(f.source, '.gitignore');
    fs.writeFileSync(outside, 'keep\n');
    if (kind === 'symlink') fs.symlinkSync(outside, ignore);
    else fs.linkSync(outside, ignore);
    const actual = await vi.importActual<typeof import('../agent-config')>('../agent-config');
    await expect(actual.ensureGitignore(f.source, () => {})).rejects.toThrow('singly linked regular file');
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep\n');
  });

  it('accepts a complete 1 MiB ignore file, rejects one more byte and refuses an append past the same bound', async () => {
    const f = fixture();
    const actual = await vi.importActual<typeof import('../agent-config')>('../agent-config');
    await actual.ensureGitignore(f.source);
    await actual.ensureGitignore(f.source);
    const ignore = path.join(f.source, '.gitignore');
    const content = fs.readFileSync(ignore, 'utf8');
    const limit = 1024 * 1024;
    fs.writeFileSync(ignore, `${content}${'x'.repeat(limit - Buffer.byteLength(content))}`);
    expect(await actual.ensureGitignore(f.source, () => {})).toBe(false);
    fs.appendFileSync(ignore, 'x');
    await expect(actual.ensureGitignore(f.source, () => {})).rejects.toThrow('bounded');
    expect(fs.statSync(ignore).size).toBe(limit + 1);
    fs.writeFileSync(ignore, 'x'.repeat(limit));
    await expect(actual.ensureGitignore(f.source, () => {})).rejects.toThrow('bounded');
    expect(fs.readFileSync(ignore, 'utf8')).toBe('x'.repeat(limit));
  });

  it('exclusively creates a missing ignore file and preserves a user file appearing at the final guard', async () => {
    const f = fixture();
    const ignore = path.join(f.source, '.gitignore');
    const actual = await vi.importActual<typeof import('../agent-config')>('../agent-config');
    let checks = 0;
    await expect(actual.ensureGitignore(f.source, () => {
      if (++checks === 2) fs.writeFileSync(ignore, 'keep\n');
    })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.readFileSync(ignore, 'utf8')).toBe('keep\n');
  });
});

describe('cancellation, interruption and unsafe incidental execution', () => {
  it('cancels only the tracked owned import, preserves partial state and does not re-clone on retry', async () => {
    const f = fixture();
    const original = f.runner.run;
    let fetching!: () => void;
    const atFetch = new Promise<void>((resolve) => { fetching = resolve; });
    f.runner.run = vi.fn(async (args, options) => {
      if (args[0] !== 'fetch') return original(args, options);
      fetching();
      await new Promise<void>((_resolve, reject) => {
        options.signal!.throwIfAborted();
        options.signal!.addEventListener('abort', () => reject(new ImportError('cancelled', 'cancelled')), { once: true });
      });

      return '';
    });
    const { plan, receipt } = await start(f);
    await atFetch;
    await expect(f.service.cancel('dispatcher', receipt.id, `${f.destination}-wrong`)).rejects.toMatchObject({ reason: 'plan_mismatch' });
    expect((await f.service.cancel('dispatcher', receipt.id, f.destination)).status).toBe('cancellation_requested');
    const result = await finished(f.service, receipt.id);
    expect(result).toMatchObject({ phase: 'cancelled', cloneCompleted: false, failedAt: 'fetching' });
    expect(fs.existsSync(path.join(f.destination, '.git'))).toBe(true);
    expect(f.register).not.toHaveBeenCalled();
    expect((await f.service.start('dispatcher', plan.id, f.destination, authorized)).status).toBe('existing_import');
    expect((await f.service.cancel('dispatcher', receipt.id, f.destination)).status).toBe('not_running');
  });

  it('reports an interrupted receipt without silently restarting or treating the preview as approval', async () => {
    const f = fixture();
    const plan = await preview(f);
    const receipt: ImportReceipt = { id: crypto.randomUUID(), plan, phase: 'fetching', cloneCompleted: false, updatedAt: Date.now(), agentCreated: false, agentStarted: false };
    await f.store.update((state) => { state.receipts.push(receipt); });
    const restarted = new ProjectImportService({ store: f.store, git: f.runner, listProjects: async () => [] });
    expect(await restarted.status('dispatcher', receipt.id)).toMatchObject({ phase: 'interrupted', reason: 'app_interrupted' });
    expect((await restarted.start('dispatcher', plan.id, f.destination, authorized)).status).toBe('existing_import');
    expect(authorized).not.toHaveBeenCalled();
    expect(f.runner.run).not.toHaveBeenCalled();
  });

  it('preserves registered project identity when interruption occurred before recording the final receipt', async () => {
    const f = fixture();
    const plan = await preview(f);
    projects.push({ id: 'proj_done', name: 'repo', path: f.destination });
    const receipt: ImportReceipt = { id: crypto.randomUUID(), plan, phase: 'registering', cloneCompleted: true, updatedAt: Date.now(), agentCreated: false, agentStarted: false };
    await f.store.update((state) => { state.receipts.push(receipt); });
    expect(await f.service.status('dispatcher', receipt.id)).toMatchObject({ phase: 'partial', projectId: 'proj_done', reason: 'registration_receipt_interrupted' });
  });

  it('does not execute inherited hooks, templates or attribute filters and materializes symlinks inertly', async () => {
    const f = fixture();
    const marker = path.join(f.work, 'executed');
    const hooks = path.join(f.work, 'hooks');
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const config = path.join(temp.root, '.gitconfig');
    fs.writeFileSync(config, '', { flag: 'wx', mode: 0o600 });
    try {
      const windowsPath = String.raw`C:\Users\fixture\AppData\Local\Temp\hooks`;
      git(f.source, 'config', '--file', config, 'core.hooksPath', windowsPath);
      expect(git(f.source, 'config', '--file', config, '--get', 'core.hooksPath')).toBe(windowsPath);
      for (const [key, value] of [
        ['core.hooksPath', hooks], ['init.templateDir', hooks],
        ['filter.danger.smudge', `touch '${marker}'`], ['filter.danger.required', 'true'],
        ['url.file:///unexpected/.insteadOf', 'https://github.com/'],
      ]) {
        git(f.source, 'config', '--file', config, key, value);
        expect(git(f.source, 'config', '--file', config, '--get', key)).toBe(value);
      }
      fs.writeFileSync(path.join(f.source, '.gitattributes'), 'readme.txt filter=danger\n');
      fs.symlinkSync(marker, path.join(f.source, 'link'));
      git(f.source, 'add', '.');
      git(f.source, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '-qm', 'untrusted attributes');
      const commit = git(f.source, 'rev-parse', 'HEAD');
      const { plan, receipt } = await start(f);
      expect(plan).toMatchObject({ branch: 'trunk', defaultBranch: 'trunk', commit, headCommit: commit });
      const outcome = await finished(f.service, receipt.id);
      expect(outcome.phase, `Import terminal phase=${outcome.phase}, failedAt=${outcome.failedAt ?? 'none'}, reason=${outcome.reason ?? 'none'}`).toBe('completed');
      expect(outcome.cloneCompleted).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.lstatSync(path.join(f.destination, 'link')).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(f.destination, 'readme.txt'), 'utf8')).toBe('hello\n');
      expect(fs.existsSync(path.join(f.destination, '.git', 'hooks', 'post-checkout'))).toBe(false);
    } finally {
      fs.unlinkSync(config);
    }
  });

  describe.each(['.clubhouse', '.ClubHouse', '.clubhouse.'])('repository-provided %s runtime state', (folder) => {
    let f: ReturnType<typeof fixture>;
    let commit: string;
    beforeEach(() => {
      f = fixture();
      const inputGit = (input: string, ...args: string[]) => execFileSync(fixtureBinary, ['-c', 'protocol.file.allow=always', ...args], {
        cwd: f.source, env: fixtureEnv, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const payload = '{"agents":[]}';
      const blob = inputGit(payload, 'hash-object', '-w', '--stdin');
      const runtimeTree = inputGit(`100644 blob ${blob}\tagents.json\n`, 'mktree');
      const tree = inputGit(`${git(f.source, 'ls-tree', 'HEAD')}\n040000 tree ${runtimeTree}\t${folder}\n`, 'mktree');
      commit = git(f.source, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit-tree', tree, '-p', f.commit, '-m', 'runtime state');
      git(f.source, 'update-ref', 'refs/heads/trunk', commit, f.commit);
      expect(git(f.source, 'ls-tree', '-z', '--name-only', 'HEAD').split('\0').filter(Boolean)).toEqual([folder, 'readme.txt']);
      expect(git(f.source, 'cat-file', 'blob', `${commit}:${folder}/agents.json`)).toBe(payload);
      expect(git(f.source, 'symbolic-ref', '--short', 'HEAD')).toBe('trunk');
      expect(git(f.source, 'rev-parse', 'HEAD')).toBe(commit);
      expect(fs.readdirSync(f.source).sort()).toEqual(['.git', 'readme.txt']);
    });

    it('refuses runtime state before checkout or registration', async () => {
      const { plan, receipt } = await start(f);
      expect(plan).toMatchObject({ branch: 'trunk', defaultBranch: 'trunk', commit, headCommit: commit });
      const result = await finished(f.service, receipt.id);
      expect(result).toMatchObject({ phase: 'failed', cloneCompleted: false, reason: 'repository_app_state' });
      expect(vi.mocked(f.runner.run).mock.calls.some(([args]) => args[0] === 'checkout')).toBe(false);
      expect(fs.readdirSync(f.destination)).toEqual(['.git']);
      expect(fs.existsSync(path.join(f.destination, '.clubhouse'))).toBe(false);
      expect(f.register).not.toHaveBeenCalled();
    });
  });

  it('reports sanitized actionable missing-access errors and creates no checkout', async () => {
    const f = fixture();
    vi.mocked(f.runner.remote).mockRejectedValueOnce(new ImportError('git_failed', 'Restore existing authorized GitHub sign-in outside messages; do not send credentials.'));
    await expect(preview(f)).rejects.toMatchObject({ reason: 'git_failed', message: expect.stringContaining('sign-in') });
    expect(fs.existsSync(f.destination)).toBe(false);
  });

  it('preserves user changes made during checkout rather than registering or resetting them', async () => {
    const f = fixture();
    const original = f.runner.run;
    f.runner.run = vi.fn(async (args, options) => {
      const result = await original(args, options);
      if (args[0] === 'checkout') fs.writeFileSync(path.join(f.destination, 'user.txt'), 'keep');
      return result;
    });
    const { receipt } = await start(f);
    expect(await finished(f.service, receipt.id)).toMatchObject({ phase: 'partial', reason: 'checkout_changed', cloneCompleted: true });
    expect(fs.readFileSync(path.join(f.destination, 'user.txt'), 'utf8')).toBe('keep');
    expect(f.register).not.toHaveBeenCalled();
  });
});
