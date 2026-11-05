import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Real files and real git in temp folders: what's under test is that a scan
// changes nothing and that git's answers are the ones reported.

const dirs = vi.hoisted(() => ({ home: '', userData: '' }));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (name: string) => (name === 'home' ? dirs.home : dirs.userData) },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
}));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('../agent-system', () => ({ resolveOrchestrator: vi.fn() }));
vi.mock('../chat-idle-settings', () => ({ setAgentIdleSleep: vi.fn() }));

import { appLog } from '../log-service';
import * as projectStore from '../project-store';
import { ensureDefaultSkills, getDefaultAgentTemplates } from '../materialization-service';
import { ClaudeCodeProvider } from '../../orchestrators/claude-code-provider';
import { CodexCliProvider } from '../../orchestrators/codex-cli-provider';
import { CopilotCliProvider } from '../../orchestrators/copilot-cli-provider';
import { PERSONA_TEMPLATES } from '../../../renderer/features/personas';
import type { ImportInventory, InventoryEntry } from '../../../shared/import-inventory-types';
import type { DurableAgentConfig } from '../../../shared/types';
import { INSTRUCTION_FILES, PROJECT_MCP_FILES, confinedJoin, projectPathKey, scanImportInventory, type InventoryFs, type InventoryOptions } from './inventory';
import { readGitStates, toGitPath } from './git-state';
import { checkConfiguredPath, parseWorktreeList } from './untrusted-paths';

// Real git on Windows CI is slow, and these spawn it several times each.
vi.setConfig({ testTimeout: 30_000 });

let root: string;
let savedEnv: Record<string, string | undefined> = {};

/** Every scan here names the fixture home. A scan without one is refused; see 'the home folder'. */
function scan(options: Partial<InventoryOptions> = {}): Promise<ImportInventory> {
  return scanImportInventory({ homeDir: dirs.home, ...options });
}

function sha(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function write(base: string, rel: string, content: string | Buffer): string {
  const file = path.join(base, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=Clubhouse Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeProject(name: string, opts: { repo?: boolean } = {}): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.repo !== false) {
    git(dir, 'init', '-q', '-b', 'main');
    write(dir, 'README.md', `# ${name}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
  }
  return dir;
}

function registerProjects(paths: string[]): void {
  const projects = paths.map((p) => ({ id: `id-${path.basename(p)}`, name: path.basename(p), path: p }));
  write(path.join(dirs.home, '.clubhouse-dev'), 'projects.json', JSON.stringify({ version: 1, projects }));
}

function setClubhouseMode(settings: { enabled: boolean; projectOverrides?: Record<string, boolean> }): void {
  write(dirs.userData, 'clubhouse-mode-settings.json', JSON.stringify(settings));
}

function setAgents(project: string, agents: Array<Partial<DurableAgentConfig> & { id: string; name: string }>): void {
  write(project, '.clubhouse/agents.json', JSON.stringify(agents.map((a) => ({ color: 'blue', createdAt: '2026-11-04T00:00:00.000Z', ...a }))));
}

function setSettings(project: string, settings: Record<string, unknown>): void {
  write(project, '.clubhouse/settings.json', JSON.stringify(settings));
}

function entry(result: ImportInventory, kind: string, name: string): InventoryEntry {
  const found = result.entries.find((e) => e.kind === kind && e.name === name);
  if (!found) throw new Error(`no ${kind} entry named ${name}: ${JSON.stringify(result.entries.map((e) => [e.kind, e.name]))}`);
  return found;
}

type Snapshot = Record<string, { type: string; size: number; mtimeMs: number; hash?: string }>;

/** Everything under `dir`, `.git` and ignored files included, with mtimes and hashes. */
function snapshotTree(dir: string): Snapshot {
  const snapshot: Snapshot = {};
  const visit = (current: string) => {
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, dirent.name);
      const stats = fs.lstatSync(full);
      const rel = path.relative(dir, full);
      if (dirent.isDirectory()) {
        snapshot[rel] = { type: 'dir', size: 0, mtimeMs: stats.mtimeMs };
        visit(full);
      } else if (dirent.isFile()) {
        snapshot[rel] = { type: 'file', size: stats.size, mtimeMs: stats.mtimeMs, hash: createHash('sha256').update(fs.readFileSync(full)).digest('hex') };
      } else {
        snapshot[rel] = { type: 'other', size: stats.size, mtimeMs: stats.mtimeMs };
      }
    }
  };
  visit(dir);
  return snapshot;
}

/** Real filesystem, recording every path touched. */
function recordingFs(): { fs: InventoryFs; touched: string[]; resolved: string[] } {
  const touched: string[] = [];
  // Where realpath ended up: it touches every step on the way, not just the path it's given.
  const resolved: string[] = [];
  const record = <T>(p: string, run: () => Promise<T>) => {
    touched.push(p);
    return run();
  };
  return {
    touched,
    resolved,
    fs: {
      stat: (p) => record(p, () => fsp.stat(p)),
      lstat: (p) => record(p, () => fsp.lstat(p)),
      readdir: (p) => record(p, () => fsp.readdir(p, { withFileTypes: true })),
      readFile: (p) => record(p, () => fsp.readFile(p)),
      realpath: (p) => record(p, async () => {
        const real = await fsp.realpath(p);
        resolved.push(real);
        return real;
      }),
      readlink: (p) => record(p, () => fsp.readlink(p)),
    },
  };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'import-inventory-')));
  dirs.home = path.join(root, '_home');
  dirs.userData = path.join(root, '_userData');
  fs.mkdirSync(dirs.home, { recursive: true });
  fs.mkdirSync(dirs.userData, { recursive: true });
  vi.mocked(appLog).mockClear();
  // A second wall behind the required homeDir: os.homedir() and git's user config land in the fixture too.
  savedEnv = {};
  const emptyGitConfig = write(dirs.home, '.gitconfig-empty', '');
  const fixtureEnv: NodeJS.ProcessEnv = {
    HOME: dirs.home, USERPROFILE: dirs.home, XDG_CONFIG_HOME: dirs.home,
    GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_NOSYSTEM: '1',
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

describe('the home folder', () => {
  it.each([
    ['nothing', undefined],
    ['no homeDir', {}],
    ['no homeDir with provider config on', { includeProviderConfig: true }],
    ['an empty homeDir', { homeDir: '' }],
    ['a relative homeDir', { homeDir: 'relative-home' }],
  ])('refuses %s, before any read', async (_label, options) => {
    registerProjects([makeProject('alpha')]);
    const recording = recordingFs();
    const projectsRead = vi.spyOn(projectStore, 'peekProjects');

    await expect(scanImportInventory({ ...(options as InventoryOptions), fs: recording.fs })).rejects.toThrow('homeDir');
    if (options === undefined) await expect((scanImportInventory as unknown as () => Promise<unknown>)()).rejects.toThrow('homeDir');

    expect(recording.touched).toEqual([]);
    expect(projectsRead).not.toHaveBeenCalled();
    projectsRead.mockRestore();
  });

  it('reads user-level config only under the home it was given', async () => {
    write(dirs.home, '.claude/skills/from-given/SKILL.md', 'x\n');
    const other = path.join(root, '_other-home');
    write(other, '.claude/skills/from-other/SKILL.md', 'y\n');
    write(other, '.clubhouse-dev/personas/from-other-persona.md', 'z\n');
    registerProjects([makeProject('alpha')]);
    const recording = recordingFs();

    const result = await scan({ homeDir: other, includeProviderConfig: true, fs: recording.fs });

    expect(result.providerEntries.map((e) => e.name).sort()).toEqual(['from-other', 'from-other-persona']);
    expect(recording.touched.filter((p) => p.startsWith(dirs.home))).toEqual([]);
  });

  it('has no way to the real home in library code', () => {
    const sources = fs.readdirSync(__dirname).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(sources.length).toBeGreaterThan(3);
    for (const file of sources) {
      const text = fs.readFileSync(path.join(__dirname, file), 'utf-8');
      expect(text, file).not.toMatch(/homedir|from 'os'|getPath\(/);
    }
  });
});

describe('project source folders', () => {
  it('reports skills, agent templates, personas and defaults, wildcards unexpanded', async () => {
    const project = makeProject('alpha');
    const skill = 'Deploy from @@StandbyBranch as @@AgentName\n';
    write(project, '.clubhouse/skills/deploy/SKILL.md', skill);
    write(project, '.clubhouse/skills/deploy/scripts/run.sh', 'echo hi\n');
    write(project, '.clubhouse/agent-templates/reviewer/README.md', 'A reviewer\n');
    const persona = '---\nmodel: opus\nskills: [{"name":"deploy","cadence":"1h"}]\n---\nBe careful at @@Path\n';
    write(project, '.clubhouse/personas/careful.md', persona);
    setSettings(project, { agentDefaults: { instructions: 'House rules for @@AgentName', permissions: { allow: ['Read(@@Path**)'] } } });
    registerProjects([project]);

    const result = await scan();

    expect(result.status).toBe('complete');
    const deploy = entry(result, 'skill', 'deploy');
    expect(deploy.scope).toBe('project');
    expect(deploy.wildcards).toEqual(['@@AgentName', '@@StandbyBranch']);
    expect(deploy.sources[0].projectId).toBe('id-alpha');
    expect(deploy.sources[0].path).toBe(path.join(project, '.clubhouse', 'skills', 'deploy'));
    const skillFile = deploy.sources[0].files.find((f) => f.relativePath === '.clubhouse/skills/deploy/SKILL.md');
    expect(skillFile?.contentHash).toBe(sha(skill));
    expect(deploy.sources[0].files).toHaveLength(2);

    expect(entry(result, 'agent-template', 'reviewer').sources[0].files).toHaveLength(1);

    const carefulEntry = entry(result, 'persona', 'careful');
    expect(carefulEntry.contentHash).toBe(sha(persona));
    expect(carefulEntry.wildcards).toEqual(['@@Path']);
    expect(carefulEntry.persona).toEqual({ frontMatterKeys: ['model', 'skills'], inertSkillDeclarations: ['deploy'] });

    const instructions = entry(result, 'default-instructions', 'default instructions');
    expect(instructions.sources[0].pointer).toBe('agentDefaults.instructions');
    expect(instructions.contentHash).toBe(sha('House rules for @@AgentName'));
    expect(instructions.wildcards).toEqual(['@@AgentName']);
    expect(entry(result, 'default-permissions', 'default permissions').wildcards).toEqual(['@@Path']);
  });

  it('never returns file contents', async () => {
    const project = makeProject('alpha');
    write(project, '.clubhouse/skills/deploy/SKILL.md', 'UNIQUE-BODY-TEXT\n');
    setSettings(project, { agentDefaults: { instructions: 'UNIQUE-DEFAULTS-TEXT' } });
    registerProjects([project]);

    const serialized = JSON.stringify(await scan());
    expect(serialized).not.toContain('UNIQUE-BODY-TEXT');
    expect(serialized).not.toContain('UNIQUE-DEFAULTS-TEXT');
  });

  it('honors a custom source folder but not one outside .clubhouse', async () => {
    const project = makeProject('alpha');
    write(project, '.clubhouse/my-skills/deploy/SKILL.md', 'custom\n');
    write(project, 'outside/stolen/SKILL.md', 'outside\n');
    setSettings(project, { defaultSkillsPath: 'my-skills', defaultAgentsPath: path.join('..', '..', 'outside') });
    registerProjects([project]);

    const result = await scan();

    expect(entry(result, 'skill', 'deploy').sources[0].files).toHaveLength(1);
    expect(result.entries.some((e) => e.name === 'stolen')).toBe(false);
    expect(result.projects[0].warnings).toContain('source-folder-outside-clubhouse:agent-templates');
  });

  it('won\'t take a source folder that would walk generated worktrees, whatever its case', async () => {
    const project = makeProject('alpha');
    write(project, '.clubhouse/agents/lead/CLAUDE.md', 'generated\n');
    setSettings(project, { defaultSkillsPath: 'Agents', defaultAgentsPath: '.' });
    registerProjects([project]);

    const result = await scan();

    expect(result.entries).toEqual([]);
    expect(result.projects[0].warnings).toEqual(['source-folder-outside-clubhouse:agent-templates', 'source-folder-outside-clubhouse:skills']);
  });

  it('counts missions and loose template files without offering them', async () => {
    const project = makeProject('alpha');
    write(project, '.clubhouse/missions/ship.md', 'Ship it\n');
    write(project, '.clubhouse/agent-templates/loose.md', 'Listed by nothing\n');
    registerProjects([project]);

    const result = await scan();

    expect(result.entries).toEqual([]);
    expect(result.projects[0].missionsNotInventoried).toBe(1);
    expect(result.projects[0].excluded['non-definition']).toBe(1);
  });

  it('reads the settings backup when the main file is corrupt, without keeping the parse error', async () => {
    const project = makeProject('alpha');
    write(project, '.clubhouse/settings.json', '{ "agentDefaults": LEAKY-CORRUPT-TEXT');
    write(project, '.clubhouse/settings.json.bak', JSON.stringify({ agentDefaults: { instructions: 'From backup' } }));
    registerProjects([project]);

    const result = await scan();

    expect(entry(result, 'default-instructions', 'default instructions').contentHash).toBe(sha('From backup'));
    expect(result.projects[0].warnings).toEqual(expect.arrayContaining(['settings-read-from-backup', 'settings-unparsable']));
    expect(JSON.stringify([result, vi.mocked(appLog).mock.calls])).not.toContain('LEAKY-CORRUPT-TEXT');
  });
});

describe('git state per file', () => {
  it('asks git: tracked, untracked, ignored, including tracked-but-ignored and info/exclude', async () => {
    const project = makeProject('alpha');
    write(project, '.gitignore', '.clubhouse/skills/ignored/\n.clubhouse/skills/forced/\n');
    write(project, '.clubhouse/skills/tracked/SKILL.md', 'tracked\n');
    write(project, '.clubhouse/skills/forced/SKILL.md', 'forced\n');
    git(project, 'add', '.gitignore', '.clubhouse/skills/tracked/SKILL.md');
    git(project, 'add', '-f', '.clubhouse/skills/forced/SKILL.md');
    git(project, 'commit', '-q', '-m', 'skills');
    write(project, '.clubhouse/skills/untracked/SKILL.md', 'untracked\n');
    write(project, '.clubhouse/skills/ignored/SKILL.md', 'ignored\n');
    write(project, '.clubhouse/skills/excluded/SKILL.md', 'excluded\n');
    write(project, '.git/info/exclude', '.clubhouse/skills/excluded/\n');
    registerProjects([project]);

    const result = await scan();

    const state = (name: string) => entry(result, 'skill', name).sources[0].files[0].gitState;
    expect(state('tracked')).toBe('tracked');
    expect(state('forced')).toBe('tracked');
    expect(state('untracked')).toBe('untracked');
    expect(state('ignored')).toBe('ignored');
    expect(state('excluded')).toBe('ignored');
  });

  it('treats glob characters in a file name literally', async () => {
    const project = makeProject('alpha');
    write(project, '.clubhouse/skills/odd/[a].md', 'literal\n');
    write(project, '.clubhouse/skills/odd/a.md', 'plain\n');
    git(project, 'add', '.clubhouse/skills/odd/a.md');
    registerProjects([project]);

    const result = await scan();

    const files = entry(result, 'skill', 'odd').sources[0].files;
    expect(files.find((f) => f.relativePath.endsWith('[a].md'))?.gitState).toBe('untracked');
    expect(files.find((f) => f.relativePath.endsWith('/a.md'))?.gitState).toBe('tracked');
  });

  it('answers unknown only for a path git rejects, not for the rest of its batch', async () => {
    const project = makeProject('alpha');
    write(project, '.gitignore', 'ignored.md\n');
    write(project, 'ignored.md', 'x\n');
    write(project, 'plain.md', 'y\n');
    // Refused by check-ignore on every platform (bad pathspec magic), and exits 128 for the whole batch.
    const rejected = ':(nonsense)rejected.md';

    const states = await readGitStates(project, ['plain.md', rejected, 'ignored.md', 'README.md'], new AbortController().signal);

    expect(Object.fromEntries(states)).toEqual({
      'plain.md': 'untracked',
      [rejected]: 'unknown',
      'ignored.md': 'ignored',
      'README.md': 'tracked',
    });
  });

  it('says not-a-repo outside a repository, rather than untracked', async () => {
    const project = makeProject('plain', { repo: false });
    write(project, '.clubhouse/skills/deploy/SKILL.md', 'x\n');
    registerProjects([project]);

    const result = await scan();

    expect(entry(result, 'skill', 'deploy').sources[0].files[0].gitState).toBe('not-a-repo');
  });

  it('says unknown when git fails, rather than guessing', async () => {
    const project = makeProject('alpha');
    write(project, '.clubhouse/skills/deploy/SKILL.md', 'x\n');
    fs.writeFileSync(path.join(project, '.git', 'index'), 'not an index');
    registerProjects([project]);

    const result = await scan();

    expect(entry(result, 'skill', 'deploy').sources[0].files[0].gitState).toBe('unknown');
  });
});

describe('git config can\'t run anything', () => {
  /** A command that leaves a file named `marker` in the repo root when git runs it. */
  const leaveMarker = (marker: string) => `echo ran > ${marker}`;

  it('turns core.fsmonitor off, which would otherwise run on these same commands', async () => {
    const project = makeProject('alpha');
    write(project, '.clubhouse/skills/deploy/SKILL.md', 'x\n');
    git(project, 'config', 'core.fsmonitor', leaveMarker('fsmonitor-ran'));
    registerProjects([project]);
    const marker = path.join(project, 'fsmonitor-ran');

    await scan();
    expect(fs.existsSync(marker)).toBe(false);

    // The control: without the override this config does run, so the check above can fail.
    execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: project, stdio: 'ignore' });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('runs nothing from any other config key or hook that names a program', async () => {
    const project = makeProject('alpha');
    write(project, '.clubhouse/skills/tracked/SKILL.md', 'x\n');
    write(project, '.gitattributes', '*.md filter=evil diff=evil\n');
    git(project, 'add', '.clubhouse/skills/tracked/SKILL.md');
    write(project, '.clubhouse/skills/untracked/SKILL.md', 'y\n');
    const keys = [
      'core.pager', 'core.sshCommand', 'core.editor', 'core.askPass', 'core.alternateRefsCommand', 'core.gitProxy',
      'pager.ls-files', 'pager.check-ignore', 'filter.evil.clean', 'filter.evil.smudge', 'filter.evil.process',
      'diff.external', 'diff.evil.command', 'diff.evil.textconv', 'credential.helper', 'gpg.program',
      'sequence.editor', 'alias.ls-files', 'alias.check-ignore',
    ];
    for (const [i, key] of keys.entries()) git(project, 'config', key, leaveMarker(`config-ran-${i}`));
    // Makes the scan ask `git worktree list` under the same config.
    setAgents(project, [{ id: 'a1', name: 'far', worktreePath: path.join(root, 'elsewhere') }]);
    git(project, 'config', 'core.hooksPath', 'evil-hooks');
    for (const hook of ['post-index-change', 'pre-commit', 'post-checkout', 'reference-transaction', 'fsmonitor-watchman']) {
      const file = write(project, `evil-hooks/${hook}`, `#!/bin/sh\n${leaveMarker(`hook-ran-${hook}`)}\n`);
      fs.chmodSync(file, 0o755);
    }
    registerProjects([project]);

    const result = await scan();

    expect(entry(result, 'skill', 'tracked').sources[0].files[0].gitState).toBe('tracked');
    expect(fs.readdirSync(project).filter((f) => f.includes('-ran'))).toEqual([]);
  });
});

describe('symlinked parents', () => {
  /** Skips quietly where symlinks need a privilege, as on Windows runners without it. */
  function link(target: string, at: string): boolean {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    try {
      fs.symlinkSync(target, at, 'junction');
      return true;
    } catch {
      return false; // telemetry-exempt: nothing to test without the privilege
    }
  }

  it.each([
    ['.clubhouse/skills', 'deploy/SKILL.md'],
    ['.clubhouse/agent-templates', 'deploy/README.md'],
    ['.clubhouse/personas', 'deploy.md'],
    ['.clubhouse', 'skills/deploy/SKILL.md'],
  ])('won\'t follow %s out of the project', async (linked, rel) => {
    const project = makeProject('alpha');
    const outside = path.join(root, 'outside');
    write(outside, rel, 'OUTSIDE\n');
    if (!link(outside, path.join(project, ...linked.split('/')))) return;
    registerProjects([project]);
    const before = snapshotTree(outside);

    const result = await scan();

    expect(result.entries).toEqual([]);
    expect(result.projects[0].excluded.symlink).toBeGreaterThan(0);
    expect(snapshotTree(outside)).toEqual(before);
  });

  it('won\'t follow a config folder out for instructions or MCP', async () => {
    const project = makeProject('alpha');
    const outside = path.join(root, 'outside');
    write(outside, 'copilot-instructions.md', 'OUTSIDE\n');
    write(outside, 'mcp.json', JSON.stringify({ mcpServers: { outside: { command: 'x' } } }));
    if (!link(outside, path.join(project, '.github'))) return;
    const worktree = path.join(project, '.clubhouse', 'agents', 'lead');
    fs.mkdirSync(worktree, { recursive: true });
    if (!link(outside, path.join(worktree, '.github'))) return;
    setAgents(project, [{ id: 'a1', name: 'lead', worktreePath: worktree }]);
    registerProjects([project]);

    const result = await scan({ includeProviderConfig: true });

    expect(result.entries).toEqual([]);
    expect(result.providerEntries).toEqual([]);
  });

  // git on Windows sees a junction as a plain folder, so only POSIX has this failure.
  it.skipIf(process.platform === 'win32')('answers unknown for a path beyond a symlink, and for that path alone', async () => {
    const project = makeProject('alpha');
    write(project, '.clubhouse/real-skills/deploy/SKILL.md', 'x\n');
    write(project, '.clubhouse/skills/plain/SKILL.md', 'y\n');
    if (!link(path.join(project, '.clubhouse', 'real-skills'), path.join(project, '.clubhouse', 'linked'))) return;

    const states = await readGitStates(
      project,
      ['.clubhouse/linked/deploy/SKILL.md', '.clubhouse/skills/plain/SKILL.md'],
      new AbortController().signal,
    );

    expect(states.get('.clubhouse/linked/deploy/SKILL.md')).toBe('unknown');
    expect(states.get('.clubhouse/skills/plain/SKILL.md')).toBe('untracked');
  });

  it('won\'t take a source folder that links to generated worktrees', async () => {
    const project = makeProject('alpha');
    write(project, '.clubhouse/agents/lead/CLAUDE.md', 'generated\n');
    if (!link(path.join(project, '.clubhouse', 'agents'), path.join(project, '.clubhouse', 'sneaky'))) return;
    setSettings(project, { defaultSkillsPath: 'sneaky' });
    registerProjects([project]);

    const result = await scan();

    expect(result.entries).toEqual([]);
    expect(result.projects[0].warnings).toEqual(['source-folder-outside-clubhouse:skills']);
  });
});

describe('untrusted worktree paths', () => {
  const OUTSIDE_FILES = {
    'CLAUDE.md': 'CANARY-INSTRUCTIONS\n',
    'AGENTS.md': 'CANARY-AGENTS\n',
    '.github/copilot-instructions.md': 'CANARY-COPILOT\n',
    '.mcp.json': JSON.stringify({ mcpServers: { canary: { command: 'canary' } } }),
  };

  /** A folder holding what a hostile config would like read. */
  function plantCanary(dir: string): void {
    for (const [rel, content] of Object.entries(OUTSIDE_FILES)) write(dir, rel, content);
  }

  /** Nothing at or under `dir` was touched, through the one door a scan has to the filesystem. */
  function expectUntouched(touched: readonly string[], dir: string): void {
    expect(touched.filter((p) => projectPathKey(p).startsWith(projectPathKey(dir)))).toEqual([]);
  }

  /** No trace in the results: no entry, no hash, no count. */
  function expectNoTrace(result: ImportInventory): void {
    expect(result.entries).toEqual([]);
    expect(result.providerEntries).toEqual([]);
    const report = result.projects[0];
    expect(Object.values(report.excluded).every((n) => n === 0)).toBe(true);
    expect(report.agents[0].mcpFilesNotInventoried).toBe(0);
    expect(report.bridgeEntriesFiltered).toBe(0);
    const serialized = JSON.stringify(result);
    for (const content of Object.values(OUTSIDE_FILES)) expect(serialized).not.toContain(sha(content));
    expect(serialized).not.toContain('CANARY');
    expect(serialized).not.toContain('canary"');
  }

  /** An agent configured with `worktreePath`, scanned with the recording filesystem. */
  async function scanAgentAt(project: string, worktreePath: unknown, options: Partial<InventoryOptions> = {}) {
    setAgents(project, [{ id: 'a1', name: 'lead', worktreePath: worktreePath as string }]);
    registerProjects([project]);
    const recording = recordingFs();
    const result = await scan({ fs: recording.fs, ...options });
    return { result, touched: [...recording.touched, ...recording.resolved], readsOnly: recording.touched };
  }

  it('leaves an absolute path outside the project alone', async () => {
    const project = makeProject('alpha');
    const outside = path.join(root, 'outside');
    plantCanary(outside);

    const { result, touched } = await scanAgentAt(project, outside);

    expectUntouched(touched, outside);
    expectNoTrace(result);
    expect(result.externalReferences).toEqual([{ projectId: 'id-alpha', projectName: 'alpha', agent: { id: 'a1', name: 'lead' }, configuredPath: outside, reason: 'outside-project' }]);
    expect(result.projects[0].agents[0].status).toBe('external');
  });

  it('leaves a relative path alone, even one that climbs out', async () => {
    const project = makeProject('alpha');
    const outside = path.join(root, 'outside');
    plantCanary(outside);
    const configured = ['..', 'outside'].join(path.sep);

    const { result, touched } = await scanAgentAt(project, configured);

    expectUntouched(touched, outside);
    expectUntouched(touched, configured);
    expectNoTrace(result);
    expect(result.externalReferences[0].reason).toBe('relative-path');
  });

  it('leaves a path with .. in it alone, wherever it would land', async () => {
    const project = makeProject('alpha');
    const outside = path.join(root, 'outside');
    plantCanary(outside);
    plantCanary(path.join(project, 'inner'));

    for (const configured of [
      [project, '..', 'outside'].join(path.sep),
      [project, '.clubhouse', '..', 'inner'].join(path.sep),
    ]) {
      const { result, touched } = await scanAgentAt(project, configured);

      expectUntouched(touched, outside);
      expectUntouched(touched, path.join(project, 'inner'));
      expectNoTrace(result);
      expect(result.externalReferences[0]).toMatchObject({ configuredPath: configured, reason: 'parent-traversal' });
    }
  });

  it.each(['\\\\attacker\\share\\repo', '//attacker/share/repo', '\\\\?\\C:\\outside'])('never touches the UNC path %s', async (configured) => {
    const project = makeProject('alpha');

    const { result, touched } = await scanAgentAt(project, configured);

    expect(touched.filter((p) => p.includes('attacker') || p.includes('outside'))).toEqual([]);
    expect(touched.filter((p) => /^[\\/]{2}/.test(p))).toEqual([]);
    expectNoTrace(result);
    expect(result.externalReferences[0]).toMatchObject({ configuredPath: configured, reason: 'unc-path' });
  });

  it('reports a config value that isn\'t a usable path', async () => {
    const project = makeProject('alpha');

    const { result } = await scanAgentAt(project, { not: 'a string' });

    expect(result.externalReferences[0]).toMatchObject({ configuredPath: '', reason: 'invalid-path' });
    expect(result.projects[0].agents[0].worktreePath).toBeUndefined();
  });

  it('won\'t go through a case variant of the project', async () => {
    const project = makeProject('alpha');
    const variant = path.join(root, 'ALPHA');
    // Case-insensitive filesystems already have it, as the project itself.
    const distinct = !fs.existsSync(variant);
    if (distinct) plantCanary(variant);
    const configured = path.join(variant, '.clubhouse', 'agents', 'lead');
    if (distinct) plantCanary(configured);

    const { result, touched } = await scanAgentAt(project, configured);

    if (process.platform === 'win32') {
      // The same path by Windows' own rule, so it's inside, and it's simply missing.
      expect(result.projects[0].agents[0].status).toBe('missing-worktree');
      return;
    }
    expectUntouched(touched, variant);
    expect(result.projects[0].agents[0].status).toBe('external');
    expect(result.externalReferences[0].reason).toBe('outside-project');
  });

  describe('symlinks inside the project', () => {
    function link(target: string, at: string): boolean {
      fs.mkdirSync(path.dirname(at), { recursive: true });
      try {
        fs.symlinkSync(target, at, 'junction');
        return true;
      } catch {
        return false; // telemetry-exempt: nothing to test without the privilege
      }
    }

    it('reads the link and not what it points at', async () => {
      const project = makeProject('alpha');
      const outside = path.join(root, 'outside');
      plantCanary(outside);
      const configured = path.join(project, '.clubhouse', 'agents', 'evil');
      if (!link(outside, configured)) return;

      const { result, touched } = await scanAgentAt(project, configured);

      expectUntouched(touched, outside);
      expectNoTrace(result);
      expect(result.externalReferences[0]).toMatchObject({ configuredPath: configured, reason: 'symlink-outside-project' });
    });

    it('follows a chain only as far as it stays inside', async () => {
      const project = makeProject('alpha');
      const outside = path.join(root, 'outside');
      plantCanary(outside);
      const lastHop = path.join(project, '.clubhouse', 'hop2');
      const firstHop = path.join(project, '.clubhouse', 'agents', 'hop1');
      if (!link(outside, lastHop) || !link(lastHop, firstHop)) return;

      const { result, touched } = await scanAgentAt(project, path.join(firstHop, 'nested'));

      expectUntouched(touched, outside);
      expectNoTrace(result);
      expect(result.externalReferences[0].reason).toBe('symlink-outside-project');
    });

    it('isn\'t led out by a folder partway down', async () => {
      const project = makeProject('alpha');
      const outside = path.join(root, 'outside');
      plantCanary(path.join(outside, 'lead'));
      if (!link(outside, path.join(project, '.clubhouse', 'agents'))) return;

      const { result, touched } = await scanAgentAt(project, path.join(project, '.clubhouse', 'agents', 'lead'));

      expectUntouched(touched, outside);
      expectNoTrace(result);
      expect(result.externalReferences[0].reason).toBe('symlink-outside-project');
    });

    it('doesn\'t touch a source folder or config folder\'s target either', async () => {
      const project = makeProject('alpha');
      const outside = path.join(root, 'outside');
      plantCanary(outside);
      write(outside, 'deploy/SKILL.md', 'CANARY-SKILL\n');
      if (!link(outside, path.join(project, '.clubhouse', 'skills')) || !link(outside, path.join(project, '.github'))) return;
      registerProjects([project]);
      const recording = recordingFs();

      const result = await scan({ fs: recording.fs });

      expectUntouched([...recording.touched, ...recording.resolved], outside);
      expect(result.entries).toEqual([]);
    });

    it.each([
      ['the .clubhouse folder', '.clubhouse'],
      ['agents.json itself', '.clubhouse/agents.json'],
      ['the backup', '.clubhouse/agents.json.bak'],
    ])('won\'t read agent config through a link at %s', async (_label, linked) => {
      const project = makeProject('alpha');
      const outside = path.join(root, 'outside');
      const planted = path.join(project, 'planted');
      plantCanary(planted);
      const agents = JSON.stringify([{ id: 'a1', name: 'planted', color: 'blue', createdAt: '2026-11-04T00:00:00.000Z', worktreePath: planted }]);
      write(outside, 'agents.json', agents);
      write(outside, 'agents.json.bak', agents);
      fs.mkdirSync(path.join(project, '.clubhouse'), { recursive: true });
      const at = path.join(project, ...linked.split('/'));
      if (linked === '.clubhouse') fs.rmSync(at, { recursive: true });
      try {
        if (linked === '.clubhouse') fs.symlinkSync(outside, at, 'junction');
        else fs.symlinkSync(path.join(outside, path.basename(at)), at, 'file');
      } catch {
        return; // telemetry-exempt: nothing to test without the privilege
      }
      registerProjects([project]);

      const result = await scan();

      expect(result.projects[0].agents).toEqual([]);
      expect(result.projects[0].warnings).toContain('agent-config-not-read');
      expect(result.entries).toEqual([]);
    });

    it('still reads through a link that stays inside', async () => {
      const project = makeProject('alpha');
      const real = path.join(project, 'real-worktrees', 'lead');
      write(real, 'CLAUDE.md', 'Inside\n');
      const configured = path.join(project, '.clubhouse', 'agents', 'lead');
      if (!link(real, configured)) return;

      const { result } = await scanAgentAt(project, configured);

      expect(result.externalReferences).toEqual([]);
      expect(entry(result, 'agent-instructions', 'lead/CLAUDE.md').sources[0].root).toBe(real);
    });
  });

  describe('real git worktrees', () => {
    it('keeps a linked worktree inside the project in scope', async () => {
      const project = makeProject('alpha');
      const worktree = path.join(project, '.clubhouse', 'agents', 'lead');
      git(project, 'worktree', 'add', '-q', '-b', 'lead/standby', worktree, 'main');
      write(worktree, 'CLAUDE.md', 'Mine\n');

      const { result } = await scanAgentAt(project, worktree);

      const source = entry(result, 'agent-instructions', 'lead/CLAUDE.md').sources[0];
      expect(source.worktreeAccess).toEqual({ by: 'project-root', configuredPath: worktree });
      expect(result.externalReferences).toEqual([]);
    });

    it('keeps a linked worktree outside the project in scope, because git reports it', async () => {
      const project = makeProject('alpha');
      const worktree = path.join(root, 'elsewhere');
      git(project, 'worktree', 'add', '-q', '-b', 'lead/standby', worktree, 'main');
      write(worktree, 'CLAUDE.md', 'Mine\n');

      const { result } = await scanAgentAt(project, worktree);

      const source = entry(result, 'agent-instructions', 'lead/CLAUDE.md').sources[0];
      expect(source.worktreeAccess).toEqual({ by: 'git-worktree', configuredPath: worktree });
      expect(source.files[0].gitState).toBe('untracked');
    });

    it('doesn\'t let another repo\'s worktree vouch for itself', async () => {
      const project = makeProject('alpha');
      const other = makeProject('other');
      const worktree = path.join(root, 'others-worktree');
      git(other, 'worktree', 'add', '-q', '-b', 'x/standby', worktree, 'main');
      plantCanary(worktree);

      const { result, touched } = await scanAgentAt(project, worktree);

      expectUntouched(touched, worktree);
      expectNoTrace(result);
    });

    it('treats a worktree moved after registration as external, whatever now sits at the old path', async () => {
      const project = makeProject('alpha');
      const oldPath = path.join(root, 'old-home');
      const newPath = path.join(root, 'new-home');
      git(project, 'worktree', 'add', '-q', '-b', 'lead/standby', oldPath, 'main');
      git(project, 'worktree', 'move', oldPath, newPath);
      plantCanary(oldPath);

      const { result, touched } = await scanAgentAt(project, oldPath);

      expectUntouched(touched, oldPath);
      expectUntouched(touched, newPath);
      expectNoTrace(result);
      expect(result.externalReferences[0].reason).toBe('outside-project');
    });

    it('doesn\'t take git\'s word for a worktree that lost its folder and was refilled', async () => {
      const project = makeProject('alpha');
      const worktree = path.join(root, 'moved-by-hand');
      git(project, 'worktree', 'add', '-q', '-b', 'lead/standby', worktree, 'main');
      fs.renameSync(worktree, path.join(root, 'moved-by-hand-2'));
      plantCanary(worktree);

      const { result, touched } = await scanAgentAt(project, worktree);

      expectUntouched(touched, worktree);
      expectNoTrace(result);
    });

    it('stops at a registered worktree swapped for a link, without reading what it leads to', async () => {
      const project = makeProject('alpha');
      const worktree = path.join(root, 'swapped');
      const outside = path.join(root, 'outside');
      plantCanary(outside);
      git(project, 'worktree', 'add', '-q', '-b', 'lead/standby', worktree, 'main');
      // git still calls it valid if the gitdir pointer survives in the new target.
      fs.copyFileSync(path.join(worktree, '.git'), path.join(outside, '.git'));
      fs.rmSync(worktree, { recursive: true, force: true });
      try {
        fs.symlinkSync(outside, worktree, 'junction');
      } catch {
        return; // telemetry-exempt: nothing to test without the privilege
      }

      // Canonicalizing is the one touch allowed here, because git vouched for the path.
      const { result, readsOnly } = await scanAgentAt(project, worktree);

      expect(readsOnly.filter((p) => p.startsWith(outside))).toEqual([]);
      expect(result.entries).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('CANARY');
    });
  });

  describe('explicit inclusion', () => {
    it('reads the folder only when named, recording what allowed it', async () => {
      const project = makeProject('alpha');
      const outside = path.join(root, 'outside');
      plantCanary(outside);

      const before = await scanAgentAt(project, outside);
      expectUntouched(before.touched, outside);

      const { result } = await scanAgentAt(project, outside, { includeExternalRoots: [outside] });

      expect(result.externalReferences).toEqual([]);
      expect(result.unmatchedExternalRoots).toEqual([]);
      const source = entry(result, 'agent-instructions', 'lead/CLAUDE.md').sources[0];
      expect(source.worktreeAccess).toEqual({ by: 'explicit-inclusion', configuredPath: outside, includedRoot: outside });
      expect(source.files[0].contentHash).toBe(sha(OUTSIDE_FILES['CLAUDE.md']));
      expect(result.projects[0].agents[0]).toMatchObject({ status: 'scanned', mcpFilesNotInventoried: 1 });
    });

    it('matches on the real path, so a link to the folder also names it', async () => {
      const project = makeProject('alpha');
      const outside = path.join(root, 'outside');
      plantCanary(outside);
      const alias = path.join(root, 'alias');
      try {
        fs.symlinkSync(outside, alias, 'junction');
      } catch {
        return; // telemetry-exempt: nothing to test without the privilege
      }

      const { result } = await scanAgentAt(project, outside, { includeExternalRoots: [alias] });

      expect(entry(result, 'agent-instructions', 'lead/CLAUDE.md').sources[0].worktreeAccess?.includedRoot).toBe(alias);
    });

    it('needs a match on the whole path: a parent or a neighbor doesn\'t count', async () => {
      const project = makeProject('alpha');
      const outside = path.join(root, 'outside');
      const neighbor = path.join(root, 'neighbor');
      plantCanary(outside);
      plantCanary(neighbor);
      const notAbsolute = 'outside';

      const { result, touched } = await scanAgentAt(project, outside, { includeExternalRoots: [root, neighbor, notAbsolute] });

      expectUntouched(touched, outside);
      expect(result.entries).toEqual([]);
      expect(result.externalReferences[0].reason).toBe('outside-project');
      expect(result.unmatchedExternalRoots).toEqual([root, neighbor, notAbsolute]);
    });

    it('rescues a link inside the project, when the user names it', async () => {
      const project = makeProject('alpha');
      const outside = path.join(root, 'outside');
      plantCanary(outside);
      const configured = path.join(project, '.clubhouse', 'agents', 'evil');
      fs.mkdirSync(path.dirname(configured), { recursive: true });
      try {
        fs.symlinkSync(outside, configured, 'junction');
      } catch {
        return; // telemetry-exempt: nothing to test without the privilege
      }

      const { result } = await scanAgentAt(project, configured, { includeExternalRoots: [configured] });

      expect(entry(result, 'agent-instructions', 'lead/CLAUDE.md').sources[0].worktreeAccess?.by).toBe('explicit-inclusion');
    });

    it('still never reads a managed worktree', async () => {
      const project = makeProject('alpha');
      const outside = path.join(root, 'outside');
      plantCanary(outside);
      setClubhouseMode({ enabled: true });

      const { result } = await scanAgentAt(project, outside, { includeExternalRoots: [outside] });

      expect(result.entries).toEqual([]);
      expect(result.projects[0].agents[0].status).toBe('generated');
    });
  });

  it('reports an external path on a managed agent too, without touching it', async () => {
    const project = makeProject('alpha');
    const outside = path.join(root, 'outside');
    plantCanary(outside);
    setClubhouseMode({ enabled: true });

    const { result, touched } = await scanAgentAt(project, outside);

    expectUntouched(touched, outside);
    expect(result.externalReferences).toHaveLength(1);
  });

  it('judges paths by the target platform\'s rules', () => {
    const projectRoot = 'C:\\repo';
    const check = (p: unknown) => checkConfiguredPath(p, projectRoot, path.win32);
    expect(check('C:\\repo\\.clubhouse\\agents\\lead')).toBe('inside-project');
    expect(check('c:/REPO/.clubhouse/agents/lead')).toBe('inside-project');
    expect(check('C:\\elsewhere')).toBe('outside-project');
    expect(check('D:\\repo')).toBe('outside-project');
    expect(check('C:elsewhere')).toBe('relative-path');
    expect(check('\\\\host\\share')).toBe('unc-path');
    expect(check('//host/share')).toBe('unc-path');
    expect(check('\\\\?\\C:\\repo')).toBe('unc-path');
    expect(check('C:\\repo\\..\\elsewhere')).toBe('parent-traversal');
    expect(check('C:/repo/a/../b')).toBe('parent-traversal');
    expect(check('')).toBe('invalid-path');
    expect(check(42)).toBe('invalid-path');
    expect(check(`C:\\repo\\a\0b`)).toBe('invalid-path');
    expect(check(`C:\\repo\\${'a'.repeat(5000)}`)).toBe('invalid-path');
  });

  it('drops a prunable worktree from what git vouches for', () => {
    const output = ['worktree /a', 'HEAD 1', 'branch refs/heads/main', '', 'worktree /b', 'HEAD 2', 'prunable gitdir file points to non-existent location', '', 'worktree /c', 'detached', ''].join('\n');
    expect(parseWorktreeList(output)).toEqual(['/a', '/c']);
  });
});

describe('reads only', () => {
  /** A worktree-bearing repo whose index is stale, so anything that refreshes it would write. */
  function staleRepoFixture(): string {
    const project = makeProject('alpha');
    write(project, '.gitignore', 'ignored.txt\n.clubhouse/agents/\n');
    write(project, '.clubhouse/skills/deploy/SKILL.md', 'x\n');
    git(project, 'add', '.');
    git(project, 'commit', '-q', '-m', 'files');
    write(project, 'ignored.txt', 'ignored file\n');
    write(project, '.clubhouse/skills/fresh/SKILL.md', 'untracked\n');
    const worktree = path.join(project, '.clubhouse', 'agents', 'lead');
    git(project, 'worktree', 'add', '-q', '-b', 'lead/standby', worktree, 'main');
    write(worktree, 'CLAUDE.md', 'hand-edited\n');
    // The outside path makes the scan ask `git worktree list` too.
    setAgents(project, [{ id: 'a1', name: 'lead', worktreePath: worktree }, { id: 'a2', name: 'far', worktreePath: path.join(root, 'elsewhere') }]);
    setSettings(project, { agentDefaults: { instructions: 'x', mcpJson: JSON.stringify({ mcpServers: { s: { command: 'x' } } }) } });
    write(project, '.mcp.json', JSON.stringify({ mcpServers: { t: { command: 'y' } } }));
    const future = new Date(Date.now() + 86_400_000);
    fs.utimesSync(path.join(project, 'README.md'), future, future);
    return project;
  }

  it('leaves the tree identical, including ignored files, mtimes and .git', async () => {
    const project = staleRepoFixture();
    registerProjects([project]);
    const before = snapshotTree(project);

    const result = await scan();

    expect(result.projects[0].status).toBe('scanned');
    expect(result.entries.length).toBeGreaterThan(3);
    expect(snapshotTree(project)).toEqual(before);
    expect(result.externalReferences.map((r) => r.agent.name)).toEqual(['far']);
  });

  it('has a fixture that would catch an index refresh: git status does write it', () => {
    const project = staleRepoFixture();
    const before = snapshotTree(project);

    git(project, 'status', '--porcelain');

    const after = snapshotTree(project);
    const indexRel = path.join('.git', 'index');
    expect(after[indexRel]).not.toEqual(before[indexRel]);
  });

  it('writes nothing to the app folders either', async () => {
    const project = makeProject('alpha');
    registerProjects([project]);
    setClubhouseMode({ enabled: true, projectOverrides: { [path.join(root, 'gone')]: true } });
    const home = snapshotTree(dirs.home);
    const userData = snapshotTree(dirs.userData);

    await scan({ includeProviderConfig: true });

    expect(snapshotTree(dirs.home)).toEqual(home);
    expect(snapshotTree(dirs.userData)).toEqual(userData);
  });

  it('leaves the tree identical when cancelled', async () => {
    const project = staleRepoFixture();
    registerProjects([project]);
    const before = snapshotTree(project);
    const controller = new AbortController();

    await scan({ signal: controller.signal, onProgress: () => controller.abort() });

    expect(snapshotTree(project)).toEqual(before);
  });

  it('starts nothing inside the caller\'s tick', async () => {
    registerProjects([makeProject('alpha')]);
    const recording = recordingFs();

    const pending = scan({ fs: recording.fs });
    expect(recording.touched).toEqual([]);
    await pending;
    expect(recording.touched.length).toBeGreaterThan(0);
  });
});

describe('agent instructions and worktrees', () => {
  function addWorktree(project: string, name: string): string {
    const worktree = path.join(project, '.clubhouse', 'agents', name);
    git(project, 'worktree', 'add', '-q', '-b', `${name}/standby`, worktree, 'main');
    return worktree;
  }

  it('offers an unmanaged worktree\'s instructions with path provenance and git state', async () => {
    const project = makeProject('alpha');
    const worktree = addWorktree(project, 'lead');
    write(worktree, 'CLAUDE.md', 'Hand-edited\n');
    setAgents(project, [{ id: 'a1', name: 'lead', worktreePath: worktree }]);
    registerProjects([project]);

    const result = await scan();

    const instructions = entry(result, 'agent-instructions', 'lead/CLAUDE.md');
    expect(instructions.sources[0].agent).toEqual({ id: 'a1', name: 'lead' });
    expect(instructions.sources[0].path).toBe(path.join(worktree, 'CLAUDE.md'));
    expect(instructions.sources[0].root).toBe(worktree);
    expect(instructions.sources[0].files[0].gitState).toBe('untracked');
    expect(instructions.sources[0].caveats).toEqual(['wildcards-may-be-expanded', 'git-state-is-a-hint']);
    expect(result.projects[0].agents[0]).toMatchObject({ status: 'scanned', managed: false });
  });

  it('counts an unmanaged worktree\'s MCP files, without offering them', async () => {
    const project = makeProject('alpha');
    const worktree = addWorktree(project, 'lead');
    const bridgeOnly = addWorktree(project, 'quiet');
    const bridge = { command: 'node', args: [path.join('app', 'clubhouse-mcp-bridge.js')] };
    write(worktree, '.mcp.json', JSON.stringify({ mcpServers: { clubhouse: bridge, mine: { command: 'x', env: { K: 'WORKTREE-ENV-VALUE' } } } }));
    write(worktree, '.github/mcp.json', '{ broken');
    write(worktree, '.codex/config.toml', `[mcp_servers.clubhouse]\ncommand = "node"\nargs = [${JSON.stringify(bridge.args[0])}]\n`);
    write(bridgeOnly, '.mcp.json', JSON.stringify({ mcpServers: { clubhouse: bridge } }));
    setAgents(project, [{ id: 'a1', name: 'lead', worktreePath: worktree }, { id: 'a2', name: 'quiet', worktreePath: bridgeOnly }]);
    registerProjects([project]);

    const result = await scan();

    expect(result.entries).toEqual([]);
    expect(result.projects[0].agents.map((a) => a.mcpFilesNotInventoried)).toEqual([2, 0]);
    expect(result.projects[0].bridgeEntriesFiltered).toBe(0);
    expect(JSON.stringify(result)).not.toContain('WORKTREE-ENV-VALUE');
  });

  it('never reads a managed worktree', async () => {
    const project = makeProject('alpha');
    const worktree = addWorktree(project, 'lead');
    write(worktree, 'CLAUDE.md', 'Materialized\n');
    write(worktree, '.claude/skills/deploy/SKILL.md', 'Materialized skill\n');
    write(worktree, '.mcp.json', JSON.stringify({ mcpServers: { generated: { command: 'x' } } }));
    setAgents(project, [{ id: 'a1', name: 'lead', worktreePath: worktree }]);
    setClubhouseMode({ enabled: true });
    registerProjects([project]);
    const recording = recordingFs();

    const result = await scan({ fs: recording.fs });

    expect(result.entries).toEqual([]);
    expect(result.projects[0].agents[0]).toMatchObject({ status: 'generated', managed: true });
    expect(recording.touched.filter((p) => p.startsWith(worktree))).toEqual([]);
  });

  it('treats clubhouseModeOverride as agent-system does: truthy opts out', async () => {
    const project = makeProject('alpha');
    const optedOut = addWorktree(project, 'out');
    const optedIn = addWorktree(project, 'in');
    write(optedOut, 'CLAUDE.md', 'Mine\n');
    write(optedIn, 'CLAUDE.md', 'Generated\n');
    setAgents(project, [
      { id: 'a1', name: 'out', worktreePath: optedOut, clubhouseModeOverride: true },
      { id: 'a2', name: 'in', worktreePath: optedIn, clubhouseModeOverride: false },
    ]);
    setClubhouseMode({ enabled: true });
    registerProjects([project]);

    const result = await scan();

    expect(result.entries.map((e) => e.name)).toEqual(['out/CLAUDE.md']);
  });

  it('skips worktrees when Clubhouse Mode\'s settings are unreadable, since they may be generated', async () => {
    const project = makeProject('alpha');
    const worktree = addWorktree(project, 'lead');
    write(worktree, 'CLAUDE.md', 'Maybe generated\n');
    setAgents(project, [{ id: 'a1', name: 'lead', worktreePath: worktree }]);
    write(dirs.userData, 'clubhouse-mode-settings.json', '{ corrupt');
    registerProjects([project]);

    const result = await scan();

    expect(result.entries).toEqual([]);
    expect(result.projects[0].agents[0]).toMatchObject({ status: 'skipped-mode-unknown', managed: 'unknown' });
    expect(result.projects[0].clubhouseMode.enabled).toBe('unknown');
  });

  it('reports a missing worktree and an agent with none', async () => {
    const project = makeProject('alpha');
    setAgents(project, [
      { id: 'a1', name: 'gone', worktreePath: path.join(project, '.clubhouse', 'agents', 'gone') },
      { id: 'a2', name: 'none' },
    ]);
    registerProjects([project]);

    const result = await scan();

    expect(result.projects[0].agents.map((a) => a.status)).toEqual(['missing-worktree', 'no-worktree']);
    expect(result.projects[0].status).toBe('scanned');
  });

  it('knows every provider\'s instructions file', async () => {
    for (const provider of [new ClaudeCodeProvider(), new CodexCliProvider(), new CopilotCliProvider()]) {
      const dir = fs.mkdtempSync(path.join(root, 'provider-'));
      await provider.writeInstructions(dir, 'x');
      const found = INSTRUCTION_FILES.filter((rel) => fs.existsSync(path.join(dir, ...rel.split('/'))));
      expect(found, provider.id).toHaveLength(1);
      expect(PROJECT_MCP_FILES.map((m) => m.file), provider.id).toContain(provider.conventions.mcpConfigFile);
    }
  });
});

describe('Clubhouse Mode projects', () => {
  it('flags the project with its effective result, as names and counts', async () => {
    const project = makeProject('alpha');
    write(project, '.clubhouse/skills/deploy/SKILL.md', 'x\n');
    write(project, '.clubhouse/agent-templates/reviewer/README.md', 'x\n');
    setSettings(project, {
      agentDefaults: {
        instructions: 'x',
        permissions: { allow: ['a', 'b'], deny: ['c'] },
        mcpJson: JSON.stringify({ mcpServers: { github: { command: 'gh-mcp', env: { TOKEN: 'EFFECTIVE-SECRET-VALUE' } } } }),
        persona: 'qa',
      },
    });
    setClubhouseMode({ enabled: false, projectOverrides: { [project]: true } });
    registerProjects([project]);

    const result = await scan();

    expect(result.projects[0].clubhouseMode).toEqual({
      enabled: true,
      source: 'project',
      effective: {
        hasInstructions: true,
        permissionRuleCount: 3,
        mcpServerNames: ['github'],
        skills: ['deploy'],
        agentTemplates: ['reviewer'],
        defaultPersona: 'qa',
        defaultMission: undefined,
      },
    });
    expect(JSON.stringify(result)).not.toContain('EFFECTIVE-SECRET-VALUE');
  });

  it('reads an app-wide setting as the app\'s, and leaves effective off when disabled', async () => {
    const on = makeProject('on');
    const off = makeProject('off');
    setClubhouseMode({ enabled: true, projectOverrides: { [off]: false } });
    registerProjects([on, off]);

    const result = await scan();

    expect(result.projects[0].clubhouseMode).toMatchObject({ enabled: true, source: 'app' });
    expect(result.projects[1].clubhouseMode).toEqual({ enabled: false, source: 'project' });
  });
});

describe('orphaned config', () => {
  it('reports stored overrides for unregistered projects and reads nothing there', async () => {
    const project = makeProject('alpha');
    const stale = makeProject('stale');
    write(stale, '.clubhouse/skills/deploy/SKILL.md', 'must not be read\n');
    setClubhouseMode({ enabled: false, projectOverrides: { [stale]: true, [project]: true } });
    registerProjects([project]);
    const recording = recordingFs();

    const result = await scan({ fs: recording.fs });

    expect(result.orphaned).toEqual([{ settingsFile: 'clubhouse-mode-settings.json', path: stale, reason: 'unregistered' }]);
    expect(result.entries).toEqual([]);
    expect(recording.touched.filter((p) => p.startsWith(stale))).toEqual([]);
  });

  it('reports an override for a registered project whose folder is gone', async () => {
    const gone = path.join(root, 'gone');
    setClubhouseMode({ enabled: false, projectOverrides: { [gone]: true } });
    registerProjects([gone]);

    const result = await scan();

    expect(result.orphaned).toEqual([{ settingsFile: 'clubhouse-mode-settings.json', path: gone, reason: 'project-missing' }]);
  });

  it('reports a different spelling of a registered path, which the runtime lookup won\'t match', async () => {
    const project = makeProject('alpha');
    const variant = `${project}${path.sep}`;
    setClubhouseMode({ enabled: false, projectOverrides: { [variant]: true } });
    registerProjects([project]);

    const result = await scan();

    expect(result.orphaned).toEqual([{ settingsFile: 'clubhouse-mode-settings.json', path: variant, reason: 'path-variant' }]);
    expect(result.projects[0].clubhouseMode).toEqual({ enabled: false, source: 'app' });
  });

  it('reports stale paths in the other settings files with project overrides', async () => {
    const project = makeProject('alpha');
    const stale = path.join(root, 'stale');
    for (const file of ['mcp-settings.json', 'session-settings.json', 'free-agent-settings.json', 'headless-settings.json']) {
      write(dirs.userData, file, JSON.stringify({ projectOverrides: { [stale]: true, [project]: true } }));
    }
    write(dirs.userData, 'sound-settings.json', JSON.stringify({ projectOverrides: { [stale]: true } }));
    registerProjects([project]);

    const result = await scan();

    expect(result.orphaned).toEqual(['free-agent-settings.json', 'headless-settings.json', 'mcp-settings.json', 'session-settings.json']
      .map((settingsFile) => ({ settingsFile, path: stale, reason: 'unregistered' })));
  });

  it('judges orphans against every registered project, not the selected scope', async () => {
    const selected = makeProject('selected');
    const other = makeProject('other');
    setClubhouseMode({ enabled: false, projectOverrides: { [other]: true } });
    registerProjects([selected, other]);

    const result = await scan({ projectIds: ['id-selected'] });

    expect(result.projects.map((p) => p.projectId)).toEqual(['id-selected']);
    expect(result.orphaned).toEqual([]);
  });
});

describe('MCP definitions', () => {
  const bridge = { command: 'node', args: [path.join('app', 'clubhouse-mcp-bridge.js')], env: { CLUBHOUSE_MCP_FALLBACK_PORT: '1234' } };

  it('keeps definitions, drops env values, keeps references, and filters the bridge', async () => {
    const project = makeProject('alpha');
    write(project, '.mcp.json', JSON.stringify({
      mcpServers: {
        clubhouse: bridge,
        renamed: bridge,
        github: {
          command: 'gh-mcp',
          args: ['--read-only', '--path', '@@Path'],
          env: { GH_TOKEN: 'SECRET-ENV-VALUE-123', REF: '${GH_TOKEN}', PLAIN: 'SECOND-ENV-VALUE' },
          headers: { Authorization: 'HEADER-VALUE-XYZ' },
          timeout: 30,
        },
      },
    }));
    registerProjects([project]);

    const result = await scan();

    expect(result.entries.map((e) => e.name)).toEqual(['github']);
    expect(result.projects[0].bridgeEntriesFiltered).toBe(2);
    const github = entry(result, 'mcp-server', 'github');
    expect(github.mcp).toEqual({
      command: 'gh-mcp',
      args: ['--read-only', '--path', '@@Path'],
      env: [{ name: 'GH_TOKEN' }, { name: 'PLAIN' }, { name: 'REF', reference: '${GH_TOKEN}' }],
      forwardedEnv: [],
      headerNames: ['Authorization'],
      omittedKeys: ['timeout'],
      withheldValues: 0,
    });
    expect(github.wildcards).toEqual(['@@Path']);
    expect(github.sources[0].files[0].relativePath).toBe('.mcp.json');
    const everything = JSON.stringify([result, vi.mocked(appLog).mock.calls]);
    for (const value of ['SECRET-ENV-VALUE-123', 'SECOND-ENV-VALUE', 'HEADER-VALUE-XYZ']) expect(everything).not.toContain(value);
  });

  it('keeps a user server that is merely named clubhouse, since only the shape marks the bridge', async () => {
    const project = makeProject('alpha');
    write(project, '.mcp.json', JSON.stringify({ mcpServers: { clubhouse: { command: 'my-own-server' } } }));
    registerProjects([project]);

    const result = await scan();

    expect(entry(result, 'mcp-server', 'clubhouse').mcp?.command).toBe('my-own-server');
    expect(result.projects[0].bridgeEntriesFiltered).toBe(0);
  });

  it('merges definitions differing only in env values, because the hash never sees a value', async () => {
    const a = makeProject('a');
    const b = makeProject('b');
    write(a, '.mcp.json', JSON.stringify({ mcpServers: { s: { command: 'x', env: { KEY: 'value-one' } } } }));
    write(b, '.mcp.json', JSON.stringify({ mcpServers: { s: { command: 'x', env: { KEY: 'value-two' } } } }));
    registerProjects([a, b]);

    const result = await scan();

    const merged = entry(result, 'mcp-server', 's');
    expect(merged.conflict).toBe(false);
    expect(merged.sources.map((s) => s.projectId)).toEqual(['id-a', 'id-b']);
  });

  // One server per shape, so a broken rule names the shapes it lets through.
  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['flag and value', { command: 'x', args: ['--api-key', 'LITERAL-A'] }, { args: ['--api-key', '<withheld>'] }],
    ['flag=value', { command: 'x', args: ['--token=LITERAL-B'] }, { args: ['--token=<withheld>'] }],
    ['--header', { command: 'x', args: ['--header', 'Authorization: Bearer LITERAL-C'] }, { args: ['--header', 'Authorization: <withheld>'] }],
    ['-H with any header', { command: 'x', args: ['-H', 'X-Custom: LITERAL-D'] }, { args: ['-H', 'X-Custom: <withheld>'] }],
    ['--header=', { command: 'x', args: ['--header=Cookie: LITERAL-E'] }, { args: ['--header=Cookie: <withheld>'] }],
    ['a bare auth header', { command: 'x', args: ['Authorization: Bearer LITERAL-F'] }, { args: ['Authorization: <withheld>'] }],
    ['connection string', { command: 'x', args: ['postgresql://admin:LITERAL-G@db/prod'] }, { args: ['postgresql://<withheld>@db/prod'] }],
    ['connection string in a flag', { command: 'x', args: ['--db=postgresql://admin:LITERAL-H@db/prod'] }, { args: ['--db=postgresql://<withheld>@db/prod'] }],
    ['KEY=value', { command: 'x', args: ['API_KEY=LITERAL-I'] }, { args: ['API_KEY=<withheld>'] }],
    ['a flag inside the command', { command: 'x --password LITERAL-J' }, { command: 'x --password <withheld>' }],
    ['URL userinfo', { url: 'https://user:LITERAL-K@example.com/mcp' }, { url: 'https://<withheld>@example.com/mcp' }],
    ['URL query', { url: 'https://example.com/mcp?key=LITERAL-L' }, { url: 'https://example.com/mcp?key=<withheld>' }],
    ['URL fragment', { url: 'https://example.com/mcp#access_token=LITERAL-M' }, { url: 'https://example.com/mcp#access_token=<withheld>' }],
    ['an opaque token', { command: 'x', args: ['--x', `a1${'LITERALN'.repeat(5)}`] }, { args: ['--x', '<withheld>'] }],
  ])('withholds a credential in %s, says so, and counts it', async (_shape, definition, expected) => {
    const project = makeProject('alpha', { repo: false });
    write(project, '.mcp.json', JSON.stringify({ mcpServers: { s: definition } }));
    registerProjects([project]);

    const result = await scan();

    expect(entry(result, 'mcp-server', 's').mcp).toMatchObject({ ...expected, withheldValues: 1 });
    expect(result.projects[0].excluded['credential-value']).toBe(1);
    expect(JSON.stringify([result, vi.mocked(appLog).mock.calls])).not.toContain('LITERAL');
  });

  it('leaves references, wildcards and ordinary args readable', async () => {
    const project = makeProject('alpha');
    const args = ['--token', '${TOKEN}', '--header', 'Authorization: Bearer ${TOKEN}', '--path', '@@Path', '--port', '3000', 'pkg@1.2.3', '--auth', '--verbose'];
    write(project, '.mcp.json', JSON.stringify({ mcpServers: {
      ok: { command: 'x', args },
      url: { url: 'https://${USER}:${PASS}@example.com/mcp?token=${TOKEN}' },
    } }));
    registerProjects([project]);

    const result = await scan();

    expect(entry(result, 'mcp-server', 'ok').mcp).toMatchObject({ args, withheldValues: 0 });
    expect(entry(result, 'mcp-server', 'url').mcp).toMatchObject({ url: 'https://${USER}:${PASS}@example.com/mcp?token=${TOKEN}', withheldValues: 0 });
    expect(result.projects[0].excluded['credential-value']).toBe(0);
  });

  it('merges definitions differing only in a withheld value, because the hash never sees it', async () => {
    const a = makeProject('a');
    const b = makeProject('b');
    write(a, '.mcp.json', JSON.stringify({ mcpServers: { s: { command: 'x', args: ['--token', 'value-one'] } } }));
    write(b, '.mcp.json', JSON.stringify({ mcpServers: { s: { command: 'x', args: ['--token', 'value-two'] } } }));
    registerProjects([a, b]);

    const result = await scan();

    expect(entry(result, 'mcp-server', 's').sources).toHaveLength(2);
    expect(entry(result, 'mcp-server', 's').conflict).toBe(false);
  });

  describe('hostile keys', () => {
    afterEach(() => {
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(({} as Record<string, unknown>).y).toBeUndefined();
      expect(({} as Record<string, unknown>).NODE_OPTIONS).toBeUndefined();
    });

    it('doesn\'t let a repo\'s TOML reach Object.prototype, and keeps the servers around it', async () => {
      const project = makeProject('alpha');
      write(project, '.codex/config.toml', [
        '__proto__.polluted = "yes"',
        'x = { __proto__.y = "z" }',
        'constructor.prototype.polluted = "yes"',
        '"__proto__".polluted = "yes"',
        '[__proto__]',
        'polluted = "yes"',
        '[mcp_servers.good]',
        'command = "c"',
        '__proto__.polluted = "yes"',
        'NODE_OPTIONS.__proto__.polluted = "yes"',
        'env = { __proto__ = { NODE_OPTIONS = "--require=evil" } }',
        'constructor = { prototype = { polluted = "yes" } }',
        '[mcp_servers.__proto__]',
        'polluted = "yes"',
        'command = "must-not-land-in-good"',
        '[mcp_servers.good2.__proto__]',
        'polluted = "yes"',
        '[mcp_servers.constructor.prototype]',
        'polluted = "yes"',
        '[mcp_servers.last]',
        'command = "l"',
      ].join('\n'));
      registerProjects([project]);

      const result = await scan();

      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(result.entries.map((e) => e.name)).toEqual(['good', 'last']);
      expect(entry(result, 'mcp-server', 'good').mcp?.command).toBe('c');
    });

    it('refuses the same keys from JSON, without treating them as names', async () => {
      const project = makeProject('alpha');
      write(project, '.mcp.json', [
        '{"mcpServers":{',
        '"__proto__":{"command":"x"},',
        '"constructor":{"command":"x"},',
        '"prototype":{"command":"x"},',
        '"good":{"command":"c","__proto__":{"polluted":"yes"},"env":{"__proto__":"v","KEEP":"v"},"headers":{"constructor":"v"}}',
        '}}',
      ].join(''));
      registerProjects([project]);

      const result = await scan();

      expect(result.entries.map((e) => e.name)).toEqual(['good']);
      expect(entry(result, 'mcp-server', 'good').mcp).toMatchObject({ env: [{ name: 'KEEP' }], headerNames: [], omittedKeys: [] });
      expect(result.projects[0].excluded['non-definition']).toBe(3);
    });
  });

  it('reads definitions from the project defaults and Codex TOML, and ignores the rest of the TOML', async () => {
    const project = makeProject('alpha');
    setSettings(project, { agentDefaults: { mcpJson: JSON.stringify({ mcpServers: { clubhouse: bridge, fromDefaults: { command: 'd', env: { K: 'DEFAULTS-ENV-VALUE' } } } }) } });
    write(project, '.codex/config.toml', [
      'model = "gpt-5"',
      'api_key = "TOP-LEVEL-TOML-SECRET"',
      '',
      '[mcp_servers.toml_server]',
      'command = "npx"',
      'args = [',
      '  "-y", # a comment',
      '  "server",',
      ']',
      'env_vars = ["FORWARDED"]',
      '',
      '[mcp_servers.toml_server.env]',
      'TOKEN = "TOML-ENV-VALUE"',
      '',
      '[mcp_servers.inline]',
      'url = "https://example.com/mcp"',
      'env = { A = "INLINE-ENV-VALUE" }',
      '',
      '[mcp_servers.clubhouse]',
      'command = "node"',
      `args = [${JSON.stringify(path.join('app', 'clubhouse-mcp-bridge.js'))}]`,
      '',
      '[profiles.work]',
      'token = "PROFILE-TOML-SECRET"',
    ].join('\n'));
    registerProjects([project]);

    const result = await scan();

    expect(entry(result, 'mcp-server', 'fromDefaults').sources[0].pointer).toBe('agentDefaults.mcpJson#fromDefaults');
    expect(entry(result, 'mcp-server', 'toml_server').mcp).toEqual({
      command: 'npx',
      args: ['-y', 'server'],
      env: [{ name: 'TOKEN' }],
      forwardedEnv: ['FORWARDED'],
      headerNames: [],
      omittedKeys: [],
      withheldValues: 0,
    });
    expect(entry(result, 'mcp-server', 'inline').mcp?.env).toEqual([{ name: 'A' }]);
    expect(result.projects[0].bridgeEntriesFiltered).toBe(2);
    const serialized = JSON.stringify(result);
    for (const value of ['TOP-LEVEL-TOML-SECRET', 'PROFILE-TOML-SECRET', 'TOML-ENV-VALUE', 'INLINE-ENV-VALUE', 'DEFAULTS-ENV-VALUE']) {
      expect(serialized).not.toContain(value);
    }
  });

  it('warns on an unparsable config without keeping its text', async () => {
    const project = makeProject('alpha');
    write(project, '.mcp.json', '{ BROKEN-JSON-TEXT');
    registerProjects([project]);

    const result = await scan();

    expect(result.projects[0].warnings).toEqual(['mcp-config-unparsable:.mcp.json']);
    expect(JSON.stringify(result)).not.toContain('BROKEN-JSON-TEXT');
  });
});

describe('built-in dedupe', () => {
  it('lists default skills, instructions and permissions as built-in matches, not entries', async () => {
    const project = makeProject('alpha');
    await ensureDefaultSkills(project);
    const defaults = getDefaultAgentTemplates();
    setSettings(project, { defaultSkillsPath: 'skills', agentDefaults: { instructions: defaults.instructions, permissions: defaults.permissions } });
    registerProjects([project]);

    const result = await scan();

    expect(result.entries).toEqual([]);
    expect(result.builtinMatches.map((m) => m.name)).toEqual(expect.arrayContaining(['mission', 'create-pr', 'go-standby', 'build', 'test', 'lint', 'validate-changes', 'default instructions', 'default permissions']));
    expect(result.builtinMatches).toHaveLength(9);
    expect(result.builtinMatches[0].sources[0].projectId).toBe('id-alpha');
  });

  it('offers a default skill once it has been edited, or has another file beside it', async () => {
    const project = makeProject('alpha');
    await ensureDefaultSkills(project);
    fs.appendFileSync(path.join(project, '.clubhouse', 'skills', 'build', 'SKILL.md'), '\nand also this\n');
    write(project, '.clubhouse/skills/test/notes.md', 'extra\n');
    registerProjects([project]);

    const result = await scan();

    expect(result.entries.map((e) => e.name).sort()).toEqual(['build', 'test']);
    expect(result.builtinMatches).toHaveLength(5);
  });

  it('matches a built-in persona by content, whatever the line endings', async () => {
    const project = makeProject('alpha');
    const template = PERSONA_TEMPLATES[0];
    write(project, `.clubhouse/personas/${template.id}.md`, template.content.replace(/\r?\n/g, '\r\n'));
    write(project, '.clubhouse/personas/edited.md', `${template.content}\nmore\n`);
    registerProjects([project]);

    const result = await scan();

    expect(result.builtinMatches.map((m) => m.builtinId)).toEqual([template.id]);
    expect(result.entries.map((e) => e.name)).toEqual(['edited']);
  });
});

describe('conflicts and merging', () => {
  it('reports the same name with different content as a conflict, on both', async () => {
    const a = makeProject('a');
    const b = makeProject('b');
    write(a, '.clubhouse/skills/deploy/SKILL.md', 'one\n');
    write(b, '.clubhouse/skills/deploy/SKILL.md', 'two\n');
    registerProjects([a, b]);

    const result = await scan();

    expect(result.entries).toHaveLength(2);
    expect(result.entries.every((e) => e.conflict)).toBe(true);
    expect(result.entries[0].conflictingHashes).toEqual([result.entries[1].contentHash]);
    expect(result.entries[1].conflictingHashes).toEqual([result.entries[0].contentHash]);
  });

  it('merges the same content, listing every source', async () => {
    const a = makeProject('a');
    const b = makeProject('b');
    write(a, '.clubhouse/skills/deploy/SKILL.md', 'same\n');
    write(b, '.clubhouse/skills/deploy/SKILL.md', 'same\n');
    git(b, 'add', '.');
    registerProjects([a, b]);

    const result = await scan();

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].conflict).toBe(false);
    expect(result.entries[0].sources.map((s) => [s.projectId, s.files[0].gitState])).toEqual([['id-a', 'untracked'], ['id-b', 'tracked']]);
  });

  it('treats names differing only in case as the same name', async () => {
    const a = makeProject('a');
    const b = makeProject('b');
    write(a, '.clubhouse/skills/Deploy/SKILL.md', 'one\n');
    write(b, '.clubhouse/skills/deploy/SKILL.md', 'two\n');
    registerProjects([a, b]);

    const result = await scan();

    expect(result.entries.every((e) => e.conflict)).toBe(true);
  });

  it('doesn\'t call a skill and a persona with one name a conflict', async () => {
    const project = makeProject('a');
    write(project, '.clubhouse/skills/deploy/SKILL.md', 'one\n');
    write(project, '.clubhouse/personas/deploy.md', 'two\n');
    registerProjects([project]);

    const result = await scan();

    expect(result.entries.some((e) => e.conflict)).toBe(false);
  });
});

describe('exclusions', () => {
  // Assembled here so no scanner flags this test file as holding a credential.
  const fakeToken = `ghp_${'a1B2'.repeat(10)}`;
  const fakeKey = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ');

  it('counts secret-looking files, by name and by content, and shows nothing of them', async () => {
    const project = makeProject('alpha');
    write(project, '.clubhouse/skills/deploy/SKILL.md', 'fine\n');
    write(project, '.clubhouse/skills/deploy/.env', 'ENV-FILE-CONTENT=1\n');
    write(project, '.clubhouse/skills/deploy/server.pem', 'PEM-FILE-CONTENT\n');
    write(project, '.clubhouse/skills/deploy/notes.md', `leaked ${fakeToken}\n`);
    write(project, '.clubhouse/skills/deploy/key.md', `${fakeKey}\n`);
    write(project, '.clubhouse/skills/deploy/config.md', 'password: hunter2hunter2\n');
    write(project, '.clubhouse/personas/leaky.md', `token ${fakeToken}\n`);
    setSettings(project, { agentDefaults: { instructions: `use ${fakeToken}` } });
    registerProjects([project]);

    const result = await scan();

    expect(result.projects[0].excluded['secret-looking']).toBe(7);
    const deploy = entry(result, 'skill', 'deploy');
    expect(deploy.sources[0].files.map((f) => f.relativePath)).toEqual(['.clubhouse/skills/deploy/SKILL.md']);
    expect(deploy.sources[0].excludedFileCount).toBe(5);
    expect(result.entries.map((e) => e.name)).toEqual(['deploy']);
    const everything = JSON.stringify([result, vi.mocked(appLog).mock.calls]);
    for (const text of [fakeToken, fakeKey, 'hunter2', 'ENV-FILE-CONTENT', 'PEM-FILE-CONTENT', 'server.pem', 'notes.md', 'leaky']) {
      expect(everything).not.toContain(text);
    }
  });

  it('allows references and placeholders that only look like assignments', async () => {
    const project = makeProject('alpha');
    write(project, '.clubhouse/skills/deploy/SKILL.md', 'password: ${DB_PASSWORD}\napi_key: <your key>\n');
    registerProjects([project]);

    const result = await scan();

    expect(entry(result, 'skill', 'deploy').sources[0].excludedFileCount).toBe(0);
  });

  it('counts binaries, unknown types, dependency folders and oversized files', async () => {
    const project = makeProject('alpha');
    write(project, '.clubhouse/skills/deploy/SKILL.md', 'fine\n');
    write(project, '.clubhouse/skills/deploy/logo.png', Buffer.from([1, 2, 3]));
    write(project, '.clubhouse/skills/deploy/data.txt', Buffer.from([65, 0, 66]));
    write(project, '.clubhouse/skills/deploy/node_modules/dep/index.js', 'x\n');
    write(project, '.clubhouse/skills/deploy/huge.md', 'x'.repeat(2048));
    registerProjects([project]);

    const result = await scan({ limits: { maxFileBytes: 1024 } });

    expect(result.projects[0].excluded['non-definition']).toBe(3);
    expect(result.projects[0].excluded['too-large']).toBe(1);
    expect(entry(result, 'skill', 'deploy').sources[0].excludedFileCount).toBe(4);
  });

  it('doesn\'t follow a symlink out of the folder', async () => {
    const project = makeProject('alpha');
    const outside = write(root, 'outside/SECRET.md', 'OUTSIDE-CONTENT\n');
    write(project, '.clubhouse/skills/deploy/SKILL.md', 'fine\n');
    try {
      fs.symlinkSync(outside, path.join(project, '.clubhouse', 'skills', 'deploy', 'link.md'));
    } catch {
      return; // telemetry-exempt: Windows without the symlink privilege has nothing to test
    }
    registerProjects([project]);

    const result = await scan();

    expect(result.projects[0].excluded.symlink).toBe(1);
    expect(entry(result, 'skill', 'deploy').sources[0].files).toHaveLength(1);
  });
});

describe('bounds', () => {
  it('stops at the file bound, marks the project truncated and drops a part-read item', async () => {
    const project = makeProject('alpha');
    write(project, '.clubhouse/skills/aaa/SKILL.md', 'complete\n');
    for (let i = 0; i < 20; i++) write(project, `.clubhouse/skills/bbb/file${i}.md`, `${i}\n`);
    write(project, '.clubhouse/skills/ccc/SKILL.md', 'never reached\n');
    registerProjects([project]);

    const result = await scan({ limits: { maxFilesPerProject: 10 } });

    expect(result.projects[0].truncated).toBe(true);
    expect(result.projects[0].status).toBe('scanned');
    expect(result.entries.map((e) => e.name)).toEqual(['aaa']);
    expect(result.projects[0].filesSeen).toBeLessThanOrEqual(10);
  });

  it('stops at the byte bound', async () => {
    const project = makeProject('alpha');
    write(project, '.clubhouse/skills/aaa/SKILL.md', 'x'.repeat(600));
    write(project, '.clubhouse/skills/bbb/SKILL.md', 'y'.repeat(600));
    registerProjects([project]);

    const result = await scan({ limits: { maxBytesPerProject: 1000 } });

    expect(result.projects[0].truncated).toBe(true);
    expect(result.entries.map((e) => e.name)).toEqual(['aaa']);
  });
});

describe('missing and offline paths', () => {
  it('reports a missing project and scans the others', async () => {
    const gone = path.join(root, 'gone');
    const present = makeProject('present');
    write(present, '.clubhouse/skills/deploy/SKILL.md', 'x\n');
    registerProjects([gone, present]);

    const result = await scan();

    expect(result.status).toBe('complete');
    expect(result.projects.map((p) => p.status)).toEqual(['missing', 'scanned']);
    expect(result.entries.map((e) => e.name)).toEqual(['deploy']);
  });

  it('reports a file registered as a project as unavailable', async () => {
    const file = write(root, 'not-a-folder', 'x');
    registerProjects([file]);

    const result = await scan();

    expect(result.projects[0]).toMatchObject({ status: 'unavailable', reason: 'ENOTDIR' });
  });

  it('reports an erroring mount by code only and carries on', async () => {
    const offline = makeProject('offline');
    const present = makeProject('present');
    write(present, '.clubhouse/skills/deploy/SKILL.md', 'x\n');
    registerProjects([offline, present]);
    const real = recordingFs().fs;
    const failing: InventoryFs = {
      ...real,
      stat: (p) => (p === offline
        ? Promise.reject(Object.assign(new Error(`EIO: i/o error at ${p}`), { code: 'EIO' }))
        : real.stat(p)),
    };

    const result = await scan({ fs: failing });

    expect(result.projects[0]).toMatchObject({ status: 'unavailable', reason: 'EIO' });
    expect(result.projects[1].status).toBe('scanned');
  });

  it('moves on from a hung mount at the deadline, keeping none of its partial list', async () => {
    const hung = makeProject('hung');
    write(hung, '.clubhouse/skills/deploy/SKILL.md', 'x\n');
    const present = makeProject('present');
    write(present, '.clubhouse/skills/other/SKILL.md', 'y\n');
    registerProjects([hung, present]);
    const real = recordingFs().fs;
    const hanging: InventoryFs = {
      ...real,
      // Never settles, as a call on a dead network mount can.
      readFile: (p) => (p.startsWith(hung) ? new Promise<Buffer>(() => undefined) : real.readFile(p)),
    };

    // Long enough for the healthy project's git calls on a slow runner, which share the deadline.
    const result = await scan({ fs: hanging, projectTimeoutMs: 5000 });

    expect(result.projects[0]).toMatchObject({ status: 'unavailable', reason: 'timeout' });
    expect(result.projects[1].status).toBe('scanned');
    expect(result.entries.map((e) => e.name)).toEqual(['other']);
  });

  it('survives no project store and no settings at all', async () => {
    const result = await scan();

    expect(result).toMatchObject({ status: 'complete', entries: [], projects: [], orphaned: [] });
  });
});

describe('progress and cancel', () => {
  it('reports each project starting and finishing', async () => {
    registerProjects([makeProject('a'), makeProject('b')]);
    const phases: string[] = [];

    await scan({
      onProgress: (p) => {
        if (p.phase !== 'files') phases.push(`${p.phase}:${p.projectName}:${p.projectIndex}/${p.projectCount}`);
      },
    });

    expect(phases).toEqual([
      'project-started:a:0/2',
      'project-finished:a:0/2',
      'project-started:b:1/2',
      'project-finished:b:1/2',
    ]);
  });

  it('isn\'t stopped by a progress listener that throws', async () => {
    registerProjects([makeProject('a')]);

    const result = await scan({ onProgress: () => { throw new Error('listener'); } });

    expect(result.status).toBe('complete');
  });

  it('cancels mid-project, keeping finished projects and no half of the current one', async () => {
    const first = makeProject('first');
    const second = makeProject('second');
    const third = makeProject('third');
    write(first, '.clubhouse/skills/done/SKILL.md', 'x\n');
    write(second, '.clubhouse/skills/partial/SKILL.md', 'y\n');
    write(third, '.clubhouse/skills/never/SKILL.md', 'z\n');
    registerProjects([first, second, third]);
    const controller = new AbortController();

    const result = await scan({
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === 'project-started' && p.projectName === 'second') controller.abort();
      },
    });

    expect(result.status).toBe('cancelled');
    expect(result.projects.map((p) => p.status)).toEqual(['scanned', 'cancelled', 'not-started']);
    expect(result.entries.map((e) => e.name)).toEqual(['done']);
  });

  it('cancels mid-scan, in the middle of a project\'s files, and reads no further', async () => {
    const first = makeProject('first');
    const second = makeProject('second');
    write(first, '.clubhouse/skills/done/SKILL.md', 'x\n');
    for (const name of ['aaa', 'bbb', 'ccc', 'ddd']) write(second, `.clubhouse/skills/${name}/SKILL.md`, `${name}\n`);
    registerProjects([first, second]);
    const controller = new AbortController();
    const real = recordingFs().fs;
    const reads: string[] = [];
    const cancelling: InventoryFs = {
      ...real,
      readFile: (p) => {
        reads.push(p);
        if (p.includes(`${path.sep}bbb${path.sep}`)) controller.abort();
        return real.readFile(p);
      },
    };

    const result = await scan({ signal: controller.signal, fs: cancelling });

    expect(result.status).toBe('cancelled');
    expect(result.projects.map((p) => p.status)).toEqual(['scanned', 'cancelled']);
    expect(result.entries.map((e) => e.name)).toEqual(['done']);
    expect(reads.filter((p) => p.includes(`${path.sep}ccc${path.sep}`) || p.includes(`${path.sep}ddd${path.sep}`))).toEqual([]);
  });

  // A stand-in git on PATH, which only POSIX can run by that name without a shell.
  describe.skipIf(process.platform === 'win32')('during a git call', () => {
    const originalPath = process.env.PATH;
    afterEach(() => { process.env.PATH = originalPath; });

    /** After this, `git` announces itself and then hangs until killed. */
    function slowGit(): string {
      const bin = path.join(root, '_bin');
      const started = path.join(root, '_git-started');
      fs.chmodSync(write(bin, 'git', `#!/bin/sh\necho started > "${started}"\nexec sleep 60\n`), 0o755);
      process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
      return started;
    }

    it('stops a running git, keeps no part of the project, and changes nothing', async () => {
      const project = makeProject('alpha');
      write(project, '.clubhouse/skills/deploy/SKILL.md', 'x\n');
      registerProjects([project]);
      const before = snapshotTree(project);
      const started = slowGit();
      const controller = new AbortController();
      const at = Date.now();

      const pending = scan({ signal: controller.signal });
      await vi.waitFor(() => expect(fs.existsSync(started)).toBe(true), { timeout: 10_000, interval: 20 });
      controller.abort();
      const result = await pending;

      expect(Date.now() - at).toBeLessThan(20_000);
      expect(result.status).toBe('cancelled');
      expect(result.projects[0].status).toBe('cancelled');
      expect(result.entries).toEqual([]);
      expect(snapshotTree(project)).toEqual(before);
    });

    it('gives back every path as unknown when readGitStates itself is aborted', async () => {
      const project = makeProject('alpha');
      const started = slowGit();
      const controller = new AbortController();

      const pending = readGitStates(project, ['a.md', 'b.md'], controller.signal);
      await vi.waitFor(() => expect(fs.existsSync(started)).toBe(true), { timeout: 10_000, interval: 20 });
      controller.abort();
      const states = await pending;

      expect([...states.values()]).toEqual(['unknown', 'unknown']);
    });
  });

  it('does nothing when cancelled before it starts', async () => {
    const project = makeProject('a');
    registerProjects([project]);
    const controller = new AbortController();
    controller.abort();
    const recording = recordingFs();

    const result = await scan({ signal: controller.signal, fs: recording.fs });

    expect(result.status).toBe('cancelled');
    expect(result.projects[0].status).toBe('not-started');
    expect(recording.touched).toEqual([]);
  });

  it('scans only the selected projects', async () => {
    const a = makeProject('a');
    const b = makeProject('b');
    write(a, '.clubhouse/skills/one/SKILL.md', 'x\n');
    write(b, '.clubhouse/skills/two/SKILL.md', 'y\n');
    registerProjects([a, b]);

    const result = await scan({ projectIds: ['id-b'] });

    expect(result.entries.map((e) => e.name)).toEqual(['two']);
  });
});

describe('provider and global config', () => {
  function globalFixture(): void {
    write(dirs.home, '.claude/CLAUDE.md', 'global instructions\n');
    write(dirs.home, '.claude/skills/global-skill/SKILL.md', 'global skill\n');
    write(dirs.home, '.claude.json', JSON.stringify({
      oauthAccount: { token: 'CLAUDE-JSON-ACCOUNT-TOKEN' },
      mcpServers: { globalServer: { command: 'g', env: { K: 'GLOBAL-ENV-VALUE' } } },
    }));
    write(dirs.home, '.codex/config.toml', '[mcp_servers.codexServer]\ncommand = "c"\n');
    write(dirs.home, '.clubhouse-dev/personas/mine.md', 'my persona\n');
  }

  it('is off by default, and home isn\'t even read', async () => {
    globalFixture();
    const project = makeProject('alpha');
    write(project, '.claude/skills/provider-skill/SKILL.md', 'x\n');
    write(project, 'CLAUDE.md', 'x\n');
    registerProjects([project]);
    const recording = recordingFs();

    const result = await scan({ fs: recording.fs });

    expect(result.providerEntries).toEqual([]);
    expect(result.globalStatus).toBe('not-requested');
    expect(result.entries).toEqual([]);
    expect(recording.touched.filter((p) => p.startsWith(dirs.home))).toEqual([]);
    expect(recording.touched).not.toContain(path.join(project, 'CLAUDE.md'));
  });

  it('when asked, lists them apart and labeled, with secrets out', async () => {
    globalFixture();
    const project = makeProject('alpha');
    write(project, '.claude/skills/provider-skill/SKILL.md', 'x\n');
    write(project, 'CLAUDE.md', 'x\n');
    write(project, '.clubhouse/skills/deploy/SKILL.md', 'x\n');
    registerProjects([project]);

    const result = await scan({ includeProviderConfig: true });

    expect(result.entries.map((e) => e.name)).toEqual(['deploy']);
    expect(result.globalStatus).toBe('scanned');
    const labels = result.providerEntries.map((e) => [e.kind, e.name, e.scope]);
    expect(labels).toEqual(expect.arrayContaining([
      ['skill', 'provider-skill', 'provider'],
      ['provider-instructions', 'CLAUDE.md', 'provider'],
      ['skill', 'global-skill', 'global'],
      ['provider-instructions', '.claude/CLAUDE.md', 'global'],
      ['mcp-server', 'globalServer', 'global'],
      ['mcp-server', 'codexServer', 'global'],
      ['persona', 'mine', 'global'],
    ]));
    expect(result.providerEntries.find((e) => e.name === 'globalServer')?.sources[0].projectId).toBeNull();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('CLAUDE-JSON-ACCOUNT-TOKEN');
    expect(serialized).not.toContain('GLOBAL-ENV-VALUE');
  });

  it('offers native subagent files as their own kind, with provider config', async () => {
    const project = makeProject('alpha');
    write(project, '.claude/agents/reviewer.md', 'Reviews\n');
    write(project, '.github/agents/rev.agent.md', 'Reviews too\n');
    write(project, '.codex/agents/helper.toml', 'name = "helper"\n');
    write(project, '.claude/agents/notes.png', Buffer.from([1, 2]));
    write(project, '.claude/agents/foldered/README.md', 'A template\n');
    write(dirs.home, '.claude/agents/mine.md', 'Mine\n');
    registerProjects([project]);

    const off = await scan();
    expect(off.entries).toEqual([]);

    const on = await scan({ includeProviderConfig: true });
    expect(on.entries).toEqual([]);
    const subagents = on.providerEntries.filter((e) => e.kind === 'native-subagent');
    expect(subagents.map((e) => [e.name, e.scope])).toEqual([['helper', 'provider'], ['mine', 'global'], ['rev', 'provider'], ['reviewer', 'provider']]);
    expect(subagents[3].sources[0].files[0].relativePath).toBe('.claude/agents/reviewer.md');
    expect(on.providerEntries.find((e) => e.name === 'foldered')?.kind).toBe('agent-template');
    expect(on.projects[0].excluded['non-definition']).toBe(1);
  });

  it('says so when the global scan can\'t finish, and keeps the projects', async () => {
    write(dirs.home, '.claude/CLAUDE.md', 'x\n');
    const project = makeProject('alpha');
    write(project, '.clubhouse/skills/deploy/SKILL.md', 'x\n');
    registerProjects([project]);
    const real = recordingFs().fs;
    const hanging: InventoryFs = { ...real, readFile: (p) => (p.startsWith(dirs.home) ? new Promise<Buffer>(() => undefined) : real.readFile(p)) };

    const result = await scan({ includeProviderConfig: true, fs: hanging, projectTimeoutMs: 5000 });

    expect(result.globalStatus).toBe('unavailable');
    expect(result.entries.map((e) => e.name)).toEqual(['deploy']);
  });

  it('keeps a global source apart from a project source with the same content', async () => {
    write(dirs.home, '.claude/skills/deploy/SKILL.md', 'same\n');
    const project = makeProject('alpha');
    write(project, '.claude/skills/deploy/SKILL.md', 'same\n');
    registerProjects([project]);

    const result = await scan({ includeProviderConfig: true });

    expect(result.providerEntries.map((e) => e.scope).sort()).toEqual(['global', 'provider']);
  });
});

describe('Windows paths', () => {
  it('compares project paths without case or separator differences on Windows only', () => {
    expect(projectPathKey('C:\\Users\\Me\\Proj\\', 'win32')).toBe(projectPathKey('c:/users/me/proj', 'win32'));
    expect(projectPathKey('C:\\Users\\Me\\Proj', 'win32')).not.toBe(projectPathKey('C:\\Users\\Me\\Other', 'win32'));
    expect(projectPathKey('C:\\', 'win32')).toBe('c:\\');
  });

  it('gives git forward slashes from a Windows path', () => {
    expect(toGitPath('C:\\repo', 'C:\\repo\\.clubhouse\\skills\\deploy\\SKILL.md', path.win32)).toBe('.clubhouse/skills/deploy/SKILL.md');
  });

  it('confines source folders by Windows rules', () => {
    const base = 'C:\\repo\\.clubhouse';
    expect(confinedJoin(base, 'skills', path.win32)).toBe('C:\\repo\\.clubhouse\\skills');
    expect(confinedJoin(base, '..\\..\\Windows', path.win32)).toBeNull();
    expect(confinedJoin(base, '../../Windows', path.win32)).toBeNull();
    expect(confinedJoin(base, '..dots', path.win32)).toBe('C:\\repo\\.clubhouse\\..dots');
    expect(confinedJoin(base, '.', path.win32)).toBeNull();
    expect(confinedJoin(base, 'agents\\lead', path.win32)).toBeNull();
    expect(confinedJoin(base, 'Agents', path.win32)).toBeNull();
    expect(confinedJoin(base, 'AGENTS\\lead', path.win32)).toBeNull();
    expect(confinedJoin(base, 'agents.', path.win32)).toBeNull();
    expect(confinedJoin(base, 'agents-old', path.win32)).toBe('C:\\repo\\.clubhouse\\agents-old');
  });

  it('matches git\'s answer to another spelling of the path where the filesystem folds case', async () => {
    const project = makeProject('alpha');
    write(project, 'Tracked.md', 'x\n');
    git(project, 'add', 'Tracked.md');

    const asWindows = await readGitStates(project, ['Tracked.md'], new AbortController().signal, 'win32');

    expect(asWindows.get('Tracked.md')).toBe('tracked');
  });
});
