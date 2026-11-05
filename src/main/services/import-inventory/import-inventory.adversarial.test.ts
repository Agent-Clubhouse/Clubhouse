import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A repository as an attacker would shape it, with a spy on every promise-fs call
// in the process, so peekDurableConfigs and anything else outside InventoryFs shows.

const dirs = vi.hoisted(() => ({ home: '', userData: '', calls: [] as string[] }));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (name: string) => (name === 'home' ? dirs.home : dirs.userData) },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
}));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../agent-system', () => ({ resolveOrchestrator: vi.fn() }));
vi.mock('../chat-idle-settings', () => ({ setAgentIdleSleep: vi.fn() }));
vi.mock('fs/promises', async (orig) => {
  const real = await orig<typeof import('fs/promises')>();
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(real)) {
    wrapped[name] = typeof value === 'function'
      ? (...args: unknown[]) => {
        if (typeof args[0] === 'string') dirs.calls.push(`${name} ${args[0]}`);
        return (value as (...a: unknown[]) => unknown)(...args);
      }
      : value;
  }
  return { ...wrapped, default: wrapped };
});

import { hasSecretLookingContent, isSafeEnvName, isSafeIdentifier } from './classify';
import { meetsMinimumGit } from './git-state';
import { scanImportInventory } from './inventory';
import { UnsafeFileError, readRegularFile } from './safe-read';
import { isGitConfigAllowed } from './untrusted-paths';
import type { ImportInventory } from '../../../shared/import-inventory-types';
import type { InventoryOptions } from './inventory';

vi.setConfig({ testTimeout: 60_000 });

const CONFIG_ARGS = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];
const POSIX_ONLY = process.platform === 'win32';

let root: string;
let outside: string;
let markers: string;
let savedEnv: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...CONFIG_ARGS, ...args], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(base: string, rel: string, content: string): string {
  const file = path.join(base, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function makeDir(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function register(paths: string[]): void {
  write(dirs.home, '.clubhouse-dev/projects.json', JSON.stringify({
    version: 1,
    projects: paths.map((p) => ({ id: path.basename(p), name: path.basename(p), path: p })),
  }));
}

function setAgents(project: string, agents: Array<Record<string, unknown>>): void {
  write(project, '.clubhouse/agents.json', JSON.stringify(agents.map((a) => ({ color: 'blue', createdAt: '2026-11-05T00:00:00.000Z', ...a }))));
}

function scan(options: Partial<InventoryOptions> = {}): Promise<ImportInventory> {
  dirs.calls.length = 0;
  return scanImportInventory({ homeDir: path.join(root, 'givenhome'), ...options });
}

/** Everything that went through promise-fs to the outside folder, apart from these operations on these paths. */
function touchedOutside(allowed: (call: string) => boolean = () => false): string[] {
  return dirs.calls.filter((call) => call.includes(outside) && !allowed(call));
}

function firedMarkers(): string[] {
  return fs.readdirSync(markers);
}

/** Files that read like a bare repo to git, carried as plain content. */
function bareShape(dir: string, config: string): void {
  write(dir, 'HEAD', 'ref: refs/heads/main\n');
  write(dir, 'objects/.keep', '');
  write(dir, 'refs/.keep', '');
  write(dir, 'config', config);
}

/** A config naming a program at every key that can, each leaving a marker if it runs. */
function hostileGitConfig(extra = ''): string {
  const program = path.join(root, 'prog.sh');
  fs.writeFileSync(program, `#!/bin/sh\ntouch "${markers}/script-$1"\nexit 0\n`, { mode: 0o755 });
  const shell = (name: string) => `sh -c 'touch "${markers}/${name}"'`;
  return [
    '[core]', '\trepositoryformatversion = 1', '\tbare = false', '\tworktree = .',
    `\tfsmonitor = ${program} fsmonitor`, `\tsshCommand = ${program} ssh`, `\thooksPath = ${markers}`, `\tpager = ${program} pager`,
    `\tattributesFile = ${outside}/attrs`,
    '[diff]', `\texternal = ${program} diffext`,
    '[filter "x"]', `\tclean = ${shell('clean')}`, `\tsmudge = ${shell('smudge')}`, `\tprocess = ${program} fprocess`, '\trequired = true',
    '[alias]', `\tls-files = !${shell('alias')}`, `\tcheck-ignore = !${shell('alias2')}`, `\tworktree = !${shell('alias3')}`,
    '[credential]', `\thelper = !${shell('cred')}`,
    '[gpg]', `\tprogram = ${program} gpg`,
    '[pager]', `\tls-files = ${program} p2`,
    extra,
  ].join('\n');
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'import-inventory-adv-')));
  dirs.home = path.join(root, 'apphome');
  dirs.userData = path.join(root, 'userdata');
  fs.mkdirSync(dirs.home);
  fs.mkdirSync(dirs.userData);
  fs.mkdirSync(path.join(root, 'givenhome'));
  outside = path.join(root, 'OUTSIDE');
  markers = path.join(root, 'markers');
  fs.mkdirSync(markers);
  write(outside, 'CLAUDE.md', 'OUTSIDE INSTRUCTIONS');
  write(outside, 'AGENTS.md', 'OUTSIDE AGENTS');
  write(outside, '.mcp.json', JSON.stringify({ mcpServers: { o: { command: 'o' } } }));
  savedEnv = {};
  const fixtureEnv: NodeJS.ProcessEnv = {
    HOME: dirs.home, USERPROFILE: dirs.home, XDG_CONFIG_HOME: dirs.home,
    GIT_CONFIG_GLOBAL: write(root, 'empty-gitconfig', ''), GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const [name, value] of Object.entries(fixtureEnv)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a repo-carried worktrees/ entry can\'t vouch for an outside path', () => {
  function carried(project: string): void {
    bareShape(project, '[core]\n\trepositoryformatversion = 0\n\tbare = true\n');
    write(project, 'worktrees/x/gitdir', `${outside}/.git\n`);
    write(project, 'worktrees/x/HEAD', 'ref: refs/heads/main\n');
    write(project, 'worktrees/x/commondir', '../..\n');
    setAgents(project, [{ id: 'a1', name: 'a1', worktreePath: outside }]);
  }

  function expectExternal(result: ImportInventory): void {
    expect(result.projects[0].agents.map((a) => a.status)).toEqual(['external']);
    expect(result.entries).toEqual([]);
  }

  it('from a plain folder, as a zip or tarball would leave it', async () => {
    fs.mkdirSync(path.join(outside, '.git'));
    const project = makeDir('zip');
    carried(project);
    register([project]);

    const result = await scan();

    expectExternal(result);
    expect(touchedOutside()).toEqual([]);
  });

  it('from the root of a real clone', async () => {
    fs.mkdirSync(path.join(outside, '.git'));
    const source = makeDir('src');
    git(source, 'init', '-q', '-b', 'main');
    carried(source);
    git(source, 'add', '-A');
    git(source, 'commit', '-qm', 'x');
    const clone = path.join(root, 'clone');
    git(root, 'clone', '-q', source, clone);
    register([clone]);

    const result = await scan();

    expectExternal(result);
    expect(touchedOutside()).toEqual([]);
  });

  it('from a registered subfolder of a real clone', async () => {
    fs.mkdirSync(path.join(outside, '.git'));
    const source = makeDir('src');
    git(source, 'init', '-q', '-b', 'main');
    carried(path.join(source, 'sub'));
    git(source, 'add', '-A');
    git(source, 'commit', '-qm', 'x');
    const clone = path.join(root, 'clone');
    git(root, 'clone', '-q', source, clone);
    register([path.join(clone, 'sub')]);

    const result = await scan();

    expectExternal(result);
    expect(touchedOutside()).toEqual([]);
  });

  describe('whatever the repo\'s own .git says', () => {
    /** Someone else's real repo, with a real linked worktree holding what a scan would like. */
    function victim(): { repo: string; worktree: string } {
      const repo = path.join(outside, 'repo');
      fs.mkdirSync(repo, { recursive: true });
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'x');
      const worktree = path.join(outside, 'wt');
      git(repo, 'worktree', 'add', '-q', '-b', 'wt/standby', worktree, 'main');
      write(worktree, 'CLAUDE.md', 'VICTIM INSTRUCTIONS');
      write(worktree, '.mcp.json', JSON.stringify({ mcpServers: { v: { command: 'v' } } }));
      return { repo, worktree };
    }

    function expectLeftAlone(result: ImportInventory): void {
      expect(result.projects[0].agents[0].status).toBe('external');
      expect(result.externalReferences[0].reason).toBe('outside-project');
      expect(result.entries).toEqual([]);
      expect(result.projects[0].agents[0].mcpFilesNotInventoried).toBe(0);
      expect(touchedOutside()).toEqual([]);
    }

    it('won\'t read another repo\'s worktree because the project\'s .git file names that repo', async () => {
      const { repo, worktree } = victim();
      const project = makeDir('alpha');
      write(project, '.git', `gitdir: ${path.join(repo, '.git')}\n`);
      setAgents(project, [{ id: 'a', name: 'a', worktreePath: worktree }]);
      register([project]);

      expectLeftAlone(await scan());
    });

    it('won\'t read it because .git/commondir names that repo', async () => {
      const { repo, worktree } = victim();
      const project = makeDir('alpha');
      git(project, 'init', '-q', '-b', 'main');
      write(project, '.git/commondir', `${path.join(repo, '.git')}\n`);
      setAgents(project, [{ id: 'a', name: 'a', worktreePath: worktree }]);
      register([project]);

      expectLeftAlone(await scan());
    });

    it('won\'t read it because .git/worktrees names it', async () => {
      const { worktree } = victim();
      const project = makeDir('alpha');
      git(project, 'init', '-q', '-b', 'main');
      git(project, 'commit', '-q', '--allow-empty', '-m', 'x');
      write(project, '.git/worktrees/x/gitdir', `${path.join(worktree, '.git')}\n`);
      write(project, '.git/worktrees/x/HEAD', 'ref: refs/heads/main\n');
      write(project, '.git/worktrees/x/commondir', '../..\n');
      setAgents(project, [{ id: 'a', name: 'a', worktreePath: worktree }]);
      register([project]);

      expectLeftAlone(await scan());
    });

    it('reads it once the person selects it, and then still doesn\'t ask git', async () => {
      const { worktree } = victim();
      const project = makeDir('alpha');
      git(project, 'init', '-q', '-b', 'main');
      setAgents(project, [{ id: 'a', name: 'a', worktreePath: worktree }]);
      register([project]);

      const result = await scan({ includeExternalRoots: [worktree] });

      const source = result.entries.find((e) => e.kind === 'agent-instructions')?.sources[0];
      expect(source?.worktreeAccess?.by).toBe('explicit-inclusion');
      expect(source?.files[0].gitState).toBe('unknown');
    });
  });
});

describe('an embedded bare repo can\'t control git', () => {
  function embedded(extra: string): string {
    const source = makeDir('bsrc');
    git(source, 'init', '-q', '-b', 'main');
    const evil = path.join(source, 'evil');
    bareShape(evil, hostileGitConfig(extra));
    write(evil, 'CLAUDE.md', 'in project');
    git(source, 'add', '-A');
    git(source, 'commit', '-qm', 'x');
    const clone = path.join(root, 'bclone');
    git(root, 'clone', '-q', source, clone);
    setAgents(clone, [{ id: 'a', name: 'a', worktreePath: path.join(clone, 'evil') }]);
    register([clone]);
    return clone;
  }

  const instructionStates = (result: ImportInventory) => result.entries
    .filter((e) => e.kind === 'agent-instructions')
    .map((e) => e.sources[0].files[0].gitState);

  it.skipIf(POSIX_ONLY)('runs nothing, and its excludesFile doesn\'t decide an answer', async () => {
    write(outside, 'canary-ignore', 'CLAUDE.md\n');
    embedded(`[core]\n\texcludesFile = ${outside}/canary-ignore\n`);

    const result = await scan();

    expect(firedMarkers()).toEqual([]);
    expect(instructionStates(result)).toEqual(['unknown']);
    expect(touchedOutside()).toEqual([]);
  });

  it.skipIf(POSIX_ONLY)('isn\'t reached through [include] either', async () => {
    write(outside, 'canary-ignore', 'CLAUDE.md\n');
    write(outside, 'inc', `[core]\n\texcludesFile = ${outside}/canary-ignore\n`);
    embedded(`[include]\n\tpath = ${outside}/inc\n`);

    const result = await scan();

    expect(firedMarkers()).toEqual([]);
    expect(instructionStates(result)).toEqual(['unknown']);
  });

  it.skipIf(POSIX_ONLY)('doesn\'t run core.sshCommand through a lazy fetch of a skip-worktree .gitignore', async () => {
    const source = makeDir('gsrc');
    git(source, 'init', '-q', '-b', 'main');
    const evil = path.join(source, 'evil');
    bareShape(evil, hostileGitConfig('[extensions]\n\tpartialClone = origin\n[remote "origin"]\n\turl = ssh://example.invalid/y\n\tpromisor = true\n'));
    write(evil, 'CLAUDE.md', 'in project');
    const env = { ...process.env, GIT_DIR: evil, GIT_WORK_TREE: evil, GIT_NO_LAZY_FETCH: '1' };
    const index = (...args: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', 'update-index', ...args], { env, stdio: 'pipe' });
    index('--add', '--cacheinfo', `100644,${'1'.repeat(40)},.gitignore`);
    index('--skip-worktree', '.gitignore');
    git(source, 'add', '-A');
    git(source, 'commit', '-qm', 'x');
    const clone = path.join(root, 'gclone');
    git(root, 'clone', '-q', source, clone);
    setAgents(clone, [{ id: 'a', name: 'a', worktreePath: path.join(clone, 'evil') }]);
    register([clone]);
    for (const f of firedMarkers()) fs.rmSync(path.join(markers, f));

    const result = await scan();

    expect(firedMarkers()).toEqual([]);
    expect(instructionStates(result)).toEqual(['unknown']);
  });

  it('doesn\'t ask git about a nested repo with a config it can\'t vouch for', async () => {
    const project = makeDir('alpha');
    git(project, 'init', '-q', '-b', 'main');
    const nested = path.join(project, 'nested');
    fs.mkdirSync(nested);
    git(nested, 'init', '-q', '-b', 'main');
    git(nested, 'config', 'core.excludesFile', path.join(outside, 'x').split(path.sep).join('/'));
    write(nested, 'CLAUDE.md', 'x');
    setAgents(project, [{ id: 'a', name: 'a', worktreePath: nested }]);
    register([project]);

    const result = await scan();

    expect(instructionStates(result)).toEqual(['unknown']);
    expect(result.projects[0].warnings).toContain('git-not-asked:git-config-not-allowed');
  });

  it('doesn\'t answer for a plain folder or a linked worktree inside the project', async () => {
    const project = makeDir('alpha');
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'commit', '-q', '--allow-empty', '-m', 'x');
    write(project, 'plain/CLAUDE.md', 'x');
    const linked = path.join(project, 'linked');
    git(project, 'worktree', 'add', '-q', '-b', 'linked/standby', linked, 'main');
    write(linked, 'AGENTS.md', 'y');
    setAgents(project, [{ id: 'a', name: 'a', worktreePath: path.join(project, 'plain') }, { id: 'b', name: 'b', worktreePath: linked }]);
    register([project]);

    const result = await scan();

    expect(instructionStates(result)).toEqual(['unknown', 'unknown']);
    expect(result.projects[0].warnings).toEqual(expect.arrayContaining(['git-not-asked:no-git-folder', 'git-not-asked:not-a-plain-git-folder']));
  });
});

describe('the git version floor', () => {
  it('reads the version strings git prints', () => {
    expect(meetsMinimumGit('git version 2.45.0\n')).toBe(true);
    expect(meetsMinimumGit('git version 2.50.1 (Apple Git-155)\n')).toBe(true);
    expect(meetsMinimumGit('git version 2.47.1.windows.2\n')).toBe(true);
    expect(meetsMinimumGit('git version 3.0.0\n')).toBe(true);
    expect(meetsMinimumGit('git version 2.44.3\n')).toBe(false);
    expect(meetsMinimumGit('git version 2.9.5\n')).toBe(false);
    expect(meetsMinimumGit('')).toBe(false);
    expect(meetsMinimumGit('not git')).toBe(false);
  });

  // A stand-in git on PATH, which only POSIX can run by that name without a shell.
  it.skipIf(POSIX_ONLY)('fails closed on older git: nothing vouched for, every file unknown, no repo touched', async () => {
    const project = makeDir('alpha');
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'commit', '-q', '--allow-empty', '-m', 'x');
    const worktree = path.join(root, 'elsewhere');
    git(project, 'worktree', 'add', '-q', '-b', 'lead/standby', worktree, 'main');
    write(project, '.clubhouse/skills/deploy/SKILL.md', 'x');
    setAgents(project, [{ id: 'a', name: 'a', worktreePath: worktree }]);
    register([project]);
    const invoked = path.join(root, 'old-git-args');
    const bin = makeDir('old-git-bin');
    fs.chmodSync(write(bin, 'git', `#!/bin/sh\necho "$@" >> "${invoked}"\necho "git version 2.30.0"\n`), 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;

    try {
      const result = await scan();

      expect(result.projects[0].agents[0].status).toBe('external');
      expect(result.entries[0].sources[0].files[0].gitState).toBe('unknown');
      expect(result.projects[0].warnings).toContain('git-below-minimum-version');
      expect(fs.readFileSync(invoked, 'utf-8').trim().split('\n')).toEqual(['--version']);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe('huge input', () => {
  it('keeps the secret patterns linear on long repetitive text', () => {
    const size = 200_000;
    for (const text of [
      'a'.repeat(size),
      'sk-'.repeat(size / 3),
      'xoxb-'.repeat(size / 5),
      '-----BEGIN '.repeat(size / 11),
      `-----BEGIN ${'A'.repeat(size)}`,
      `password${' '.repeat(size)}`,
      'password '.repeat(size / 9),
      `ghp_${'a'.repeat(size)} `,
    ]) {
      const started = Date.now();
      hasSecretLookingContent(text);
      expect(Date.now() - started).toBeLessThan(5000);
    }
  });

  // What once took 10 s at 160k characters, on the main process, past any deadline: a regex over
  // these strings. Short enough here that a quadratic one fails this rather than hanging the run.
  it('isn\'t held up by long strings in a definition', async () => {
    const project = makeDir('long');
    const long = 'a'.repeat(300_000);
    write(project, '.mcp.json', JSON.stringify({ mcpServers: { a: { command: long, args: [long], url: long }, b: { url: `https://${long}` } } }));
    register([project]);
    const started = Date.now();

    await scan();

    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('handles a config at the size limit, past a short deadline, without being held up', async () => {
    const project = makeDir('huge');
    const command = 'sk-'.repeat(2_500_000);
    write(project, '.mcp.json', JSON.stringify({ mcpServers: { a: { command, args: ['sk-'.repeat(100_000)], url: `https://${'a'.repeat(1_000_000)}` } } }));
    register([project]);
    const started = Date.now();

    const result = await scan({ projectTimeoutMs: 50 });

    expect(Date.now() - started).toBeLessThan(30_000);
    expect(['scanned', 'unavailable']).toContain(result.projects[0].status);
  });

  it('gives way to a deadline while reading many servers', async () => {
    const project = makeDir('many');
    const servers: Record<string, unknown> = {};
    for (let i = 0; i < 200_000; i++) servers[`s${i}`] = { command: 'x' };
    write(project, '.mcp.json', JSON.stringify({ mcpServers: servers }));
    register([project]);

    const result = await scan();

    expect(result.projects[0].truncated).toBe(true);
    expect(result.entries).toHaveLength(1000);
    expect(result.projects[0].excluded['over-limit']).toBe(199_000);
  });

  it('lets a short deadline fire while reading a very long list of servers', async () => {
    const project = makeDir('manyfast');
    const servers: Record<string, unknown> = {};
    for (let i = 0; i < 200_000; i++) servers[`s${i}`] = { command: 'x' };
    write(project, '.mcp.json', JSON.stringify({ mcpServers: servers }));
    register([project]);

    const result = await scan({ projectTimeoutMs: 20, limits: { maxServersPerFile: 1_000_000 } });

    expect(result.projects[0]).toMatchObject({ status: 'unavailable', reason: 'timeout' });
    expect(result.entries).toEqual([]);
  });

  it('survives settings nested deep enough to overflow a recursive walk', async () => {
    const project = makeDir('deep');
    write(project, '.clubhouse/settings.json', `{"agentDefaults":{"permissions":${'{"a":'.repeat(200_000)}1${'}'.repeat(200_000)}}}`);
    register([project]);

    const result = await scan();

    expect(result.projects[0].status).toBe('scanned');
  });

  it('won\'t parse an oversized agents.json', async () => {
    const project = makeDir('hugeagents');
    write(project, '.clubhouse/agents.json', JSON.stringify([{ id: 'a', name: 'x'.repeat(2048) }]));
    register([project]);

    const result = await scan({ limits: { maxConfigFileBytes: 1024 } });

    expect(result.projects[0].agents).toEqual([]);
    expect(result.projects[0].warnings).toContain('agent-config-not-read');
    expect(result.projects[0].excluded['too-large']).toBe(1);
  });

  it('caps a TOML config harder than JSON, since it\'s parsed here', async () => {
    const project = makeDir('bigtoml');
    write(project, '.codex/config.toml', `[mcp_servers.a]\ncommand = "x"\nnote = "${'n'.repeat(4096)}"\n`);
    register([project]);

    const result = await scan({ limits: { maxTomlBytes: 1024 } });

    expect(result.entries).toEqual([]);
    expect(result.projects[0].excluded['too-large']).toBe(1);
  });
});

describe('free text in agents.json', () => {
  const token = `ghp_${'a'.repeat(36)}`;

  it('reports its identity, and the text only when it\'s a plain id', async () => {
    const project = makeDir('freetext');
    setAgents(project, [
      { id: 'a', name: 'n', mission: `use ${token}`, persona: { deep: token } },
      { id: 'b', name: 'm', mission: 'ship-it', persona: 'qa' },
    ]);
    write(project, '.clubhouse/settings.json', JSON.stringify({ agentDefaults: { mission: `default ${token}` } }));
    register([project]);

    const result = await scan();

    const [hostile, plain] = result.projects[0].agents;
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(hostile.mission).toEqual({ hash: sha(`use ${token}`), length: token.length + 4 });
    expect(hostile.persona?.id).toBeUndefined();
    expect(plain.mission).toEqual({ id: 'ship-it', hash: sha('ship-it'), length: 7 });
    expect(plain.persona?.id).toBe('qa');
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('keeps a default mission out of the Clubhouse Mode result too', async () => {
    const project = makeDir('mode');
    write(project, '.clubhouse/settings.json', JSON.stringify({ agentDefaults: { mission: `default ${token}`, persona: { deep: token } } }));
    write(dirs.userData, 'clubhouse-mode-settings.json', JSON.stringify({ enabled: true }));
    register([project]);

    const result = await scan();

    expect(result.projects[0].clubhouseMode.effective?.defaultMission?.id).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('won\'t echo an agent name or id that could be anything', async () => {
    const project = makeDir('names');
    const worktree = path.join(project, 'wt');
    write(worktree, 'CLAUDE.md', 'x');
    setAgents(project, [{ id: `id ${token}`, name: `name ${token}`, worktreePath: worktree }, { id: 'c', name: 'far', worktreePath: outside }]);
    register([project]);

    const result = await scan();

    expect(result.projects[0].agents[0].name).toMatch(/^agent-[0-9a-f]{12}$/);
    expect(result.projects[0].agents[1].name).toBe('far');
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('won\'t list an unknown @@ token, which is just text', async () => {
    const project = makeDir('tokens');
    write(project, '.clubhouse/skills/s/SKILL.md', 'a @@AgentName b @@hunter2Secret c @@Pathology d\n');
    register([project]);

    const result = await scan();

    expect(result.entries[0].wildcards).toEqual(['@@AgentName']);
  });
});

describe('the agents folder, by identity', () => {
  it('refuses another name for it where the filesystem folds that name', async () => {
    const project = makeDir('uni');
    write(project, '.clubhouse/agents/gen/SKILL/SKILL.md', 'generated');
    // U+017F. APFS folds this to `s`; elsewhere it's a different folder, or none.
    const folded = 'agent\u017f';
    write(project, '.clubhouse/settings.json', JSON.stringify({ defaultSkillsPath: folded }));
    register([project]);
    const sameFolder = fs.existsSync(path.join(project, '.clubhouse', folded));

    const result = await scan();

    expect(result.entries.filter((e) => e.kind === 'skill')).toEqual([]);
    if (sameFolder) expect(result.projects[0].warnings).toContain('source-folder-outside-clubhouse:skills');
  });

  it('refuses a case variant by identity where the filesystem folds case', async () => {
    const project = makeDir('case');
    write(project, '.clubhouse/agents/gen/SKILL.md', 'generated');
    write(project, '.clubhouse/settings.json', JSON.stringify({ defaultSkillsPath: 'AGENTS/gen' }));
    register([project]);

    const result = await scan();

    expect(result.entries.filter((e) => e.kind === 'skill')).toEqual([]);
  });
});

describe('the home folder', () => {
  it('won\'t follow the app folder under it out', async () => {
    write(outside, 'personas/q.md', 'persona');
    try {
      fs.symlinkSync(outside, path.join(root, 'givenhome', '.clubhouse-dev'), 'junction');
    } catch {
      return; // telemetry-exempt: nothing to test without the privilege
    }
    register([]);

    const result = await scan({ includeProviderConfig: true });

    expect(result.providerEntries).toEqual([]);
    expect(touchedOutside()).toEqual([]);
  });

  it('reads no user config for git, from the process or the given home', async () => {
    const project = makeDir('hm');
    git(project, 'init', '-q', '-b', 'main');
    write(project, '.clubhouse/skills/s/SKILL.md', 'x');
    register([project]);
    const ignoreFile = write(root, 'global-ignore', 'SKILL.md\n').split(path.sep).join('/');
    const config = `[core]\n\texcludesFile = ${ignoreFile}\n`;
    const state = async (options: Partial<InventoryOptions> = {}) => (await scan(options)).entries[0].sources[0].files[0].gitState;

    process.env.GIT_CONFIG_GLOBAL = write(root, 'process-config', config);
    expect(await state()).toBe('untracked');

    const given = makeDir('home-with-config');
    write(given, '.gitconfig', config);
    write(given, '.config/git/ignore', 'SKILL.md\n');
    expect(await state({ homeDir: given })).toBe('untracked');
    process.env.HOME = given;
    process.env.USERPROFILE = given;
    expect(await state()).toBe('untracked');
  });
});

// Reproductions from the third review, each with what it found.
describe('git only runs on a repo it can\'t be led out of', () => {
  /** A stand-in git that logs each call and runs the real one. POSIX only: Windows won't run it by that name. */
  function loggingGit(): { repoCalls: () => string[]; restore: () => void } {
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim();
    const log = path.join(root, 'git-calls');
    const bin = makeDir('logging-git-bin');
    fs.chmodSync(write(bin, 'git', `#!/bin/sh\necho "$*" >> "${log}"\nexec "${real}" "$@"\n`), 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    return {
      repoCalls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n').filter((l) => l !== '--version') : []),
      restore: () => { process.env.PATH = originalPath; },
    };
  }

  function plainRepo(): string {
    const project = makeDir('alpha');
    git(project, 'init', '-q', '-b', 'main');
    write(project, '.clubhouse/skills/deploy/SKILL.md', 'x');
    return project;
  }

  /** A FIFO git would block on, were it opened. */
  function fifo(file: string): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    execFileSync('mkfifo', [file]);
    return file;
  }

  const appendConfig = (project: string, text: string) => fs.appendFileSync(path.join(project, '.git', 'config'), text);
  const hostile: Array<[string, (project: string, target: string) => void, string]> = [
    ['include.path', (p, t) => appendConfig(p, `[include]\n\tpath = ${t}\n`), 'git-config-not-allowed'],
    ['includeIf', (p, t) => appendConfig(p, `[includeIf "gitdir:**"]\n\tpath = ${t}\n`), 'git-config-not-allowed'],
    ['core.excludesFile', (p, t) => appendConfig(p, `[core]\n\texcludesFile = ${t}\n`), 'git-config-not-allowed'],
    ['core.worktree', (p, t) => appendConfig(p, `[core]\n\tworktree = ${t}\n`), 'git-config-not-allowed'],
    ['a key in a different case', (p, t) => appendConfig(p, `[CORE]\n\tEXCLUDESFILE = ${t}\n`), 'git-config-not-allowed'],
    ['a .git file', (p, t) => { fs.rmSync(path.join(p, '.git'), { recursive: true }); write(p, '.git', `gitdir: ${t}\n`); }, 'not-a-plain-git-folder'],
    ['a .git symlink', (p, t) => { fs.rmSync(path.join(p, '.git'), { recursive: true }); fs.symlinkSync(t, path.join(p, '.git')); }, 'not-a-plain-git-folder'],
    ['commondir', (p, t) => write(p, '.git/commondir', `${t}\n`), 'linked-git-folder'],
    ['a symlinked info/exclude', (p, t) => { fs.mkdirSync(path.join(p, '.git', 'info'), { recursive: true }); fs.rmSync(path.join(p, '.git', 'info', 'exclude'), { force: true }); fs.symlinkSync(t, path.join(p, '.git', 'info', 'exclude')); }, 'unsafe-git-folder'],
    ['a symlinked config', (p, t) => { fs.rmSync(path.join(p, '.git', 'config')); fs.symlinkSync(t, path.join(p, '.git', 'config')); }, 'unsafe-git-folder'],
    ['a FIFO in .git', (p) => { fifo(path.join(p, '.git', 'sharedindex.x')); }, 'unsafe-git-folder'],
    ['a FIFO .gitignore', (p) => { fifo(path.join(p, '.clubhouse', '.gitignore')); }, 'unsafe-gitignore'],
    ['a hard-linked index', (p, t) => { fs.linkSync(write(root, 'some-index', 'x'), path.join(p, '.git', 'index')); void t; }, 'unsafe-git-folder'],
    ['alternates', (p, t) => write(p, '.git/objects/info/alternates', `${t}\n`), 'unsafe-git-folder'],
  ];

  it.skipIf(POSIX_ONLY).each(hostile)('doesn\'t spawn git on %s', async (_label, shape, reason) => {
    const project = plainRepo();
    const target = fifo(path.join(outside, 'trap'));
    shape(project, target);
    register([project]);
    const logging = loggingGit();
    const started = Date.now();

    try {
      const result = await scan();

      expect(Date.now() - started).toBeLessThan(15_000);
      expect(logging.repoCalls()).toEqual([]);
      expect(result.projects[0].warnings).toContain(`git-not-asked:${reason}`);
      expect(result.entries[0].sources[0].files[0].gitState).toBe('unknown');
      expect(touchedOutside()).toEqual([]);
    } finally {
      logging.restore();
    }
  });

  it.skipIf(POSIX_ONLY)('doesn\'t let a parent repo answer for a plain project below it', async () => {
    const parent = makeDir('parent');
    git(parent, 'init', '-q', '-b', 'main');
    write(parent, '.gitignore', 'SKILL.md\n');
    const project = path.join(parent, 'project');
    write(project, '.clubhouse/skills/deploy/SKILL.md', 'x');
    register([project]);
    const logging = loggingGit();

    try {
      const result = await scan();

      expect(logging.repoCalls()).toEqual([]);
      expect(result.entries[0].sources[0].files[0].gitState).toBe('unknown');
    } finally {
      logging.restore();
    }
  });

  it.skipIf(POSIX_ONLY)('does spawn git on a plain repo, so the checks above aren\'t passing by never running it', async () => {
    const project = plainRepo();
    register([project]);
    const logging = loggingGit();

    try {
      const result = await scan();

      expect(logging.repoCalls().length).toBeGreaterThan(0);
      expect(result.entries[0].sources[0].files[0].gitState).toBe('untracked');
      expect(result.projects[0].warnings.filter((w) => w.startsWith('git-not-asked'))).toEqual([]);
    } finally {
      logging.restore();
    }
  });

  it('allows only config it recognizes, syntax included', () => {
    const allowed = isGitConfigAllowed;
    expect(allowed('[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tignorecase = true\n')).toBe(true);
    expect(allowed('[remote "origin"]\n\turl = git@example.com:a/b.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n')).toBe(true);
    expect(allowed('# comment\n; comment\n\n[user]\n\tname = A\n')).toBe(true);
    for (const text of [
      '[include]\n\tpath = x\n',
      '[INCLUDE]\n\tPATH = x\n',
      '[includeIf "gitdir:x"]\n\tpath = y\n',
      '[core]\n\tworktree = x\n',
      '[core]\n\texcludesFile = x\n',
      '[core]\n\tattributesFile = x\n',
      '[core]\n\tfsmonitor = x\n',
      '[core]\n\tbare = true\n',
      '[core]\n\tbare\n',
      '[core]\n\trepositoryformatversion = 2\n',
      '[extensions]\n\tworktreeConfig = true\n',
      '[extensions]\n\tpartialClone = origin\n',
      '[remote "o"]\n\tpromisor = true\n',
      '[remote "o"]\n\turl = \\\\host\\share\n',
      '[remote "o"]\n\turl = //host/share\n',
      '[user]\n\tname = a\\\n\tpath = x\n',
      '[user]\n\tname = "quoted\n',
      '[core.worktree]\n',
      '[core] filemode = true\n',
      'filemode = true\n',
      'not config at all',
    ]) {
      expect(allowed(text), text).toBe(false);
    }
  });

  it('accepts the config git itself writes, on this platform', () => {
    const project = plainRepo();
    expect(isGitConfigAllowed(fs.readFileSync(path.join(project, '.git', 'config'), 'utf-8'))).toBe(true);
  });
});

describe('special files', () => {
  function fifo(file: string): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    execFileSync('mkfifo', [file]);
    return file;
  }

  it.skipIf(POSIX_ONLY)('isn\'t hung by FIFO agents.json files, and nothing else in the process stalls', async () => {
    const projects: string[] = [];
    for (let i = 0; i < 5; i++) {
      const project = makeDir(`fifo-${i}`);
      fifo(path.join(project, '.clubhouse', 'agents.json'));
      projects.push(project);
    }
    register(projects);
    const started = Date.now();

    const result = await scan({ projectTimeoutMs: 300 });

    expect(Date.now() - started).toBeLessThan(10_000);
    for (const report of result.projects) {
      expect(report.status).toBe('scanned');
      expect(report.excluded['special-file']).toBe(1);
      expect(report.warnings).toContain('agent-config-not-read');
    }
    const other = Date.now();
    await fs.promises.readFile(path.join(root, 'empty-gitconfig'));
    expect(Date.now() - other).toBeLessThan(2000);
  });

  it.skipIf(POSIX_ONLY).each([
    '.clubhouse/agents.json.bak',
    '.clubhouse/settings.json',
    '.clubhouse/skills/s/SKILL.md',
    '.clubhouse/personas/p.md',
    '.mcp.json',
    '.codex/config.toml',
    '.github/mcp.json',
  ])('never opens a FIFO at %s', async (rel) => {
    const project = makeDir('alpha');
    fifo(path.join(project, ...rel.split('/')));
    register([project]);

    const result = await scan({ projectTimeoutMs: 5000 });

    expect(result.projects[0].status).toBe('scanned');
    expect(result.projects[0].excluded['special-file']).toBe(1);
    expect(result.projects[0].exclusions).toContainEqual({ reason: 'special-file', relativePath: rel });
    expect(dirs.calls.filter((c) => c.startsWith('open ') && c.endsWith(path.basename(rel)))).toEqual([]);
  });

  it.skipIf(POSIX_ONLY)('never opens a FIFO in a worktree either, or a character device through a link', async () => {
    const project = makeDir('alpha');
    const worktree = path.join(project, 'wt');
    fifo(path.join(worktree, 'CLAUDE.md'));
    fifo(path.join(worktree, '.mcp.json'));
    fs.mkdirSync(path.join(project, '.clubhouse', 'skills', 's'), { recursive: true });
    fs.symlinkSync(os.devNull, path.join(project, '.clubhouse', 'skills', 's', 'SKILL.md'));
    setAgents(project, [{ id: 'a', name: 'a', worktreePath: worktree }]);
    register([project]);

    const result = await scan({ projectTimeoutMs: 5000 });

    expect(result.projects[0].status).toBe('scanned');
    expect(result.projects[0].excluded['special-file']).toBe(2);
    expect(result.projects[0].excluded.symlink).toBe(1);
    expect(result.entries).toEqual([]);
  });
});

describe('a file swapped after the check', () => {
  const swapTo = async (file: string, make: () => void) => {
    const hooks = { beforeOpen: () => { fs.rmSync(file); make(); } };
    return readRegularFile(file, 1024, hooks).then(() => 'read', (err: unknown) => (err instanceof UnsafeFileError ? err.reason : `other: ${(err as Error).message}`));
  };

  it('refuses a plain file read normally, as the control', async () => {
    const file = write(root, 'plain.md', 'x');
    expect((await readRegularFile(file, 1024)).toString()).toBe('x');
  });

  it.skipIf(POSIX_ONLY)('refuses a swap to a FIFO, without blocking', async () => {
    const file = write(root, 'swap.md', 'x');
    expect(await swapTo(file, () => execFileSync('mkfifo', [file]))).toBe('special-file');
  });

  it.skipIf(POSIX_ONLY)('refuses a swap to a symlink', async () => {
    const file = write(root, 'swap.md', 'x');
    const target = path.join(outside, 'CLAUDE.md');
    expect(await swapTo(file, () => fs.symlinkSync(target, file))).toBe('symlink');
  });

  it('refuses a swap to a hard link', async () => {
    const file = write(root, 'swap.md', 'x');
    const target = path.join(outside, 'CLAUDE.md');
    expect(await swapTo(file, () => fs.linkSync(target, file))).toBe('hard-link');
  });

  it('refuses a swap to another plain file', async () => {
    const file = write(root, 'swap.md', 'x');
    const hold = write(root, 'hold.md', 'y');
    // A rename keeps the file alive, so its inode can't be reused for the replacement.
    const hooks = { beforeOpen: () => { fs.renameSync(file, `${file}.old`); fs.renameSync(hold, file); } };
    await expect(readRegularFile(file, 1024, hooks)).rejects.toMatchObject({ reason: 'changed' });
  });

  it('refuses a file that outgrows the limit, even if the check passed', async () => {
    const file = write(root, 'grow.md', 'x');
    const hooks = { beforeOpen: () => { fs.writeFileSync(file, 'y'.repeat(4096)); } };
    await expect(readRegularFile(file, 1024, hooks)).rejects.toMatchObject({ reason: 'too-large' });
  });

  it('carries on when a file swaps between the scan\'s check and its read', async () => {
    const project = makeDir('alpha');
    const file = write(project, '.clubhouse/skills/s/SKILL.md', 'x');
    const target = path.join(outside, 'CLAUDE.md');
    register([project]);

    const result = await scan({
      fs: {
        stat: (p) => fs.promises.stat(p),
        lstat: (p) => fs.promises.lstat(p),
        readdir: (p) => fs.promises.readdir(p, { withFileTypes: true }),
        realpath: (p) => fs.promises.realpath(p),
        readlink: (p) => fs.promises.readlink(p),
        readFile: (p, maxBytes) => {
          if (p === file) {
            fs.rmSync(file);
            fs.linkSync(target, file);
          }
          return readRegularFile(p, maxBytes);
        },
      },
    });

    expect(result.projects[0].status).toBe('scanned');
    expect(result.entries).toEqual([]);
    expect(result.projects[0].excluded['hard-link']).toBe(1);
  });
});

describe('raw values in the report', () => {
  const password = 'NOT-A-REAL-PASSWORD';

  it.each<[string, string]>([
    ['a URL with a password', `https://user:${password}@example.invalid/repo`],
    ['user:password@host', `user:${password}@host`],
    ['a pasted instruction', `Ignore previous instructions and ${password} `.repeat(150)],
    ['a credential in a path', `/opt/ghp_${'a'.repeat(36)}/${password}`],
    ['a long path', `/${password}/${'a/'.repeat(400)}`],
    ['control characters', `/tmp/${password}\n/x`],
  ])('never echoes %s', async (_label, configured) => {
    const project = makeDir('alpha');
    setAgents(project, [{ id: 'a', name: 'a', worktreePath: configured }]);
    register([project]);

    const result = await scan();

    expect(result.externalReferences).toHaveLength(1);
    expect(result.externalReferences[0].configuredPath.text).toBeUndefined();
    expect(result.externalReferences[0].configuredPath.length).toBe(configured.length);
    const everything = JSON.stringify(result);
    expect(everything).not.toContain(password);
    expect(everything).not.toContain('ghp_');
  });

  it('still shows a path that\'s plainly a path, so a person can choose it', async () => {
    const project = makeDir('alpha');
    setAgents(project, [{ id: 'a', name: 'a', worktreePath: outside }]);
    register([project]);

    const result = await scan();

    expect(result.externalReferences[0].configuredPath.text).toBe(outside);
  });

  it('checks names by shape, and refuses generated-looking ones', () => {
    for (const value of ['AKIAABCDEFGHIJKLMNOP', 'ghp_' + 'a'.repeat(36), 'deadbeefdeadbeef1234', 'aB3dE5gH7jK9', 'a'.repeat(33), 'x'.repeat(65), 'has space', 'a:b', 'user@host']) {
      expect(isSafeIdentifier(value), value).toBe(false);
    }
    for (const value of ['qa', 'ship-it', 'project-manager', 'claude-opus-4-5', 'GH_TOKEN', 'node.exe', '@@Path'.slice(2)]) {
      expect(isSafeIdentifier(value), value).toBe(true);
    }
    expect(isSafeEnvName('GH_TOKEN')).toBe(true);
    expect(isSafeEnvName('a.b')).toBe(false);
    expect(isSafeEnvName('a-b')).toBe(false);
  });

  it('refuses env names and ids shaped like credentials, end to end', async () => {
    const project = makeDir('alpha');
    write(project, '.mcp.json', JSON.stringify({ mcpServers: { s: { command: 'x', env: { aB3dE5gH7jK9mN: 'v', GOOD_NAME: 'v' } } } }));
    setAgents(project, [{ id: 'a', name: 'a', mission: 'aB3dE5gH7jK9mN' }]);
    register([project]);

    const result = await scan();

    expect(result.entries[0].mcp?.envNames).toEqual(['GOOD_NAME']);
    expect(result.projects[0].agents[0].mission?.id).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('aB3dE5gH7jK9mN');
  });

  it('refuses a folder or file name shaped like a credential, without showing it', async () => {
    const project = makeDir('alpha');
    const token = `ghp_${'a'.repeat(36)}`;
    write(project, `.clubhouse/skills/${token}/SKILL.md`, 'x');
    write(project, `.clubhouse/skills/ok/${token}.md`, 'y');
    write(project, '.clubhouse/skills/ok/SKILL.md', 'z');
    write(project, `.clubhouse/personas/${token}.md`, 'p');
    register([project]);

    const result = await scan();

    expect(result.entries.map((e) => e.name)).toEqual(['ok']);
    expect(result.projects[0].excluded['unsafe-name']).toBe(3);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it.skipIf(process.platform === 'darwin' || POSIX_ONLY)('refuses a name that isn\'t valid UTF-8', async () => {
    const project = makeDir('alpha');
    write(project, '.clubhouse/skills/ok/SKILL.md', 'z');
    const skills = path.join(project, '.clubhouse', 'skills');
    fs.mkdirSync(Buffer.concat([Buffer.from(`${skills}/`), Buffer.from([0x66, 0xff, 0x6f])]));
    register([project]);

    const result = await scan();

    expect(result.entries.map((e) => e.name)).toEqual(['ok']);
    expect(result.projects[0].excluded['unsafe-name']).toBe(1);
  });

  it('keeps names differing only in case apart by id, where the filesystem has both', async () => {
    const project = makeDir('alpha');
    write(project, '.clubhouse/skills/Deploy/SKILL.md', 'one');
    const lower = path.join(project, '.clubhouse', 'skills', 'deploy');
    const distinct = !fs.existsSync(lower);
    if (distinct) write(project, '.clubhouse/skills/deploy/SKILL.md', 'two');
    register([project]);

    const result = await scan();

    if (distinct) {
      expect(new Set(result.entries.map((e) => e.id)).size).toBe(2);
      expect(result.entries.every((e) => e.conflict)).toBe(true);
    } else {
      expect(result.entries).toHaveLength(1);
    }
  });
});

describe('hard links', () => {
  it.each([
    ['a skill', '.clubhouse/skills/s/SKILL.md'],
    ['a persona', '.clubhouse/personas/p.md'],
    ['.mcp.json', '.mcp.json'],
    ['an agent\'s instructions', 'wt/CLAUDE.md'],
  ])('won\'t read outside content through %s', async (_label, rel) => {
    const project = makeDir('alpha');
    const at = path.join(project, ...rel.split('/'));
    fs.mkdirSync(path.dirname(at), { recursive: true });
    const secret = path.join(outside, 'CLAUDE.md');
    fs.linkSync(secret, at);
    if (rel.startsWith('wt')) setAgents(project, [{ id: 'a', name: 'a', worktreePath: path.dirname(at) }]);
    register([project]);

    const result = await scan();

    expect(result.entries).toEqual([]);
    expect(result.projects[0].excluded['hard-link']).toBe(1);
    expect(result.projects[0].exclusions).toContainEqual({ reason: 'hard-link', relativePath: rel.startsWith('wt') ? 'CLAUDE.md' : rel });
    expect(JSON.stringify(result)).not.toContain(createHash('sha256').update('OUTSIDE INSTRUCTIONS').digest('hex'));
    expect(dirs.calls.filter((c) => c.startsWith('open ') && c.endsWith(rel.split('/').pop() as string))).toEqual([]);
  });
});

describe('one bad MCP entry', () => {
  const deep = (depth: number) => `${'['.repeat(depth)}${']'.repeat(depth)}`;
  const config = (depth: number) => `{"mcpServers":{"deep":{"command":"x","args":${deep(depth)}},"good":{"command":"g"}}}`;

  it('costs only itself when nested deeply, in .mcp.json', async () => {
    const project = makeDir('alpha');
    write(project, '.mcp.json', config(5000));
    write(project, '.clubhouse/skills/s/SKILL.md', 'x');
    register([project]);

    const result = await scan();

    expect(result.projects[0].status).toBe('scanned');
    expect(result.entries.map((e) => e.name)).toEqual(['good', 's']);
    expect(result.projects[0].excluded['non-definition']).toBe(1);
  });

  it('costs only itself in the project defaults and a worktree', async () => {
    const project = makeDir('alpha');
    write(project, '.clubhouse/settings.json', `{"agentDefaults":{"mcpJson":${JSON.stringify(config(5000))}}}`);
    write(project, 'wt/.mcp.json', config(5000));
    setAgents(project, [{ id: 'a', name: 'a', worktreePath: path.join(project, 'wt') }]);
    register([project]);

    const result = await scan();

    expect(result.projects[0].status).toBe('scanned');
    expect(result.entries.map((e) => e.name)).toEqual(['good']);
    expect(result.projects[0].agents[0].mcpFilesNotInventoried).toBe(1);
  });

  it('caps a worktree\'s TOML as hard as a project\'s', async () => {
    const project = makeDir('alpha');
    write(project, 'wt/.codex/config.toml', `[mcp_servers.a]\ncommand = "x"\nnote = "${'n'.repeat(4096)}"\n`);
    setAgents(project, [{ id: 'a', name: 'a', worktreePath: path.join(project, 'wt') }]);
    register([project]);

    const result = await scan({ limits: { maxTomlBytes: 1024 } });

    expect(result.projects[0].excluded['too-large']).toBe(1);
    expect(result.projects[0].exclusions).toContainEqual({ reason: 'too-large', relativePath: '.codex/config.toml' });
  });
});

describe('what an import UI needs', () => {
  it('gives each entry an id that survives a rescan, and a move, and doesn\'t hold a path', async () => {
    const project = makeDir('alpha');
    write(project, '.clubhouse/skills/s/SKILL.md', 'x');
    write(project, '.clubhouse/personas/p.md', 'y');
    write(project, '.mcp.json', JSON.stringify({ mcpServers: { m: { command: 'c', args: ['a'] } } }));
    register([project]);

    const first = await scan();
    const second = await scan();
    write(project, '.clubhouse/skills/s/SKILL.md', 'changed');
    const edited = await scan();
    const moved = path.join(root, 'moved', 'alpha');
    fs.mkdirSync(path.dirname(moved));
    fs.renameSync(project, moved);
    register([moved]);
    const afterMove = await scan();

    const ids = (r: ImportInventory) => Object.fromEntries(r.entries.map((e) => [e.name, e.id]));
    expect(new Set(first.entries.map((e) => e.id)).size).toBe(3);
    expect(ids(second)).toEqual(ids(first));
    expect(ids(edited)).toEqual(ids(first));
    expect(ids(afterMove)).toEqual(ids(first));
    for (const e of first.entries) expect(e.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives the same MCP entry the same id and hash on every scan', async () => {
    const project = makeDir('alpha');
    write(project, '.mcp.json', JSON.stringify({ mcpServers: { m: { command: 'c', args: ['a'] } } }));
    register([project]);

    const [first, second] = [await scan(), await scan()];

    expect(second.entries[0].id).toBe(first.entries[0].id);
    expect(second.entries[0].contentHash).toBe(first.entries[0].contentHash);
  });

  it('keeps the id of a merged entry when a source is added, as long as its first remains', async () => {
    const a = makeDir('a');
    const b = makeDir('b');
    write(a, '.clubhouse/skills/s/SKILL.md', 'same');
    register([a]);
    const alone = await scan();
    write(b, '.clubhouse/skills/s/SKILL.md', 'same');
    register([a, b]);
    const merged = await scan();

    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0].sources.map((s) => s.id)).toContain(alone.entries[0].id);
    expect(merged.entries[0].sources.map((s) => s.id).sort()[0]).toBe(merged.entries[0].id);
  });

  it('lists exclusions with their relative path and a closed reason, up to a bound', async () => {
    const project = makeDir('alpha');
    write(project, '.clubhouse/skills/s/SKILL.md', 'ok');
    write(project, '.clubhouse/skills/s/.env', 'X=1');
    write(project, '.clubhouse/skills/s/logo.png', 'x');
    register([project]);

    const result = await scan();

    expect(result.projects[0].exclusions).toEqual(expect.arrayContaining([
      { reason: 'secret-looking', relativePath: '.clubhouse/skills/s/.env' },
      { reason: 'non-definition', relativePath: '.clubhouse/skills/s/logo.png' },
    ]));

    for (let i = 0; i < 250; i++) write(project, `.clubhouse/skills/s/f${i}.png`, 'x');
    const many = await scan();

    expect(many.projects[0].exclusions).toHaveLength(200);
    expect(many.projects[0].excluded['non-definition']).toBe(251);
  });
});
