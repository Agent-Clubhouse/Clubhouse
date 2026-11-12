import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { Project } from '../../../shared/types';

const temp = vi.hoisted(() => {
  const f = require('fs') as typeof import('fs');
  const p = require('path') as typeof import('path');
  const o = require('os') as typeof import('os');
  const root = f.realpathSync.native(f.mkdtempSync(p.join(o.tmpdir(), 'project-import-')));
  return { root, base: p.join(root, 'app') };
});

vi.mock('../base-dir', () => ({ getBaseDirPath: () => temp.base }));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../badge-settings', () => ({ getSettings: () => ({}), saveSettings: vi.fn() }));
vi.mock('../sound-service', () => ({ getSettings: () => ({}), saveSettings: vi.fn() }));
vi.mock('../agent-config', () => ({ ensureGitignore: vi.fn(async () => true) }));

import { ProjectImportService, type ImportAuthorization } from './service';
import { ImportStore } from './store';
import { createImportGit, importGitEnvironment, parseRemoteIdentity, type ImportGit } from './git';
import { ImportError, type ImportReceipt } from './types';
import * as projectStore from '../project-store';
import { registerProjectFolder } from '../project-add';
import { ensureGitignore } from '../agent-config';

let n = 0;
const environment = () => ({ PATH: process.env.PATH, HOME: temp.root, USERPROFILE: temp.root, XDG_CONFIG_HOME: path.join(temp.root, 'xdg') });
const fixtureEnv = importGitEnvironment(environment());
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, env: fixtureEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const assertCurrent = async (): Promise<void> => {};
const authorized: ImportAuthorization = vi.fn(async () => ({ kind: 'approved', assertCurrent }));
const projects: Project[] = [];

function fixture() {
  const work = path.join(temp.root, `case-${++n}`);
  const source = path.join(work, 'source');
  fs.mkdirSync(source, { recursive: true });
  git(source, 'init', '-q', '--initial-branch=trunk', '--template=');
  fs.writeFileSync(path.join(source, 'readme.txt'), 'hello\n');
  git(source, 'add', '.');
  git(source, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '-qm', 'initial');
  const commit = git(source, 'rev-parse', 'HEAD');
  const destination = path.join(work, 'imported');
  const url = 'https://github.com/example/repository.git';
  const safeGit = createImportGit(environment);
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
  const register = vi.fn(async (folder: string) => {
    const project: Project = { id: `proj_${n}`, name: path.basename(folder), path: folder };
    projects.push(project);
    return { project, created: true, gitignore: 'updated' as const };
  });
  const listProjects = vi.fn(async () => projects);
  const service = new ProjectImportService({ store, git: runner, listProjects, origin: async () => url, register });
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
  for (let i = 0; i < 300; i++) {
    const receipt = await service.status('dispatcher', id);
    if (['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(receipt.phase)) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('import did not finish');
}

beforeEach(() => {
  projects.length = 0;
  vi.mocked(authorized).mockResolvedValue({ kind: 'approved', assertCurrent });
});

afterAll(() => { fs.rmSync(temp.root, { recursive: true, force: true }); });

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
    fs.rmSync(temp.base, { recursive: true, force: true });
    vi.mocked(ensureGitignore).mockRejectedValueOnce(new Error('unwritable'));
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
    git(f.source, 'branch', 'release');
    const result = await f.service.preview('dispatcher', { url: f.url, destination: f.destination, branch: 'release' });
    expect(result.status === 'ready' && result.plan).toMatchObject({ branch: 'release', defaultBranch: 'trunk' });
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
    fs.writeFileSync(config, `[core]\n hooksPath = ${hooks}\n[init]\n templateDir = ${hooks}\n[filter "danger"]\n smudge = touch '${marker}'\n required = true\n[url "file:///unexpected/"]\n insteadOf = https://github.com/\n`);
    fs.writeFileSync(path.join(f.source, '.gitattributes'), 'readme.txt filter=danger\n');
    fs.symlinkSync(marker, path.join(f.source, 'link'));
    git(f.source, 'add', '.');
    git(f.source, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '-qm', 'untrusted attributes');
    try {
      const { receipt } = await start(f);
      expect((await finished(f.service, receipt.id)).phase).toBe('completed');
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.lstatSync(path.join(f.destination, 'link')).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(f.destination, 'readme.txt'), 'utf8')).toBe('hello\n');
      expect(fs.existsSync(path.join(f.destination, '.git', 'hooks', 'post-checkout'))).toBe(false);
    } finally {
      fs.unlinkSync(config);
    }
  });

  it.each(['.clubhouse', '.ClubHouse', '.clubhouse.'])('refuses repository-provided %s runtime state before checkout or registration', async (folder) => {
    const f = fixture();
    fs.mkdirSync(path.join(f.source, folder));
    fs.writeFileSync(path.join(f.source, folder, 'agents.json'), '{"agents":[]}');
    git(f.source, 'add', '.');
    git(f.source, '-c', 'user.email=test@example.test', '-c', 'user.name=Test', 'commit', '-qm', 'runtime state');
    const { receipt } = await start(f);
    const result = await finished(f.service, receipt.id);
    expect(result).toMatchObject({ phase: 'failed', cloneCompleted: false, reason: 'repository_app_state' });
    expect(fs.existsSync(path.join(f.destination, '.clubhouse'))).toBe(false);
    expect(f.register).not.toHaveBeenCalled();
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
