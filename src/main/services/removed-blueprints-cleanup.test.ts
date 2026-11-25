import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { appLog } from './log-service';
import { cleanupRemovedBlueprintData, gitTrackedCheck } from './removed-blueprints-cleanup';

function touch(file: string, content = '{}'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Every file under `dir`, relative to it, sorted, with forward slashes. */
function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else out.push(child);
    }
  };
  walk('');
  return out.sort();
}

describe('cleanupRemovedBlueprintData', () => {
  let root: string;
  let projectA: string;
  let projectB: string;
  let markerFile: string;

  beforeEach(async () => {
    vi.mocked(appLog).mockClear();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'removed-blueprints-cleanup-'));
    projectA = path.join(root, 'project-a');
    projectB = path.join(root, 'project-b');
    markerFile = path.join(root, 'home', '.clubhouse', 'removed-feature-cleanup', 'blueprints.json');
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  // Plain folders: never a git repo, whatever the temp dir sits in.
  const run = (projects = [{ path: projectA }, { path: projectB }]) =>
    cleanupRemovedBlueprintData({ projects, markerFile, isTracked: async () => 'not-a-repo' });

  it('deletes each project\'s .clubhouse/blueprints and touches nothing else', async () => {
    // Old blueprint data.
    touch(path.join(projectA, '.clubhouse', 'blueprints', 'team.json'));
    touch(path.join(projectA, '.clubhouse', 'blueprints', 'bundle-2026.json'));
    touch(path.join(projectB, '.clubhouse', 'blueprints', 'nested', 'x.json'));
    // Neighbours that must stay.
    touch(path.join(projectA, '.clubhouse', 'settings.json'));
    touch(path.join(projectA, '.clubhouse', 'blueprints-notes.md'));
    touch(path.join(projectA, '.clubhouse', 'agents', 'a', 'blueprints', 'keep.json'));
    touch(path.join(projectA, 'blueprints', 'mine.json'));
    touch(path.join(projectB, 'src', 'blueprint.json'));

    const result = await run();

    expect(result.ran).toBe(true);
    expect(result.failed).toEqual([]);
    expect(result.removed.sort()).toEqual([
      path.join(projectA, '.clubhouse', 'blueprints'),
      path.join(projectB, '.clubhouse', 'blueprints'),
    ].sort());
    expect(listTree(projectA)).toEqual([
      '.clubhouse/agents/a/blueprints/keep.json',
      '.clubhouse/blueprints-notes.md',
      '.clubhouse/settings.json',
      'blueprints/mine.json',
    ]);
    expect(listTree(projectB)).toEqual(['src/blueprint.json']);
    expect(appLog).toHaveBeenCalledWith('core:startup', 'info', expect.stringContaining('blueprints'), expect.anything());
  });

  it('runs once: after the marker is written, a later startup does nothing', async () => {
    touch(path.join(projectA, '.clubhouse', 'blueprints', 'team.json'));
    await run();
    expect(fs.existsSync(markerFile)).toBe(true);

    touch(path.join(projectA, '.clubhouse', 'blueprints', 'again.json'));
    const second = await run();
    expect(second).toEqual({ ran: false, removed: [], keptTracked: [], failed: [] });
    expect(fs.existsSync(path.join(projectA, '.clubhouse', 'blueprints', 'again.json'))).toBe(true);
  });

  it('is a no-op that still writes the marker when there is nothing to delete', async () => {
    touch(path.join(projectA, '.clubhouse', 'settings.json'));
    const result = await run();
    expect(result).toEqual({ ran: true, removed: [], keptTracked: [], failed: [] });
    expect(fs.existsSync(markerFile)).toBe(true);
    expect(listTree(projectA)).toEqual(['.clubhouse/settings.json']);
  });

  it('unlinks a symlinked blueprints folder without following it', async () => {
    const outside = path.join(root, 'outside');
    touch(path.join(outside, 'precious.json'));
    fs.mkdirSync(path.join(projectA, '.clubhouse'), { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(projectA, '.clubhouse', 'blueprints'), 'junction');
    } catch {
      return; // symlinks not permitted on this machine
    }
    const result = await run([{ path: projectA }]);
    expect(result.removed).toEqual([path.join(projectA, '.clubhouse', 'blueprints')]);
    expect(fs.existsSync(path.join(projectA, '.clubhouse', 'blueprints'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'precious.json'))).toBe(true);
  });

  it('never throws, and leaves the marker unwritten so a failure is retried', async () => {
    touch(path.join(projectA, '.clubhouse', 'blueprints', 'team.json'));
    const rm = vi.spyOn(fsp, 'rm').mockRejectedValueOnce(new Error('EBUSY'));
    try {
      const result = await run([{ path: projectA }]);
      expect(result.failed).toEqual([path.join(projectA, '.clubhouse', 'blueprints')]);
      expect(fs.existsSync(markerFile)).toBe(false);
      expect(appLog).toHaveBeenCalledWith('core:startup', 'warn', expect.any(String), expect.anything());
    } finally {
      rm.mockRestore();
    }
    const retry = await run([{ path: projectA }]);
    expect(retry.removed).toEqual([path.join(projectA, '.clubhouse', 'blueprints')]);
    expect(fs.existsSync(markerFile)).toBe(true);
  });

  it('keeps the folder, without retrying, when git cannot say whether it is tracked', async () => {
    touch(path.join(projectA, '.clubhouse', 'blueprints', 'team.json'));
    const result = await cleanupRemovedBlueprintData({
      projects: [{ path: projectA }], markerFile,
      isTracked: async () => { throw new Error('git not found'); },
    });
    expect(result.failed).toEqual([path.join(projectA, '.clubhouse', 'blueprints')]);
    expect(fs.existsSync(path.join(projectA, '.clubhouse', 'blueprints', 'team.json'))).toBe(true);
    expect(fs.existsSync(markerFile)).toBe(false);
  });
});

/** Real git: the three cases for a folder inside the person's repository. */
describe('cleanupRemovedBlueprintData in a git repository', () => {
  let root: string;
  let repo: string;
  let markerFile: string;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });

  beforeEach(async () => {
    vi.mocked(appLog).mockClear();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'removed-blueprints-git-'));
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    markerFile = path.join(root, 'marker.json');
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    touch(path.join(repo, 'README.md'), '# repo');
    git('add', 'README.md');
    git('commit', '-q', '-m', 'init');
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const run = () => cleanupRemovedBlueprintData({ projects: [{ path: repo }], markerFile });
  const dir = () => path.join(repo, '.clubhouse', 'blueprints');

  it('leaves a folder with a tracked file in place, logs it, and does not retry', async () => {
    touch(path.join(dir(), 'shared.json'));
    touch(path.join(dir(), 'local.json'));
    git('add', '.clubhouse/blueprints/shared.json');
    git('commit', '-q', '-m', 'share a blueprint');
    expect(await gitTrackedCheck(repo, '.clubhouse/blueprints')).toBe('tracked');

    const result = await run();

    expect(result.keptTracked).toEqual([dir()]);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(path.join(dir(), 'shared.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir(), 'local.json'))).toBe(true);
    expect(String(git('status', '--porcelain', '--', '.clubhouse/blueprints/shared.json'))).toBe('');
    expect(appLog).toHaveBeenCalledWith('core:startup', 'info', expect.stringContaining('git tracks'), expect.anything());
    expect(fs.existsSync(markerFile)).toBe(true);
  });

  it('deletes an untracked folder, and leaves the rest of the repository alone', async () => {
    touch(path.join(dir(), 'team.json'));
    touch(path.join(repo, '.clubhouse', 'settings.json'));
    expect(await gitTrackedCheck(repo, '.clubhouse/blueprints')).toBe('untracked');

    const result = await run();

    expect(result.removed).toEqual([dir()]);
    expect(fs.existsSync(dir())).toBe(false);
    expect(fs.existsSync(path.join(repo, '.clubhouse', 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(repo, 'README.md'))).toBe(true);
  });

  it('deletes an ignored folder', async () => {
    touch(path.join(repo, '.gitignore'), '.clubhouse/\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'ignore');
    touch(path.join(dir(), 'team.json'));

    const result = await run();

    expect(result.removed).toEqual([dir()]);
    expect(fs.existsSync(dir())).toBe(false);
  });

  it('deletes the folder when the project is not a git repository', async () => {
    const plain = path.join(root, 'plain');
    touch(path.join(plain, '.clubhouse', 'blueprints', 'team.json'));
    expect(await gitTrackedCheck(plain, '.clubhouse/blueprints')).toBe('not-a-repo');

    const result = await cleanupRemovedBlueprintData({ projects: [{ path: plain }], markerFile });

    expect(result.removed).toEqual([path.join(plain, '.clubhouse', 'blueprints')]);
    expect(fs.existsSync(path.join(plain, '.clubhouse', 'blueprints'))).toBe(false);
  });
});
