import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Real git and real files (#3623): Clubhouse's local patterns go in the repository's own
// exclude file, so protecting backups and recovery copies never edits a tracked file.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock('./log-service', () => ({ appLog: vi.fn() }));

import { CLUBHOUSE_LOCAL_PATTERNS, ensureLocalExcludes, ensureLocalExcludesOnce, resetLocalExcludesForTests } from './local-excludes';

let root: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', [
    '-c', 'user.name=Clubhouse Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'protocol.file.allow=always',
    ...args,
  ], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repo(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(['add', 'README.md'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

/** A file's lines, LF-neutral: a Windows checkout can give CRLF. */
const linesOf = (file: string) => fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-excludes-'));
  resetLocalExcludesForTests();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('ensureLocalExcludes (#3623)', () => {
  it('writes every pattern to .git/info/exclude and git then ignores the local files', async () => {
    const project = repo('plain');
    expect(await ensureLocalExcludes(project)).toBe(true);
    const exclude = path.join(project, '.git', 'info', 'exclude');
    expect(linesOf(exclude)).toEqual(expect.arrayContaining(CLUBHOUSE_LOCAL_PATTERNS));

    fs.mkdirSync(path.join(project, '.clubhouse'));
    for (const name of ['settings.json.bak', 'settings.json.unreadable', 'settings.json.unreadable.2', 'agents.json.bak']) {
      fs.writeFileSync(path.join(project, '.clubhouse', name), 'x');
    }
    expect(git(['status', '--porcelain'], project)).toBe('');
  });

  it('is idempotent and append-only: a second run changes nothing and the user\'s lines stay', async () => {
    const project = repo('idem');
    const exclude = path.join(project, '.git', 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(exclude, '# mine\n*.secret\n.clubhouse/agents/\nno-trailing-newline');
    expect(await ensureLocalExcludes(project)).toBe(true);
    const first = fs.readFileSync(exclude, 'utf-8');
    expect(first.startsWith('# mine\n*.secret\n.clubhouse/agents/\nno-trailing-newline\n')).toBe(true);
    // A pattern the user already listed is not added twice.
    expect(linesOf(exclude).filter((line) => line === '.clubhouse/agents/')).toHaveLength(1);
    expect(await ensureLocalExcludes(project)).toBe(false);
    expect(fs.readFileSync(exclude, 'utf-8')).toBe(first);
  });

  it('adds only a pattern that is new to the list, leaving earlier ones where they were', async () => {
    const project = repo('grow');
    const exclude = path.join(project, '.git', 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const older = CLUBHOUSE_LOCAL_PATTERNS.slice(0, -1);
    fs.writeFileSync(exclude, `# Clubhouse agent manager\n${older.join('\n')}\n`);
    expect(await ensureLocalExcludes(project)).toBe(true);
    expect(fs.readFileSync(exclude, 'utf-8')).toBe(`# Clubhouse agent manager\n${CLUBHOUSE_LOCAL_PATTERNS.join('\n')}\n`);
  });

  it('never touches the tracked .gitignore', async () => {
    const project = repo('tracked');
    fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules/\n.clubhouse/agents/\n');
    git(['add', '.gitignore'], project);
    git(['commit', '-q', '-m', 'ignore'], project);
    const before = fs.readFileSync(path.join(project, '.gitignore'), 'utf-8');
    await ensureLocalExcludes(project);
    expect(fs.readFileSync(path.join(project, '.gitignore'), 'utf-8')).toBe(before);
    expect(git(['status', '--porcelain'], project)).toBe('');
  });

  it('from a linked worktree writes the main repository\'s shared exclude file', async () => {
    const project = repo('main-repo');
    const linked = path.join(root, 'linked');
    git(['worktree', 'add', '-q', '-b', 'feature', '--', linked], project);
    expect(await ensureLocalExcludes(linked)).toBe(true);
    expect(linesOf(path.join(project, '.git', 'info', 'exclude'))).toEqual(expect.arrayContaining(CLUBHOUSE_LOCAL_PATTERNS));
    expect(fs.statSync(path.join(linked, '.git')).isFile()).toBe(true);
    expect(await ensureLocalExcludes(project)).toBe(false);
  });

  it('from a submodule writes the submodule\'s own git dir', async () => {
    const lib = repo('lib');
    const parent = repo('parent');
    git(['submodule', 'add', '-q', lib, 'vendor/lib'], parent);
    const sub = path.join(parent, 'vendor', 'lib');
    expect(await ensureLocalExcludes(sub)).toBe(true);
    const moduleExclude = path.join(parent, '.git', 'modules', 'vendor', 'lib', 'info', 'exclude');
    expect(linesOf(moduleExclude)).toEqual(expect.arrayContaining(CLUBHOUSE_LOCAL_PATTERNS));
    expect(fs.existsSync(path.join(parent, '.git', 'info', 'exclude')) && linesOf(path.join(parent, '.git', 'info', 'exclude')).includes('.clubhouse/agents/')).toBe(false);
  });

  it('for a project in a subfolder of the repository, anchors the patterns at that folder', async () => {
    const top = repo('mono');
    const project = path.join(top, 'packages', 'app');
    fs.mkdirSync(path.join(project, '.clubhouse'), { recursive: true });
    await ensureLocalExcludes(project);
    fs.writeFileSync(path.join(project, '.clubhouse', 'settings.json.bak'), 'x');
    expect(linesOf(path.join(top, '.git', 'info', 'exclude'))).toContain('packages/app/.clubhouse/settings.json.bak');
    expect(git(['status', '--porcelain'], top)).toBe('');
  });

  // Folder names that gitignore syntax would read as a comment, a negation or a glob. `*` and `?`
  // cannot be in a Windows folder name, so those cases run elsewhere only.
  const FOLDERS: Array<[string, string, boolean]> = [
    ['a leading #', '#notes', true],
    ['a leading !', '!bang', true],
    ['brackets', 'pkg[1]', true],
    ['a backslash', 'back\\slash', false],
    ['a star', 'star*', false],
    ['a question mark', 'what?', false],
  ];
  it.each(FOLDERS)('for a project folder with %s, git ignores that folder\'s files and no sibling\'s', async (_label, folder, windows) => {
    if (process.platform === 'win32' && !windows) return;
    const top = repo('special');
    const project = path.join(top, folder);
    fs.mkdirSync(path.join(project, '.clubhouse'), { recursive: true });
    const sibling = path.join(top, folder.replace(/[^a-z0-9]/gi, '') + 'x', '.clubhouse');
    fs.mkdirSync(sibling, { recursive: true });
    expect(await ensureLocalExcludes(project)).toBe(true);
    const ignored = (rel: string) => {
      try { git(['check-ignore', '-q', '--', rel], top); return true; } catch { return false; }
    };
    for (const name of ['settings.json.bak', 'settings.json.unreadable.3', 'agents.json']) {
      expect(ignored(`${folder}/.clubhouse/${name}`)).toBe(true);
    }
    expect(ignored(`${path.basename(path.dirname(sibling))}/.clubhouse/settings.json.bak`)).toBe(false);
    fs.writeFileSync(path.join(project, '.clubhouse', 'settings.json.bak'), 'x');
    expect(git(['status', '--porcelain', '--', folder], top)).toBe('');
  });

  it('ignores an inherited GIT_DIR and GIT_WORK_TREE and works on the project\'s own repository', async () => {
    const project = repo('mine');
    const other = repo('other');
    vi.stubEnv('GIT_DIR', path.join(other, '.git'));
    vi.stubEnv('GIT_WORK_TREE', other);
    try {
      expect(await ensureLocalExcludes(project)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(linesOf(path.join(project, '.git', 'info', 'exclude'))).toEqual(expect.arrayContaining(CLUBHOUSE_LOCAL_PATTERNS));
    expect(fs.existsSync(path.join(other, '.git', 'info', 'exclude')) && linesOf(path.join(other, '.git', 'info', 'exclude')).includes('.clubhouse/agents/')).toBe(false);
  });

  it('leaves a folder that is not a Git repository untouched', async () => {
    const plain = path.join(root, 'not-git');
    fs.mkdirSync(plain);
    expect(await ensureLocalExcludes(plain)).toBe(false);
    expect(fs.readdirSync(plain)).toEqual([]);
  });

  it('fails soft when .git/info cannot be written', async () => {
    const project = repo('unwritable');
    // A file where the info directory belongs makes the write fail on every platform.
    fs.rmSync(path.join(project, '.git', 'info'), { recursive: true, force: true });
    fs.writeFileSync(path.join(project, '.git', 'info'), 'blocker');
    expect(await ensureLocalExcludes(project)).toBe(false);
    expect(fs.readFileSync(path.join(project, '.git', 'info'), 'utf-8')).toBe('blocker');
    expect(git(['status', '--porcelain'], project)).toBe('');
  });

  it('once-per-project helper does the work only the first time', async () => {
    const project = repo('once');
    const exclude = path.join(project, '.git', 'info', 'exclude');
    await ensureLocalExcludesOnce(project);
    const first = fs.readFileSync(exclude, 'utf-8');
    fs.writeFileSync(exclude, '');
    await ensureLocalExcludesOnce(project);
    expect(fs.readFileSync(exclude, 'utf-8')).toBe('');
    expect(first).toContain('.clubhouse/settings.json.bak');
  });

  it('concurrent callers wait for the same work: the exclude is in place when any of them returns', async () => {
    const project = repo('concurrent');
    const exclude = path.join(project, '.git', 'info', 'exclude');
    const first = ensureLocalExcludesOnce(project);
    await ensureLocalExcludesOnce(project);
    expect(linesOf(exclude)).toEqual(expect.arrayContaining(CLUBHOUSE_LOCAL_PATTERNS));
    await first;
    expect(linesOf(exclude).filter((line) => line === '.clubhouse/settings.json.bak')).toHaveLength(1);
  });

  it('a run that could not install is forgotten, so a later call tries again', async () => {
    const folder = path.join(root, 'later-a-repo');
    fs.mkdirSync(folder);
    await ensureLocalExcludesOnce(folder);
    expect(fs.existsSync(path.join(folder, '.git'))).toBe(false);
    git(['init', '-q', '-b', 'main'], folder);
    await ensureLocalExcludesOnce(folder);
    expect(linesOf(path.join(folder, '.git', 'info', 'exclude'))).toEqual(expect.arrayContaining(CLUBHOUSE_LOCAL_PATTERNS));
  });

  it('an unwritable exclude file is retried by the next call once it can be written', async () => {
    const project = repo('retry');
    const info = path.join(project, '.git', 'info');
    fs.rmSync(info, { recursive: true, force: true });
    fs.writeFileSync(info, 'blocker');
    await ensureLocalExcludesOnce(project);
    fs.rmSync(info);
    await ensureLocalExcludesOnce(project);
    expect(linesOf(path.join(info, 'exclude'))).toEqual(expect.arrayContaining(CLUBHOUSE_LOCAL_PATTERNS));
  });
});
