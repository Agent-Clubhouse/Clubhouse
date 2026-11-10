import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * add_project (#3239) over the real project registry and folder checks, in a
 * temporary home: only the tool registry, logging and the .gitignore write
 * are faked.
 */

const tmp = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'add-project-'));
  return { root, base: nodePath.join(root, 'home', '.clubhouse-dev') };
});

const registered = vi.hoisted(() => new Map<string, { handler: (agentId: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>; grant: unknown; group: unknown }>());
vi.mock('../tool-registry', () => ({
  registerGlobalTool: (name: string, _def: unknown, handler: never, options: { grant: unknown; group: unknown }) => {
    registered.set(name, { handler, grant: options.grant, group: options.group });
  },
}));
const describers = vi.hoisted(() => new Map<string, (args: Record<string, unknown>) => string | undefined>());
vi.mock('../ask-first', () => ({ describeCallsForAsk: (name: string, fn: never) => { describers.set(name, fn); } }));
vi.mock('../../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../../base-dir', () => ({ getBaseDirPath: () => tmp.base }));
vi.mock('../../badge-settings', () => ({ getSettings: () => ({}), saveSettings: vi.fn() }));
vi.mock('../../sound-service', () => ({ getSettings: () => ({}), saveSettings: vi.fn() }));
vi.mock('../../agent-config', () => ({ ensureGitignore: vi.fn(async () => true) }));

import { registerProjectAddTools } from './project-add-tools';
import * as projectStore from '../../project-store';
import { ensureGitignore } from '../../agent-config';

const call = async (args: Record<string, unknown>) => {
  const result = await registered.get('add_project')!.handler('dispatcher', args);
  return { body: JSON.parse(result.content[0].text), isError: !!result.isError };
};

let n = 0;
function folder(): string {
  const dir = path.join(tmp.root, 'work', `repo-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

async function registeredFor(dir: string): Promise<number> {
  const real = projectStore.projectPathKey(fs.realpathSync(dir));
  const list = await projectStore.list();
  return list.filter((p) => projectStore.projectPathKey(fs.realpathSync(p.path)) === real).length;
}

beforeEach(() => {
  registered.clear();
  registerProjectAddTools();
  fs.rmSync(tmp.base, { recursive: true, force: true });
  vi.mocked(ensureGitignore).mockClear();
});

afterAll(() => {
  fs.rmSync(tmp.root, { recursive: true, force: true });
});

describe('add_project (#3239)', () => {
  it('is the Dispatcher\'s, under project.add on the folder named by path', () => {
    expect(registered.get('add_project')!.group).toBe('dispatcher');
    expect(registered.get('add_project')!.grant).toEqual({ actions: ['project.add'], target: 'project_arg', from: { args: ['path'] } });
    expect(describers.get('add_project')!({ path: path.join(tmp.root, 'x') })).toContain('.gitignore');
    expect(describers.get('add_project')!({ path: path.join(tmp.root, 'x'), dryRun: true })).toContain('Nothing changes');
  });

  it('adds a folder once, with its git facts and no credentials in the origin', async () => {
    const dir = folder();
    git(dir, 'init', '-q');
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
    git(dir, 'remote', 'add', 'origin', 'https://someone:secret-token@example.com/org/repo.git');

    const { body, isError } = await call({ path: dir, displayName: 'Shop' });

    expect(isError).toBe(false);
    expect(body).toMatchObject({
      status: 'added', name: 'Shop', path: dir, canonicalPath: fs.realpathSync(dir),
      git: true, defaultBranch: 'trunk', origin: 'https://example.com/org/repo.git', gitignore: 'updated',
    });
    expect(body.projectId).toMatch(/^proj_/);
    expect(JSON.stringify(body)).not.toContain('secret-token');
    expect(ensureGitignore).toHaveBeenCalledTimes(1);
    expect(await registeredFor(dir)).toBe(1);
  });

  it('returns already_registered for the same folder spelled another way, and adds nothing', async () => {
    const dir = folder();
    const first = await call({ path: dir });
    vi.mocked(ensureGitignore).mockClear();

    const again = await call({ path: dir + path.sep });
    const dotted = await call({ path: path.join(dir, '..', path.basename(dir)) });

    for (const r of [again, dotted]) {
      expect(r.isError).toBe(false);
      expect(r.body).toMatchObject({ status: 'already_registered', projectId: first.body.projectId, git: false, defaultBranch: null, origin: null });
    }
    expect(ensureGitignore).not.toHaveBeenCalled();
    expect(await registeredFor(dir)).toBe(1);
  });

  it('treats a link to a registered folder as that folder', async () => {
    const dir = folder();
    const first = await call({ path: dir });
    const link = path.join(tmp.root, 'work', `link-${n}`);
    fs.symlinkSync(dir, link, 'junction');

    const again = await call({ path: link });

    expect(again.body).toMatchObject({ status: 'already_registered', projectId: first.body.projectId });
    expect(await projectStore.list()).toHaveLength(1);
  });

  it('dryRun says what would happen and changes nothing', async () => {
    const dir = folder();
    const { body } = await call({ path: dir, dryRun: true });
    expect(body).toMatchObject({ status: 'would_add', path: dir, canonicalPath: fs.realpathSync(dir), git: false });
    expect(await projectStore.list()).toEqual([]);
    expect(ensureGitignore).not.toHaveBeenCalled();
  });

  it('refuses a relative path, a missing folder, a file, an agent worktree and Clubhouse\'s own folders', async () => {
    const dir = folder();
    const file = path.join(dir, 'notes.txt');
    fs.writeFileSync(file, 'x');
    const worktree = path.join(dir, '.clubhouse', 'agents', 'helper-1');
    fs.mkdirSync(worktree, { recursive: true });
    const internal = path.join(tmp.base, 'dispatcher');
    fs.mkdirSync(internal, { recursive: true });

    const cases: Array<[string, string]> = [
      [path.join('relative', 'folder'), 'not_absolute'],
      [path.join(dir, 'missing'), 'not_found'],
      [file, 'not_directory'],
      [worktree, 'agent_worktree'],
      [path.join(dir, '.clubhouse'), 'clubhouse_internal'],
      [internal, 'clubhouse_internal'],
    ];
    for (const [p, reason] of cases) {
      const r = await call({ path: p });
      expect(r.isError, p).toBe(true);
      expect(r.body, p).toMatchObject({ status: 'refused', reason });
    }
    expect(await projectStore.list()).toEqual([]);
  });

  it('keeps an existing project\'s name when one is given', async () => {
    const dir = folder();
    await call({ path: dir });
    const again = await call({ path: dir, displayName: 'Other' });
    expect(again.body.status).toBe('already_registered');
    expect(again.body.name).toBe(path.basename(dir));
    expect(again.body.note).toMatch(/update_project/);
  });
});

describe('the registry with legacy duplicates (#3236)', () => {
  it('merges records for one folder into the first, keeping what only the second had', async () => {
    const dir = folder();
    fs.mkdirSync(tmp.base, { recursive: true });
    fs.writeFileSync(path.join(tmp.base, 'projects.json'), JSON.stringify({
      version: 1,
      projects: [
        { id: 'proj_a', name: 'repo', path: dir },
        { id: 'proj_other', name: 'other', path: folder() },
        { id: 'proj_b', name: 'repo', path: dir + path.sep, displayName: 'Shop', color: 'rose' },
      ],
    }));

    const list = await projectStore.list();

    expect(list.map((p) => p.id)).toEqual(['proj_a', 'proj_other']);
    expect(list[0]).toMatchObject({ displayName: 'Shop', color: 'rose' });
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp.base, 'projects.json'), 'utf-8'));
    expect(onDisk.projects.map((p: { id: string }) => p.id)).toEqual(['proj_a', 'proj_other']);
    const again = await call({ path: dir });
    expect(again.body).toMatchObject({ status: 'already_registered', projectId: 'proj_a' });
  });
});
