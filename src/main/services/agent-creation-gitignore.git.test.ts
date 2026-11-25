import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Real git and real files (#3623, a regression from #3593): creating an agent in an
// existing project must not edit its tracked .gitignore, while registering a new project
// still installs the managed block. Local backups stay protected through .git/info/exclude.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const h = vi.hoisted(() => ({ provider: null as unknown }));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));
vi.mock('./agent-system', () => ({ resolveOrchestrator: vi.fn(async () => h.provider) }));
vi.mock('./chat-idle-settings', () => ({ setAgentIdleSleep: vi.fn() }));
vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: process.env.PATH ?? '' })),
  invalidateShellEnvironmentCache: vi.fn(),
  buildCliSpawnEnv: vi.fn(() => ({})),
}));
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('./settings-audit', () => ({ auditChanges: vi.fn(), projectAuditTarget: vi.fn() }));
vi.mock('./project-store', () => ({
  addProject: vi.fn(async (dirPath: string) => ({ project: { id: 'p1', name: 'p', path: dirPath }, created: true })),
}));

import { clearAgentConfigCache, createDurable, flushAllAgentConfigs } from './agent-config';
import { registerProjectFolder } from './project-add';
import { writeDefaultMcps } from './agent-settings-service';
import { resetLocalExcludesForTests } from './local-excludes';
import { CLUBHOUSE_LOCAL_PATTERNS } from './local-excludes';
import { ClaudeCodeProvider } from '../orchestrators/claude-code-provider';

let root: string;
let project: string;

function git(args: string[], cwd = project): string {
  return execFileSync('git', [
    '-c', 'user.name=Clubhouse Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The managed block as #3593's predecessor wrote it: none of the two settings-backup lines. */
const OLD_BLOCK = '# Clubhouse agent manager\n.clubhouse/agents/\n.clubhouse/.local/\n.clubhouse/agents.json\n.clubhouse/agents.json.bak\n.clubhouse/settings.local.json\n';

const linesOf = (file: string) => fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-create-ignore-'));
  project = path.join(root, 'project');
  fs.mkdirSync(project);
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(project, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(project, '.gitignore'), `node_modules/\n${OLD_BLOCK}`);
  fs.mkdirSync(path.join(project, '.clubhouse'));
  fs.writeFileSync(path.join(project, '.clubhouse', 'settings.json'), JSON.stringify({ defaults: {}, quickOverrides: {} }));
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  h.provider = new ClaudeCodeProvider();
  resetLocalExcludesForTests();
  clearAgentConfigCache();
});

afterEach(async () => {
  await flushAllAgentConfigs();
  clearAgentConfigCache();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('agent creation in an existing project (#3623)', () => {
  it('leaves a tracked .gitignore byte-for-byte alone and the checkout clean', async () => {
    const before = fs.readFileSync(path.join(project, '.gitignore'));
    const config = await createDurable(project, 'first', 'indigo');
    await flushAllAgentConfigs();
    expect(fs.existsSync(config.worktreePath!)).toBe(true);
    expect(fs.readFileSync(path.join(project, '.gitignore')).equals(before)).toBe(true);
    // Backups and recovery copies from settings writes are ignored without .gitignore's help.
    for (const name of ['settings.json.bak', 'settings.json.unreadable', 'settings.json.unreadable.1']) {
      fs.writeFileSync(path.join(project, '.clubhouse', name), 'x');
    }
    expect(git(['status', '--porcelain'])).toBe('');
  });

  it('puts the managed patterns in .git/info/exclude, once, keeping the user\'s lines', async () => {
    const exclude = path.join(project, '.git', 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, '\nmy-private-file\n');
    await createDurable(project, 'first', 'indigo');
    await createDurable(project, 'second', 'indigo');
    await flushAllAgentConfigs();
    const lines = linesOf(exclude);
    expect(lines).toContain('my-private-file');
    for (const pattern of CLUBHOUSE_LOCAL_PATTERNS) expect(lines.filter((line) => line === pattern)).toHaveLength(1);
    expect(git(['status', '--porcelain'])).toBe('');
  });

  it('does not create a .gitignore in a project that has none', async () => {
    git(['rm', '-q', '--', '.gitignore']);
    git(['commit', '-q', '-m', 'drop ignore']);
    await createDurable(project, 'first', 'indigo');
    await flushAllAgentConfigs();
    expect(fs.existsSync(path.join(project, '.gitignore'))).toBe(false);
  });

  it('still creates the agent in a folder that is not a Git repository', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    const config = await createDurable(plain, 'solo', 'indigo', undefined, false);
    await flushAllAgentConfigs();
    expect(config.id).toBeTruthy();
    expect(fs.existsSync(path.join(plain, '.gitignore'))).toBe(false);
    expect(fs.existsSync(path.join(plain, '.git'))).toBe(false);
  });
});

describe('project settings backups (#3623)', () => {
  it('keeps the backup and recovery copy out of git before any agent exists, without editing .gitignore', async () => {
    const before = fs.readFileSync(path.join(project, '.gitignore'));
    const live = path.join(project, '.clubhouse', 'settings.json');
    await writeDefaultMcps(project, ['one']);
    fs.writeFileSync(live, '{"broken"');
    await writeDefaultMcps(project, ['two']);
    const names = fs.readdirSync(path.join(project, '.clubhouse'));
    expect(names).toEqual(expect.arrayContaining(['settings.json.bak', 'settings.json.unreadable']));
    expect(fs.readFileSync(path.join(project, '.gitignore')).equals(before)).toBe(true);
    expect(git(['status', '--porcelain']).split('\n').filter((line) => line && !line.endsWith('settings.json'))).toEqual([]);
  });
});

describe('new-project registration (#3623)', () => {
  it('writes the complete managed block into a new .gitignore', async () => {
    const fresh = path.join(root, 'fresh');
    fs.mkdirSync(fresh);
    const result = await registerProjectFolder(fresh);
    expect(result.gitignore).toBe('updated');
    const lines = linesOf(path.join(fresh, '.gitignore'));
    expect(lines[0]).toBe('# Clubhouse agent manager');
    expect(lines.slice(1)).toEqual(CLUBHOUSE_LOCAL_PATTERNS);
  });

  it('appends only the missing lines to an existing .gitignore, as before', async () => {
    const fresh = path.join(root, 'fresh');
    fs.mkdirSync(fresh);
    fs.writeFileSync(path.join(fresh, '.gitignore'), `node_modules/\n${OLD_BLOCK}`);
    const result = await registerProjectFolder(fresh);
    expect(result.gitignore).toBe('updated');
    const lines = linesOf(path.join(fresh, '.gitignore'));
    expect(lines.slice(0, 7)).toEqual(['node_modules/', ...OLD_BLOCK.split('\n').filter(Boolean)]);
    expect(lines).toContain('.clubhouse/settings.json.bak');
    expect(lines).toContain('.clubhouse/settings.json.unreadable*');
  });
});
