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

import { hasSecretLookingContent } from './classify';
import { meetsMinimumGit } from './git-state';
import { scanImportInventory } from './inventory';
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

  describe('with local write access to .git/worktrees', () => {
    function localEntry(pointsAt: string): string {
      const project = makeDir('local');
      git(project, 'init', '-q', '-b', 'main');
      git(project, 'commit', '-q', '--allow-empty', '-m', 'x');
      write(project, '.git/worktrees/x/gitdir', `${pointsAt}\n`);
      write(project, '.git/worktrees/x/HEAD', 'ref: refs/heads/main\n');
      write(project, '.git/worktrees/x/commondir', '../..\n');
      setAgents(project, [{ id: 'a', name: 'a', worktreePath: outside }]);
      register([project]);
      return project;
    }

    /** All the check may do outside: look at that one `.git`. */
    const onlyItsGitFile = (call: string) => call.endsWith(`${outside}${path.sep}.git`) || call.endsWith(' ' + outside);

    it('refuses a `.git` folder', async () => {
      fs.mkdirSync(path.join(outside, '.git'));
      localEntry(`${outside}/.git`);

      const result = await scan();

      expect(result.externalReferences[0].reason).toBe('unverified-worktree');
      expect(result.entries).toEqual([]);
      expect(touchedOutside(onlyItsGitFile)).toEqual([]);
    });

    it('refuses a `.git` file naming some other git folder, without reading what it names', async () => {
      const elsewhere = path.join(root, 'elsewhere-gitdir');
      write(elsewhere, 'gitdir', `${outside}/.git\n`);
      write(outside, '.git', `gitdir: ${elsewhere}\n`);
      localEntry(`${outside}/.git`);

      const result = await scan();

      expect(result.externalReferences[0].reason).toBe('unverified-worktree');
      expect(result.entries).toEqual([]);
      expect(touchedOutside(onlyItsGitFile)).toEqual([]);
      expect(dirs.calls.filter((c) => c.includes(elsewhere))).toEqual([]);
    });

    it('refuses a `.git` file pointing at the entry when the entry points elsewhere', async () => {
      const project = localEntry(path.join(root, 'not-outside', '.git'));
      write(outside, '.git', `gitdir: ${path.join(project, '.git', 'worktrees', 'x')}\n`);

      const result = await scan();

      // git calls this entry prunable or lists another path, so it never vouches at all.
      expect(result.projects[0].agents[0].status).toBe('external');
      expect(result.entries).toEqual([]);
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

  it('doesn\'t ask git about a nested folder with a `.git` folder of its own', async () => {
    const project = makeDir('alpha');
    git(project, 'init', '-q', '-b', 'main');
    const nested = path.join(project, 'nested');
    fs.mkdirSync(nested);
    git(nested, 'init', '-q', '-b', 'main');
    write(nested, 'CLAUDE.md', 'x');
    setAgents(project, [{ id: 'a', name: 'a', worktreePath: nested }]);
    register([project]);

    const result = await scan();

    expect(instructionStates(result)).toEqual(['unknown']);
  });

  it('still answers for a plain folder inside the project, through the project\'s repo', async () => {
    const project = makeDir('alpha');
    git(project, 'init', '-q', '-b', 'main');
    write(project, 'plain/CLAUDE.md', 'x');
    setAgents(project, [{ id: 'a', name: 'a', worktreePath: path.join(project, 'plain') }]);
    register([project]);

    const result = await scan();

    expect(instructionStates(result)).toEqual(['untracked']);
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
  it('stays linear on text built to make the secret patterns rescan', () => {
    const size = 200_000;
    for (const text of [
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

  it('reads git user config from the given home, not the process\'s', async () => {
    const project = makeDir('hm');
    git(project, 'init', '-q', '-b', 'main');
    write(project, '.clubhouse/skills/s/SKILL.md', 'x');
    register([project]);
    const ignoreFile = write(root, 'global-ignore', 'SKILL.md\n');
    const state = async (options: Partial<InventoryOptions> = {}) => (await scan(options)).entries[0].sources[0].files[0].gitState;

    // What the process has set makes no difference.
    process.env.GIT_CONFIG_GLOBAL = write(root, 'process-config', `[core]\n\texcludesFile = ${ignoreFile}\n`);
    expect(await state()).toBe('untracked');

    // What the given home has set does.
    const given = makeDir('home-with-config');
    write(given, '.gitconfig', `[core]\n\texcludesFile = ${ignoreFile}\n`);
    expect(await state({ homeDir: given })).toBe('ignored');
  });
});
