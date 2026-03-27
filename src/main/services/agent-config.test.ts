import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

// Mock child_process (include execFile used by async git operations)
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  exec: vi.fn((_cmd: string, _opts: any, cb: (...args: unknown[]) => void) => {
    cb(null, '', '');
    return {};
  }),
  execFile: vi.fn((_file: string, _args: string[], _opts: any, cb: (...args: unknown[]) => void) => {
    cb(null, '', '');
    return {};
  }),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
  promises: {
    readFile: vi.fn(async () => '{}'),
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    readdir: vi.fn(async () => []),
    rm: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    access: vi.fn(async () => undefined),
  },
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  appendFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
  readdir: vi.fn(() => []),
  unlink: vi.fn(),
  stat: vi.fn(),
  copyFile: vi.fn(),
  rename: vi.fn(),
}));

// Mock fs-utils
vi.mock('./fs-utils', () => ({
  pathExists: vi.fn(),
}));

// Mock git-service (isInsideGitRepo is used for git repo detection)
vi.mock('./git-service', () => ({
  isInsideGitRepo: vi.fn(),
}));

import * as fsp from 'fs/promises';
import { exec, execFile } from 'child_process';
import { pathExists } from './fs-utils';
import { isInsideGitRepo } from './git-service';
import {
  listDurable,
  createDurable,
  renameDurable,
  updateDurable,
  deleteDurable,
  reorderDurable,
  getWorktreeStatus,
  deleteCommitAndPush,
  deleteUnregister,
  deleteForce,
  getDurableConfig,
  updateDurableConfig,
  updateSessionId,
  addSessionEntry,
  updateSessionName,
  getSessionHistory,
  ensureGitignore as _ensureGitignore,
  saveAgentIcon,
  clearAgentConfigCache,
  flushAgentConfig,
  getBackupInfo,
  restoreFromBackup,
} from './agent-config';

const PROJECT_PATH = '/test/project';

// Clear the write-back cache before every test to prevent cross-test contamination.
// Also set up default mocks for atomic-write helpers (rename, copyFile) so that
// existing tests work without modification after the atomic write refactor.
beforeEach(() => {
  clearAgentConfigCache();
  // Default rename mock: simulate atomic rename by making the dest path
  // "appear" to have the data.  Tests that track writtenData override this
  // in their own beforeEach with a data-moving implementation.
  vi.mocked(fsp.rename).mockResolvedValue(undefined);
  vi.mocked(fsp.copyFile).mockResolvedValue(undefined);
});

function mockAgentsFile(agents: any[]) {
  vi.mocked(pathExists).mockImplementation(async (p: any) => {
    if (String(p).endsWith('agents.json')) return true;
    if (String(p).endsWith('.git')) return true;
    return false;
  });
  vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
    if (String(p).endsWith('agents.json')) return JSON.stringify(agents);
    return '';
  });
}

function mockNoAgentsFile() {
  vi.mocked(pathExists).mockImplementation(async (p: any) => {
    if (String(p).endsWith('agents.json')) return false;
    if (String(p).endsWith('.git')) return true;
    if (String(p).endsWith('.gitignore')) return false;
    return false;
  });
}

describe('readAgents (via listDurable)', () => {
  it('returns [] when no file exists', async () => {
    mockNoAgentsFile();
    expect(await listDurable(PROJECT_PATH)).toEqual([]);
  });

  it('returns [] on corrupt JSON with no backup', async () => {
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      if (String(p).endsWith('agents.json.bak')) return false;
      return false;
    });
    vi.mocked(fsp.readFile).mockResolvedValue('{{invalid json');
    expect(await listDurable(PROJECT_PATH)).toEqual([]);
  });

  it('parses valid agents.json', async () => {
    const agents = [{ id: 'durable_1', name: 'test-agent', color: 'indigo', branch: 'test/standby', worktreePath: '/test', createdAt: '2024-01-01' }];
    mockAgentsFile(agents);
    const result = await listDurable(PROJECT_PATH);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('durable_1');
    expect(result[0].name).toBe('test-agent');
  });
});

describe('createDurable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: project is inside a git repo
    vi.mocked(isInsideGitRepo).mockResolvedValue(true);
    const writtenData: Record<string, string> = {};
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('.git')) return true;
      if (s.endsWith('.gitignore')) return false;
      if (s.endsWith('agents.json')) return !!writtenData[s];
      if (s.endsWith('CLAUDE.md')) return false;
      if (s.endsWith('settings.json')) return false;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      const s = String(p);
      if (writtenData[s]) return writtenData[s];
      return '[]';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dest: any) => {
      writtenData[String(dest)] = writtenData[String(src)] || '';
      delete writtenData[String(src)];
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dest: any) => {
      writtenData[String(dest)] = writtenData[String(src)] || '';
      delete writtenData[String(src)];
    });
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.appendFile).mockResolvedValue(undefined);
    // Default: async exec succeeds for all commands
    vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
      cb(null, '', '');
      return {} as any;
    });
  });

  it('generates durable_ prefixed ID', async () => {
    const config = await createDurable(PROJECT_PATH, 'my-agent', 'indigo');
    expect(config.id).toMatch(/^durable_/);
  });

  it('branch = {name}/standby', async () => {
    const config = await createDurable(PROJECT_PATH, 'my-agent', 'indigo');
    expect(config.branch).toBe('my-agent/standby');
  });

  it('worktree path always uses agents/', async () => {
    const config = await createDurable(PROJECT_PATH, 'my-agent', 'indigo');
    expect(config.worktreePath).toContain(path.join('agents', 'my-agent'));
  });

  it('calls git branch + git worktree add when .git exists', async () => {
    await createDurable(PROJECT_PATH, 'my-agent', 'indigo');
    const calls = vi.mocked(exec).mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes('git branch'))).toBe(true);
    expect(calls.some((c) => c.includes('git worktree add'))).toBe(true);
  });

  it('falls back to mkdir when no git', async () => {
    vi.mocked(isInsideGitRepo).mockResolvedValue(false);
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('.git')) return false;
      if (s.endsWith('.gitignore')) return false;
      if (s.endsWith('agents.json')) return false;
      if (s.endsWith('CLAUDE.local.md')) return false;
      if (s.endsWith('settings.json')) return false;
      return false;
    });
    const config = await createDurable(PROJECT_PATH, 'no-git-agent', 'indigo');
    expect(config.id).toMatch(/^durable_/);
    // async git commands should not have been called
    expect(vi.mocked(exec)).not.toHaveBeenCalled();
    // mkdir should have been called for the worktree path
    expect(vi.mocked(fsp.mkdir)).toHaveBeenCalled();
  });

  it('falls back to mkdir when worktree add fails', async () => {
    vi.mocked(exec).mockImplementation((cmd: any, _opts: any, cb: any) => {
      if (String(cmd).includes('git worktree add')) cb(new Error('worktree fail'), '', '');
      else cb(null, '', '');
      return {} as any;
    });
    const config = await createDurable(PROJECT_PATH, 'wt-fail-agent', 'indigo');
    expect(config.id).toMatch(/^durable_/);
    expect(vi.mocked(fsp.mkdir)).toHaveBeenCalled();
  });

  it('creates initial commit with .gitignore when repo has no commits', async () => {
    const writtenData: Record<string, string> = {};
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('.git')) return true;
      // .gitignore exists after ensureGitignore creates it
      if (s.endsWith('.gitignore')) return true;
      if (s.endsWith('agents.json')) return !!writtenData[s];
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('.gitignore')) return '';
      if (writtenData[s]) return writtenData[s];
      return '[]';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dest: any) => {
      writtenData[String(dest)] = writtenData[String(src)] || '';
      delete writtenData[String(src)];
    });
    vi.mocked(exec).mockImplementation((cmd: any, _opts: any, cb: any) => {
      const c = String(cmd);
      // Simulate empty repo: rev-parse HEAD fails
      if (c.includes('git rev-parse HEAD')) cb(new Error('fatal: bad default revision \'HEAD\''), '', '');
      else cb(null, '', '');
      return {} as any;
    });
    await createDurable(PROJECT_PATH, 'empty-repo-agent', 'indigo');
    const calls = vi.mocked(exec).mock.calls.map((c) => String(c[0]));
    // Should check for HEAD validity
    expect(calls.some((c) => c.includes('git rev-parse HEAD'))).toBe(true);
    // Should stage .gitignore
    expect(calls.some((c) => c.includes('git add .gitignore'))).toBe(true);
    // Should create initial commit with Clubhouse branding
    expect(calls.some((c) => c.includes('git commit --allow-empty -m "Clubhouse - Initial Commit"'))).toBe(true);
    // Should still create branch and worktree
    expect(calls.some((c) => c.includes('git branch'))).toBe(true);
    expect(calls.some((c) => c.includes('git worktree add'))).toBe(true);
  });

  it('skips initial commit when repo already has commits', async () => {
    // Default mock succeeds for all commands (including rev-parse HEAD)
    await createDurable(PROJECT_PATH, 'normal-repo-agent', 'indigo');
    const calls = vi.mocked(exec).mock.calls.map((c) => String(c[0]));
    // Should check for HEAD validity
    expect(calls.some((c) => c.includes('git rev-parse HEAD'))).toBe(true);
    // Should NOT create initial commit
    expect(calls.some((c) => c.includes('git commit --allow-empty'))).toBe(false);
    // Should still create branch and worktree
    expect(calls.some((c) => c.includes('git branch'))).toBe(true);
    expect(calls.some((c) => c.includes('git worktree add'))).toBe(true);
  });

  it('falls back to mkdir when initial commit also fails', async () => {
    vi.mocked(exec).mockImplementation((cmd: any, _opts: any, cb: any) => {
      const c = String(cmd);
      if (c.includes('git rev-parse HEAD')) cb(new Error('fatal: bad default revision'), '', '');
      else if (c.includes('git commit --allow-empty')) cb(new Error('commit failed'), '', '');
      else if (c.includes('git worktree add')) cb(new Error('invalid reference'), '', '');
      else cb(null, '', '');
      return {} as any;
    });
    const config = await createDurable(PROJECT_PATH, 'commit-fail-agent', 'indigo');
    expect(config.id).toMatch(/^durable_/);
    // Should still create the directory as fallback
    expect(vi.mocked(fsp.mkdir)).toHaveBeenCalled();
  });

  it('appends to existing config, does not overwrite', async () => {
    const existing = [{ id: 'durable_old', name: 'old', color: 'amber', branch: 'old/standby', worktreePath: '/old', createdAt: '2024-01-01' }];
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(existing);
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('.git')) return true;
      if (s.endsWith('.gitignore')) return false;
      if (s.endsWith('agents.json')) return true;
      if (s.endsWith('CLAUDE.local.md')) return false;
      if (s.endsWith('settings.json')) return false;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dest: any) => {
      writtenData[String(dest)] = writtenData[String(src)] || '';
      delete writtenData[String(src)];
    });

    await createDurable(PROJECT_PATH, 'new-agent', 'emerald');
    await flushAgentConfig(PROJECT_PATH);
    const written = JSON.parse(writtenData[agentsJsonPath]);
    expect(written.length).toBe(2);
    expect(written[0].id).toBe('durable_old');
    expect(written[1].id).toMatch(/^durable_/);
  });

  it('omits model field when "default"', async () => {
    const config = await createDurable(PROJECT_PATH, 'default-model', 'indigo', 'default');
    expect(config).not.toHaveProperty('model');
  });

  it('includes model field when not "default"', async () => {
    const config = await createDurable(PROJECT_PATH, 'custom-model', 'indigo', 'claude-sonnet-4-5-20250929');
    expect(config.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('skips worktree when useWorktree is false', async () => {
    const config = await createDurable(PROJECT_PATH, 'no-wt', 'indigo', 'default', false);
    expect(config.id).toMatch(/^durable_/);
    expect(config.worktreePath).toBeUndefined();
    expect(config.branch).toBeUndefined();
    // No git commands should be called (neither sync nor async)
    expect(vi.mocked(exec)).not.toHaveBeenCalled();
    // mkdir should have been called for the worktree path
    expect(vi.mocked(fsp.mkdir)).toHaveBeenCalled();
  });

  it('includes freeAgentMode when true', async () => {
    const config = await createDurable(PROJECT_PATH, 'free-agent', 'indigo', 'default', true, undefined, true);
    expect(config.freeAgentMode).toBe(true);
  });

  it('omits freeAgentMode when false', async () => {
    const config = await createDurable(PROJECT_PATH, 'no-free', 'indigo', 'default', true, undefined, false);
    expect(config).not.toHaveProperty('freeAgentMode');
  });

  it('omits freeAgentMode when undefined', async () => {
    const config = await createDurable(PROJECT_PATH, 'default-free', 'indigo');
    expect(config).not.toHaveProperty('freeAgentMode');
  });

  it('includes structuredMode when true', async () => {
    const config = await createDurable(PROJECT_PATH, 'structured-agent', 'indigo', 'default', true, undefined, false, undefined, true);
    expect(config.structuredMode).toBe(true);
  });

  it('omits structuredMode when false', async () => {
    const config = await createDurable(PROJECT_PATH, 'no-structured', 'indigo', 'default', true, undefined, false, undefined, false);
    expect(config).not.toHaveProperty('structuredMode');
  });

  it('omits structuredMode when undefined', async () => {
    const config = await createDurable(PROJECT_PATH, 'default-mode', 'indigo');
    expect(config).not.toHaveProperty('structuredMode');
  });

  it('ensureGitignore skips when all patterns already present', async () => {
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('.gitignore')) return true;
      if (s.endsWith('.git')) return true;
      if (s.endsWith('agents.json')) return false;
      if (s.endsWith('CLAUDE.local.md')) return false;
      if (s.endsWith('settings.json')) return false;
      if (s.endsWith('README.md')) return false;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p).endsWith('.gitignore'))
        return '# Clubhouse agent manager\n.clubhouse/agents/\n.clubhouse/.local/\n.clubhouse/agents.json\n.clubhouse/agents.json.bak\n.clubhouse/settings.local.json\n';
      return '[]';
    });

    await createDurable(PROJECT_PATH, 'gitignore-test', 'indigo');
    // Should NOT append because all patterns already exist
    expect(vi.mocked(fsp.appendFile)).not.toHaveBeenCalled();
  });

  it('appends only missing gitignore patterns', async () => {
    const appendedData: string[] = [];
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('.gitignore')) return true;
      if (s.endsWith('.git')) return true;
      if (s.endsWith('agents.json')) return false;
      if (s.endsWith('CLAUDE.local.md')) return false;
      if (s.endsWith('settings.json')) return false;
      if (s.endsWith('README.md')) return false;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p).endsWith('.gitignore')) return '# Clubhouse agent manager\n.clubhouse/agents/\n';
      return '[]';
    });
    vi.mocked(fsp.appendFile).mockImplementation(async (_p: any, data: any) => {
      appendedData.push(String(data));
    });

    await createDurable(PROJECT_PATH, 'partial-test', 'indigo');
    expect(vi.mocked(fsp.appendFile)).toHaveBeenCalled();
    const appended = appendedData.join('');
    // Should add the missing lines but not duplicate existing ones
    expect(appended).toContain('.clubhouse/.local/');
    expect(appended).toContain('.clubhouse/agents.json');
    expect(appended).toContain('.clubhouse/settings.local.json');
    expect(appended).not.toContain('.clubhouse/agents/');
    // Header should not be duplicated
    expect(appended).not.toContain('# Clubhouse agent manager');
  });

  it('uses async exec (non-blocking) for git operations', async () => {
    await createDurable(PROJECT_PATH, 'async-test', 'indigo');
    // Verify async exec was used for git operations
    expect(vi.mocked(exec)).toHaveBeenCalled();
  });
});

describe('deleteDurable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: project is inside a git repo
    vi.mocked(isInsideGitRepo).mockResolvedValue(true);
  });

  it('removes agent from config file', async () => {
    const agents = [
      { id: 'durable_del', name: 'del', color: 'indigo', branch: 'del/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' },
      { id: 'durable_keep', name: 'keep', color: 'amber', branch: 'keep/standby', worktreePath: '/test/wt2', createdAt: '2024-01-01' },
    ];
    let writtenAgents: string = '';
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('agents.json')) return true;
      if (s.endsWith('.git')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenAgents = String(data); });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(execFile).mockImplementation((_file: any, _args: any, _opts: any, cb: any) => {
      cb(null, '', '');
      return {} as any;
    });

    await deleteDurable(PROJECT_PATH, 'durable_del');
    await flushAgentConfig(PROJECT_PATH);
    const result = JSON.parse(writtenAgents);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('durable_keep');
  });

  it('calls git worktree remove + branch -D via async exec', async () => {
    const agents = [{ id: 'durable_git', name: 'git', color: 'indigo', branch: 'git/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('agents.json')) return true;
      if (s.endsWith('.git')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(execFile).mockImplementation((_file: any, args: any, _opts: any, cb: any) => {
      cb(null, '', '');
      return { args } as any;
    });

    await deleteDurable(PROJECT_PATH, 'durable_git');
    const calls = vi.mocked(execFile).mock.calls.map((c) => c[1].join(' '));
    expect(calls.some((c) => c.includes('worktree remove'))).toBe(true);
    expect(calls.some((c) => c.includes('branch -D'))).toBe(true);
  });

  it('continues if git commands fail', async () => {
    const agents = [{ id: 'durable_fail', name: 'fail', color: 'indigo', branch: 'fail/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('agents.json')) return true;
      if (s.endsWith('.git')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(execFile).mockImplementation((_file: any, _args: any, _opts: any, cb: any) => {
      cb(new Error('git fail'), '', '');
      return {} as any;
    });

    await expect(deleteDurable(PROJECT_PATH, 'durable_fail')).resolves.toBeUndefined();
  });

  it('rm if worktree still exists after git', async () => {
    const agents = [{ id: 'durable_rm', name: 'rm', color: 'indigo', branch: 'rm/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('agents.json')) return true;
      if (s.endsWith('.git')) return true;
      if (s === '/test/wt') return true; // worktree still exists
      return false;
    });
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.rm).mockResolvedValue(undefined);
    vi.mocked(execFile).mockImplementation((_file: any, _args: any, _opts: any, cb: any) => {
      cb(null, '', '');
      return {} as any;
    });

    await deleteDurable(PROJECT_PATH, 'durable_rm');
    expect(vi.mocked(fsp.rm)).toHaveBeenCalledWith('/test/wt', { recursive: true, force: true });
  });

  it('no-op for unknown agentId', async () => {
    const agents = [{ id: 'durable_exists', name: 'exists', color: 'indigo', branch: 'exists/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

    await expect(deleteDurable(PROJECT_PATH, 'nonexistent')).resolves.toBeUndefined();
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
  });

  it('handles non-worktree agent (just unregisters)', async () => {
    const agents = [{ id: 'durable_nowt', name: 'nowt', color: 'indigo', createdAt: '2024-01-01' }];
    let writtenAgents = '';
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenAgents = String(data); });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

    await deleteDurable(PROJECT_PATH, 'durable_nowt');
    await flushAgentConfig(PROJECT_PATH);
    const result = JSON.parse(writtenAgents);
    expect(result.length).toBe(0);
    // No git commands for non-worktree agents
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
  });
});

describe('reorderDurable', () => {
  let writtenAgents: string;
  const agents = [
    { id: 'durable_a', name: 'alpha', color: 'indigo', createdAt: '2024-01-01' },
    { id: 'durable_b', name: 'bravo', color: 'emerald', createdAt: '2024-01-02' },
    { id: 'durable_c', name: 'charlie', color: 'amber', createdAt: '2024-01-03' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    writtenAgents = '';
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenAgents = String(data); });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
  });

  it('reorders by orderedIds', async () => {
    await reorderDurable(PROJECT_PATH, ['durable_c', 'durable_a', 'durable_b']);
    await flushAgentConfig(PROJECT_PATH);
    const result = JSON.parse(writtenAgents);
    expect(result.map((a: any) => a.id)).toEqual(['durable_c', 'durable_a', 'durable_b']);
  });

  it('appends agents not in orderedIds', async () => {
    await reorderDurable(PROJECT_PATH, ['durable_b']);
    await flushAgentConfig(PROJECT_PATH);
    const result = JSON.parse(writtenAgents);
    expect(result.map((a: any) => a.id)).toEqual(['durable_b', 'durable_a', 'durable_c']);
  });

  it('ignores unknown ids in orderedIds', async () => {
    await reorderDurable(PROJECT_PATH, ['nonexistent', 'durable_c', 'durable_a']);
    await flushAgentConfig(PROJECT_PATH);
    const result = JSON.parse(writtenAgents);
    expect(result.map((a: any) => a.id)).toEqual(['durable_c', 'durable_a', 'durable_b']);
  });

  it('returns the reordered array', async () => {
    const result = await reorderDurable(PROJECT_PATH, ['durable_b', 'durable_c', 'durable_a']);
    expect(result.map((a) => a.id)).toEqual(['durable_b', 'durable_c', 'durable_a']);
  });
});

describe('renameDurable', () => {
  it('updates name in config', async () => {
    const agents = [{ id: 'durable_ren', name: 'old-name', color: 'indigo', branch: 'old-name/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    let writtenAgents = '';
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenAgents = String(data); });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

    await renameDurable(PROJECT_PATH, 'durable_ren', 'new-name');
    await flushAgentConfig(PROJECT_PATH);
    const result = JSON.parse(writtenAgents);
    expect(result[0].name).toBe('new-name');
  });
});

describe('updateDurable', () => {
  let writtenAgents: string;
  const agents = [{ id: 'durable_upd', name: 'old-name', color: 'indigo', icon: 'durable_upd.png', branch: 'old-name/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];

  beforeEach(() => {
    vi.clearAllMocks();
    writtenAgents = '';
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenAgents = String(data); });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
  });

  it('updates name only', async () => {
    await updateDurable(PROJECT_PATH, 'durable_upd', { name: 'new-name' });
    await flushAgentConfig(PROJECT_PATH);
    const result = JSON.parse(writtenAgents);
    expect(result[0].name).toBe('new-name');
    expect(result[0].color).toBe('indigo');
    expect(result[0].icon).toBe('durable_upd.png');
  });

  it('updates color only', async () => {
    await updateDurable(PROJECT_PATH, 'durable_upd', { color: 'emerald' });
    await flushAgentConfig(PROJECT_PATH);
    const result = JSON.parse(writtenAgents);
    expect(result[0].color).toBe('emerald');
    expect(result[0].name).toBe('old-name');
  });

  it('sets icon', async () => {
    await updateDurable(PROJECT_PATH, 'durable_upd', { icon: 'durable_upd_new.png' });
    await flushAgentConfig(PROJECT_PATH);
    const result = JSON.parse(writtenAgents);
    expect(result[0].icon).toBe('durable_upd_new.png');
  });

  it('clears icon when null', async () => {
    await updateDurable(PROJECT_PATH, 'durable_upd', { icon: null });
    await flushAgentConfig(PROJECT_PATH);
    const result = JSON.parse(writtenAgents);
    expect(result[0]).not.toHaveProperty('icon');
  });

  it('clears icon when empty string', async () => {
    await updateDurable(PROJECT_PATH, 'durable_upd', { icon: '' });
    await flushAgentConfig(PROJECT_PATH);
    const result = JSON.parse(writtenAgents);
    expect(result[0]).not.toHaveProperty('icon');
  });

  it('no-op for unknown agentId', async () => {
    await updateDurable(PROJECT_PATH, 'nonexistent', { name: 'foo' });
    await flushAgentConfig(PROJECT_PATH);
    const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
    const agentWrites = writeCalls.filter((c) => String(c[0]).endsWith('agents.json'));
    if (agentWrites.length > 0) {
      const lastWritten = JSON.parse(String(agentWrites[agentWrites.length - 1][1]));
      expect(lastWritten[0].name).toBe('old-name'); // not 'foo'
    }
  });
});

describe('getWorktreeStatus', () => {
  it('invalid agent returns isValid:false', async () => {
    mockNoAgentsFile();
    const status = await getWorktreeStatus(PROJECT_PATH, 'nonexistent');
    expect(status.isValid).toBe(false);
  });

  it('missing .git returns isValid:false', async () => {
    const agents = [{ id: 'durable_nogit', name: 'nogit', color: 'indigo', branch: 'nogit/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('agents.json')) return true;
      if (s === '/test/wt') return true;
      if (s === path.join('/test/wt', '.git')) return false;
      return false;
    });
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));

    const status = await getWorktreeStatus(PROJECT_PATH, 'durable_nogit');
    expect(status.isValid).toBe(false);
  });

  it('non-worktree agent returns isValid:false', async () => {
    const agents = [{ id: 'durable_nowt', name: 'nowt', color: 'indigo', createdAt: '2024-01-01' }];
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));

    const status = await getWorktreeStatus(PROJECT_PATH, 'durable_nowt');
    expect(status.isValid).toBe(false);
  });

  it('valid worktree runs git commands async and returns parsed status', async () => {
    const agents = [{ id: 'durable_wt', name: 'wt', color: 'indigo', branch: 'wt/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('agents.json')) return true;
      if (s === '/test/wt') return true;
      if (s === path.join('/test/wt', '.git')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));

    // Mock exec to simulate git commands
    vi.mocked(execFile).mockImplementation((_file: any, args: any, _opts: any, cb: any) => {
      const cmdStr = args.join(' ');
      if (cmdStr.includes('status --porcelain')) {
        cb(null, ' M src/file.ts\n?? newfile.ts\n', '');
      } else if (cmdStr.includes('rev-parse --verify main')) {
        cb(null, 'abc123\n', '');
      } else if (cmdStr.includes('remote')) {
        cb(null, 'origin\n', '');
      } else if (cmdStr.includes('log')) {
        cb(null, 'abc123|abc1|fix bug|Author|2024-01-01 00:00:00 +0000\n', '');
      } else {
        cb(null, '', '');
      }
      return {} as any;
    });

    const status = await getWorktreeStatus(PROJECT_PATH, 'durable_wt');
    expect(status.isValid).toBe(true);
    expect(status.branch).toBe('wt/standby');
    expect(status.hasRemote).toBe(true);
    expect(status.uncommittedFiles).toHaveLength(2);
    expect(status.uncommittedFiles[0].path).toBe('src/file.ts');
    expect(status.unpushedCommits).toHaveLength(1);
    expect(status.unpushedCommits[0].shortHash).toBe('abc1');
  });

  it('handles git command failures gracefully', async () => {
    const agents = [{ id: 'durable_fail', name: 'fail', color: 'indigo', branch: 'fail/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('agents.json')) return true;
      if (s === '/test/wt') return true;
      if (s === path.join('/test/wt', '.git')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));

    // All git commands fail
    vi.mocked(execFile).mockImplementation((_file: any, _args: any, _opts: any, cb: any) => {
      cb(new Error('git failed'), '', '');
      return {} as any;
    });

    const status = await getWorktreeStatus(PROJECT_PATH, 'durable_fail');
    expect(status.isValid).toBe(true);
    expect(status.uncommittedFiles).toHaveLength(0);
    expect(status.unpushedCommits).toHaveLength(0);
    expect(status.hasRemote).toBe(false);
  });
});

describe('deleteCommitAndPush', () => {
  it('stages, commits, pushes, deletes via async exec', async () => {
    const agents = [{ id: 'durable_dcp', name: 'dcp', color: 'indigo', branch: 'dcp/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('agents.json')) return true;
      if (s.endsWith('.git')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(execFile).mockImplementation((_file: any, args: any, _opts: any, cb: any) => {
      const argsStr = args.join(' ');
      if (argsStr.includes('remote')) cb(null, 'origin\n', '');
      else cb(null, '', '');
      return {} as any;
    });

    const result = await deleteCommitAndPush(PROJECT_PATH, 'durable_dcp');
    expect(result.ok).toBe(true);
    const calls = vi.mocked(execFile).mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls.some((c) => c.includes('add -A'))).toBe(true);
    expect(calls.some((c) => c.includes('commit'))).toBe(true);
    expect(calls.some((c) => c.includes('push'))).toBe(true);
  });

  it('agent not found returns ok:false', async () => {
    mockNoAgentsFile();
    const result = await deleteCommitAndPush(PROJECT_PATH, 'nonexistent');
    expect(result.ok).toBe(false);
  });
});

describe('deleteUnregister', () => {
  it('removes from config, leaves files', async () => {
    const agents = [
      { id: 'durable_unreg', name: 'unreg', color: 'indigo', branch: 'unreg/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' },
    ];
    let writtenAgents = '';
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenAgents = String(data); });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

    const result = await deleteUnregister(PROJECT_PATH, 'durable_unreg');
    await flushAgentConfig(PROJECT_PATH);
    expect(result.ok).toBe(true);
    const remaining = JSON.parse(writtenAgents);
    expect(remaining.length).toBe(0);
    // No rm or git commands
    expect(vi.mocked(fsp.rm)).not.toHaveBeenCalled();
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
  });
});

describe('deleteForce', () => {
  it('delegates to deleteDurable', async () => {
    const agents = [{ id: 'durable_force', name: 'force', color: 'indigo', branch: 'force/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('agents.json')) return true;
      if (s.endsWith('.git')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(execFile).mockImplementation((_file: any, _args: any, _opts: any, cb: any) => { cb(null, '', ''); return {} as any; });

    const result = await deleteForce(PROJECT_PATH, 'durable_force');
    expect(result.ok).toBe(true);
  });
});

describe('getDurableConfig', () => {
  it('returns correct agent by id', async () => {
    const agents = [
      { id: 'durable_1', name: 'agent-one', color: 'indigo', branch: 'one/standby', worktreePath: '/test/wt1', createdAt: '2024-01-01' },
      { id: 'durable_2', name: 'agent-two', color: 'emerald', branch: 'two/standby', worktreePath: '/test/wt2', createdAt: '2024-01-01' },
    ];
    mockAgentsFile(agents);
    const result = await getDurableConfig(PROJECT_PATH, 'durable_2');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('agent-two');
  });

  it('returns null for unknown agent', async () => {
    const agents = [
      { id: 'durable_1', name: 'agent-one', color: 'indigo', branch: 'one/standby', worktreePath: '/test/wt1', createdAt: '2024-01-01' },
    ];
    mockAgentsFile(agents);
    const result = await getDurableConfig(PROJECT_PATH, 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns null when no agents file', async () => {
    mockNoAgentsFile();
    const result = await getDurableConfig(PROJECT_PATH, 'durable_1');
    expect(result).toBeNull();
  });
});

describe('updateDurableConfig', () => {
  it('persists quickAgentDefaults and round-trips', async () => {
    const agents = [
      { id: 'durable_upd', name: 'upd', color: 'indigo', branch: 'upd/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' },
    ];
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(agents);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dest: any) => {
      writtenData[String(dest)] = writtenData[String(src)] || '';
      delete writtenData[String(src)];
    });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

    const defaults = { systemPrompt: 'Be concise', allowedTools: ['Bash(npm test:*)'], defaultModel: 'sonnet' };
    await updateDurableConfig(PROJECT_PATH, 'durable_upd', { quickAgentDefaults: defaults });

    // Read back
    const result = await getDurableConfig(PROJECT_PATH, 'durable_upd');
    expect(result).not.toBeNull();
    expect(result!.quickAgentDefaults).toEqual(defaults);
  });

  it('no-op for unknown agent', async () => {
    const agents = [
      { id: 'durable_1', name: 'one', color: 'indigo', branch: 'one/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' },
    ];
    mockAgentsFile(agents);
    // Should not throw
    await expect(updateDurableConfig(PROJECT_PATH, 'nonexistent', { quickAgentDefaults: { systemPrompt: 'x' } })).resolves.not.toThrow();
  });

  it('persists model field and round-trips', async () => {
    const agents = [
      { id: 'durable_model', name: 'model-agent', color: 'indigo', createdAt: '2024-01-01' },
    ];
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(agents);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dest: any) => {
      writtenData[String(dest)] = writtenData[String(src)] || '';
      delete writtenData[String(src)];
    });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

    await updateDurableConfig(PROJECT_PATH, 'durable_model', { model: 'sonnet' });

    const result = await getDurableConfig(PROJECT_PATH, 'durable_model');
    expect(result).not.toBeNull();
    expect(result!.model).toBe('sonnet');
  });

  it('removes model field when set to "default"', async () => {
    const agents = [
      { id: 'durable_defmodel', name: 'def-model', color: 'indigo', model: 'opus', createdAt: '2024-01-01' },
    ];
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(agents);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dest: any) => {
      writtenData[String(dest)] = writtenData[String(src)] || '';
      delete writtenData[String(src)];
    });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

    await updateDurableConfig(PROJECT_PATH, 'durable_defmodel', { model: 'default' });

    const result = await getDurableConfig(PROJECT_PATH, 'durable_defmodel');
    expect(result).not.toBeNull();
    expect(result!.model).toBeUndefined();
  });

  it('persists freeAgentMode when set to true', async () => {
    const agents = [
      { id: 'durable_fam', name: 'fam-agent', color: 'indigo', createdAt: '2024-01-01' },
    ];
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(agents);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dest: any) => {
      writtenData[String(dest)] = writtenData[String(src)] || '';
      delete writtenData[String(src)];
    });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

    await updateDurableConfig(PROJECT_PATH, 'durable_fam', { freeAgentMode: true });

    const result = await getDurableConfig(PROJECT_PATH, 'durable_fam');
    expect(result).not.toBeNull();
    expect(result!.freeAgentMode).toBe(true);
  });

  it('removes freeAgentMode field when set to false', async () => {
    const agents = [
      { id: 'durable_fam_off', name: 'fam-off', color: 'indigo', freeAgentMode: true, createdAt: '2024-01-01' },
    ];
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(agents);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dest: any) => {
      writtenData[String(dest)] = writtenData[String(src)] || '';
      delete writtenData[String(src)];
    });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

    await updateDurableConfig(PROJECT_PATH, 'durable_fam_off', { freeAgentMode: false });

    const result = await getDurableConfig(PROJECT_PATH, 'durable_fam_off');
    expect(result).not.toBeNull();
    expect(result!.freeAgentMode).toBeUndefined();
  });

  it('persists lastSessionId and round-trips', async () => {
    const agents = [
      { id: 'durable_sess', name: 'sess-agent', color: 'indigo', createdAt: '2024-01-01' },
    ];
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(agents);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dest: any) => {
      writtenData[String(dest)] = writtenData[String(src)] || '';
      delete writtenData[String(src)];
    });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

    await updateDurableConfig(PROJECT_PATH, 'durable_sess', { lastSessionId: 'sess-abc-123' });

    const result = await getDurableConfig(PROJECT_PATH, 'durable_sess');
    expect(result).not.toBeNull();
    expect(result!.lastSessionId).toBe('sess-abc-123');
  });

  it('removes lastSessionId field when set to null', async () => {
    const agents = [
      { id: 'durable_clearsess', name: 'clearsess', color: 'indigo', lastSessionId: 'old-session', createdAt: '2024-01-01' },
    ];
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(agents);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dest: any) => {
      writtenData[String(dest)] = writtenData[String(src)] || '';
      delete writtenData[String(src)];
    });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

    await updateDurableConfig(PROJECT_PATH, 'durable_clearsess', { lastSessionId: null });

    const result = await getDurableConfig(PROJECT_PATH, 'durable_clearsess');
    expect(result).not.toBeNull();
    expect(result!.lastSessionId).toBeUndefined();
  });
});

describe('updateSessionId', () => {
  it('persists a session ID via updateSessionId helper', async () => {
    const agents = [
      { id: 'durable_sid', name: 'sid-agent', color: 'indigo', createdAt: '2024-01-01' },
    ];
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(agents);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dest: any) => {
      writtenData[String(dest)] = writtenData[String(src)] || '';
      delete writtenData[String(src)];
    });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

    await updateSessionId(PROJECT_PATH, 'durable_sid', 'session-uuid-789');

    const result = await getDurableConfig(PROJECT_PATH, 'durable_sid');
    expect(result).not.toBeNull();
    expect(result!.lastSessionId).toBe('session-uuid-789');
  });

  it('clears session ID when null', async () => {
    const agents = [
      { id: 'durable_clr', name: 'clr-agent', color: 'indigo', lastSessionId: 'old-sess', createdAt: '2024-01-01' },
    ];
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(agents);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dest: any) => {
      writtenData[String(dest)] = writtenData[String(src)] || '';
      delete writtenData[String(src)];
    });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

    await updateSessionId(PROJECT_PATH, 'durable_clr', null);

    const result = await getDurableConfig(PROJECT_PATH, 'durable_clr');
    expect(result).not.toBeNull();
    expect(result!.lastSessionId).toBeUndefined();
  });
});

describe('addSessionEntry', () => {
  function setupWritableAgents(agents: any[]) {
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(agents);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dest: any) => {
      writtenData[String(dest)] = writtenData[String(src)] || '';
      delete writtenData[String(src)];
    });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    return writtenData;
  }

  it('adds a new session entry to an agent with no history', async () => {
    setupWritableAgents([
      { id: 'durable_1', name: 'agent-1', color: 'indigo', createdAt: '2024-01-01' },
    ]);

    await addSessionEntry(PROJECT_PATH, 'durable_1', {
      sessionId: 'sess-001',
      startedAt: '2024-06-01T00:00:00Z',
      lastActiveAt: '2024-06-01T01:00:00Z',
    });

    const config = await getDurableConfig(PROJECT_PATH, 'durable_1');
    expect(config!.sessionHistory).toHaveLength(1);
    expect(config!.sessionHistory![0].sessionId).toBe('sess-001');
    expect(config!.lastSessionId).toBe('sess-001');
  });

  it('updates existing session entry and preserves friendly name', async () => {
    setupWritableAgents([
      {
        id: 'durable_2', name: 'agent-2', color: 'indigo', createdAt: '2024-01-01',
        sessionHistory: [
          { sessionId: 'sess-001', startedAt: '2024-06-01T00:00:00Z', lastActiveAt: '2024-06-01T01:00:00Z', friendlyName: 'My Session' },
        ],
      },
    ]);

    await addSessionEntry(PROJECT_PATH, 'durable_2', {
      sessionId: 'sess-001',
      startedAt: '2024-06-01T00:00:00Z',
      lastActiveAt: '2024-06-02T00:00:00Z',
    });

    const config = await getDurableConfig(PROJECT_PATH, 'durable_2');
    expect(config!.sessionHistory).toHaveLength(1);
    expect(config!.sessionHistory![0].lastActiveAt).toBe('2024-06-02T00:00:00Z');
    expect(config!.sessionHistory![0].friendlyName).toBe('My Session');
  });

  it('does nothing for unknown agent', async () => {
    setupWritableAgents([]);
    await addSessionEntry(PROJECT_PATH, 'nonexistent', {
      sessionId: 'sess-001',
      startedAt: '2024-06-01T00:00:00Z',
      lastActiveAt: '2024-06-01T01:00:00Z',
    });
    // Should not throw
  });
});

describe('updateSessionName', () => {
  it('sets a friendly name on an existing session', async () => {
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify([
      {
        id: 'durable_n1', name: 'agent-n1', color: 'indigo', createdAt: '2024-01-01',
        sessionHistory: [
          { sessionId: 'sess-001', startedAt: '2024-06-01T00:00:00Z', lastActiveAt: '2024-06-01T01:00:00Z' },
        ],
      },
    ]);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => writtenData[String(p)] || '[]');
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenData[String(p)] = String(data); });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

    await updateSessionName(PROJECT_PATH, 'durable_n1', 'sess-001', 'Bug Fix Session');

    const config = await getDurableConfig(PROJECT_PATH, 'durable_n1');
    expect(config!.sessionHistory![0].friendlyName).toBe('Bug Fix Session');
  });

  it('clears a friendly name when null', async () => {
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify([
      {
        id: 'durable_n2', name: 'agent-n2', color: 'indigo', createdAt: '2024-01-01',
        sessionHistory: [
          { sessionId: 'sess-002', startedAt: '2024-06-01T00:00:00Z', lastActiveAt: '2024-06-01T01:00:00Z', friendlyName: 'Old Name' },
        ],
      },
    ]);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => writtenData[String(p)] || '[]');
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => { writtenData[String(p)] = String(data); });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

    await updateSessionName(PROJECT_PATH, 'durable_n2', 'sess-002', null);

    const config = await getDurableConfig(PROJECT_PATH, 'durable_n2');
    expect(config!.sessionHistory![0].friendlyName).toBeUndefined();
  });
});

describe('getSessionHistory', () => {
  it('returns sessions sorted by most recently active', async () => {
    const agents = [
      {
        id: 'durable_h1', name: 'agent-h1', color: 'indigo', createdAt: '2024-01-01',
        sessionHistory: [
          { sessionId: 'old', startedAt: '2024-01-01T00:00:00Z', lastActiveAt: '2024-01-01T01:00:00Z' },
          { sessionId: 'new', startedAt: '2024-06-01T00:00:00Z', lastActiveAt: '2024-06-01T01:00:00Z' },
          { sessionId: 'mid', startedAt: '2024-03-01T00:00:00Z', lastActiveAt: '2024-03-01T01:00:00Z' },
        ],
      },
    ];
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));

    const history = await getSessionHistory(PROJECT_PATH, 'durable_h1');
    expect(history).toHaveLength(3);
    expect(history[0].sessionId).toBe('new');
    expect(history[1].sessionId).toBe('mid');
    expect(history[2].sessionId).toBe('old');
  });

  it('returns empty array for agent without session history', async () => {
    const agents = [
      { id: 'durable_h2', name: 'agent-h2', color: 'indigo', createdAt: '2024-01-01' },
    ];
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(agents));

    const history = await getSessionHistory(PROJECT_PATH, 'durable_h2');
    expect(history).toEqual([]);
  });

  it('returns empty array for unknown agent', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readFile).mockResolvedValue('[]');

    const history = await getSessionHistory(PROJECT_PATH, 'nonexistent');
    expect(history).toEqual([]);
  });
});

describe('ensureGitignore edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.appendFile).mockResolvedValue(undefined);
    // Default async exec mock for createDurable
    vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
      cb(null, '', '');
      return {} as any;
    });
  });

  it('appends selective patterns when .gitignore exists without clubhouse patterns', async () => {
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('.gitignore')) return true;
      if (s.endsWith('.git')) return true;
      if (s.endsWith('agents.json')) return false;
      if (s.endsWith('settings.json')) return false;
      if (s.endsWith('README.md')) return false;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p).endsWith('.gitignore')) return 'node_modules/\n';
      return '[]';
    });

    await createDurable(PROJECT_PATH, 'append-test', 'indigo');
    expect(vi.mocked(fsp.appendFile)).toHaveBeenCalled();
    const appendCall = vi.mocked(fsp.appendFile).mock.calls[0];
    expect(String(appendCall[1])).toContain('.clubhouse/agents/');
    expect(String(appendCall[1])).toContain('.clubhouse/agents.json');
  });

  it('creates .gitignore when none exists', async () => {
    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      const s = String(p);
      if (s.endsWith('.gitignore')) return false;
      if (s.endsWith('.git')) return true;
      if (s.endsWith('agents.json')) return false;
      if (s.endsWith('settings.json')) return false;
      if (s.endsWith('README.md')) return false;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p).endsWith('.gitignore')) throw new Error('not found');
      return '[]';
    });

    await createDurable(PROJECT_PATH, 'create-gitignore-test', 'indigo');
    const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
    const gitignoreWrite = writeCalls.find((c) => String(c[0]).endsWith('.gitignore'));
    expect(gitignoreWrite).toBeDefined();
    expect(String(gitignoreWrite![1])).toContain('.clubhouse/agents/');
  });
});

describe('saveAgentIcon', () => {
  const AGENT_ID = 'test-agent-123';

  beforeEach(() => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(fsp.readdir).mockResolvedValue([]);
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      if (String(p).endsWith('agents.json'))
        return JSON.stringify([{ id: AGENT_ID, name: 'Test Agent' }]);
      return '';
    });
  });

  it('strips standard png data URL prefix', async () => {
    const base64Content = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB';
    const dataUrl = `data:image/png;base64,${base64Content}`;

    await saveAgentIcon(PROJECT_PATH, AGENT_ID, dataUrl);

    const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
    const iconWrite = writeCalls.find((c) => String(c[0]).endsWith(`${AGENT_ID}.png`));
    expect(iconWrite).toBeDefined();
    // The written buffer should be the decoded base64, not still contain the prefix
    expect(Buffer.isBuffer(iconWrite![1])).toBe(true);
    expect(iconWrite![1]).toEqual(Buffer.from(base64Content, 'base64'));
  });

  it('strips svg+xml data URL prefix (issue #190)', async () => {
    const base64Content = 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==';
    const dataUrl = `data:image/svg+xml;base64,${base64Content}`;

    await saveAgentIcon(PROJECT_PATH, AGENT_ID, dataUrl);

    const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
    const iconWrite = writeCalls.find((c) => String(c[0]).endsWith(`${AGENT_ID}.png`));
    expect(iconWrite).toBeDefined();
    expect(iconWrite![1]).toEqual(Buffer.from(base64Content, 'base64'));
  });

  it('strips jpeg data URL prefix', async () => {
    const base64Content = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQ==';
    const dataUrl = `data:image/jpeg;base64,${base64Content}`;

    await saveAgentIcon(PROJECT_PATH, AGENT_ID, dataUrl);

    const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
    const iconWrite = writeCalls.find((c) => String(c[0]).endsWith(`${AGENT_ID}.png`));
    expect(iconWrite).toBeDefined();
    expect(iconWrite![1]).toEqual(Buffer.from(base64Content, 'base64'));
  });

  it('strips webp data URL prefix', async () => {
    const base64Content = 'UklGRlYAAABXRUJQVlA4IEoAAADQAQCdASoBAAEAAkA=';
    const dataUrl = `data:image/webp;base64,${base64Content}`;

    await saveAgentIcon(PROJECT_PATH, AGENT_ID, dataUrl);

    const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
    const iconWrite = writeCalls.find((c) => String(c[0]).endsWith(`${AGENT_ID}.png`));
    expect(iconWrite).toBeDefined();
    expect(iconWrite![1]).toEqual(Buffer.from(base64Content, 'base64'));
  });

  it('updates agent icon field in agents.json', async () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';

    await saveAgentIcon(PROJECT_PATH, AGENT_ID, dataUrl);
    await flushAgentConfig(PROJECT_PATH);

    // Atomic write goes to a temp file — find the agents.json temp write
    const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
    const agentsWrite = writeCalls.find((c) => String(c[0]).includes('agents.json.tmp.'));
    expect(agentsWrite).toBeDefined();
    const agents = JSON.parse(String(agentsWrite![1]));
    expect(agents[0].icon).toBe(`${AGENT_ID}.png`);
  });
});

describe('write-back cache', () => {
  const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');

  function setupCacheTest(agents: any[]) {
    const writtenData: Record<string, string> = {};
    writtenData[agentsJsonPath] = JSON.stringify(agents);

    vi.mocked(pathExists).mockImplementation(async (p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });
    vi.mocked(fsp.rename).mockImplementation(async (src: any, dest: any) => {
      writtenData[String(dest)] = writtenData[String(src)] || '';
      delete writtenData[String(src)];
    });
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    return writtenData;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads from disk only once for multiple reads', async () => {
    setupCacheTest([
      { id: 'durable_1', name: 'agent-1', color: 'indigo', createdAt: '2024-01-01' },
    ]);

    // First read populates cache
    const result1 = await listDurable(PROJECT_PATH);
    expect(result1).toHaveLength(1);

    // Second read should come from cache
    const result2 = await getDurableConfig(PROJECT_PATH, 'durable_1');
    expect(result2!.name).toBe('agent-1');

    // readFile should only have been called once (for agents.json)
    const readCalls = vi.mocked(fsp.readFile).mock.calls
      .filter((c) => String(c[0]).endsWith('agents.json'));
    expect(readCalls).toHaveLength(1);
  });

  it('coalesces multiple writes into one disk write on flush', async () => {
    setupCacheTest([
      { id: 'durable_1', name: 'agent-1', color: 'indigo', createdAt: '2024-01-01' },
    ]);

    // Perform multiple sequential modifications
    await renameDurable(PROJECT_PATH, 'durable_1', 'renamed');
    await updateDurable(PROJECT_PATH, 'durable_1', { color: 'emerald' });

    // No disk writes yet (debounced) — atomic writes go to temp files
    const writesBefore = vi.mocked(fsp.writeFile).mock.calls
      .filter((c) => String(c[0]).includes('agents.json.tmp.'));
    expect(writesBefore).toHaveLength(0);

    // Flush writes to disk
    await flushAgentConfig(PROJECT_PATH);

    // Only one atomic write should have occurred (temp file)
    const writesAfter = vi.mocked(fsp.writeFile).mock.calls
      .filter((c) => String(c[0]).includes('agents.json.tmp.'));
    expect(writesAfter).toHaveLength(1);

    // The single write should contain both modifications
    const written = JSON.parse(String(writesAfter[0][1]));
    expect(written[0].name).toBe('renamed');
    expect(written[0].color).toBe('emerald');
  });

  it('serves updated data from cache before flush', async () => {
    setupCacheTest([
      { id: 'durable_1', name: 'agent-1', color: 'indigo', createdAt: '2024-01-01' },
    ]);

    await renameDurable(PROJECT_PATH, 'durable_1', 'cached-name');

    // Read should return the cached (updated) data without flushing
    const config = await getDurableConfig(PROJECT_PATH, 'durable_1');
    expect(config!.name).toBe('cached-name');

    // readFile should only have been called once (initial cache population)
    const readCalls = vi.mocked(fsp.readFile).mock.calls
      .filter((c) => String(c[0]).endsWith('agents.json'));
    expect(readCalls).toHaveLength(1);
  });

  it('clearAgentConfigCache discards pending writes', async () => {
    setupCacheTest([
      { id: 'durable_1', name: 'agent-1', color: 'indigo', createdAt: '2024-01-01' },
    ]);

    await renameDurable(PROJECT_PATH, 'durable_1', 'will-be-discarded');
    clearAgentConfigCache();

    // No disk write should have occurred
    const writes = vi.mocked(fsp.writeFile).mock.calls
      .filter((c) => String(c[0]).endsWith('agents.json'));
    expect(writes).toHaveLength(0);

    // Next read should go to disk again (cache was cleared)
    const config = await getDurableConfig(PROJECT_PATH, 'durable_1');
    expect(config!.name).toBe('agent-1'); // original name from disk
  });

  it('flushAgentConfig is idempotent when no changes pending', async () => {
    setupCacheTest([
      { id: 'durable_1', name: 'agent-1', color: 'indigo', createdAt: '2024-01-01' },
    ]);

    // Read to populate cache
    await listDurable(PROJECT_PATH);

    // Flush with no pending writes
    await flushAgentConfig(PROJECT_PATH);
    await flushAgentConfig(PROJECT_PATH);

    // No disk writes should have occurred
    const writes = vi.mocked(fsp.writeFile).mock.calls
      .filter((c) => String(c[0]).endsWith('agents.json'));
    expect(writes).toHaveLength(0);
  });

  it('sequential operations only read from disk once', async () => {
    setupCacheTest([
      { id: 'durable_1', name: 'agent-1', color: 'indigo', createdAt: '2024-01-01' },
      { id: 'durable_2', name: 'agent-2', color: 'amber', createdAt: '2024-01-02' },
    ]);

    // Perform a sequence of read-modify-write operations
    await renameDurable(PROJECT_PATH, 'durable_1', 'renamed-1');
    await renameDurable(PROJECT_PATH, 'durable_2', 'renamed-2');
    await updateDurable(PROJECT_PATH, 'durable_1', { color: 'emerald' });
    await updateDurable(PROJECT_PATH, 'durable_2', { color: 'rose' });

    // Only one readFile for agents.json (initial cache population)
    const readCalls = vi.mocked(fsp.readFile).mock.calls
      .filter((c) => String(c[0]).endsWith('agents.json'));
    expect(readCalls).toHaveLength(1);

    // No disk writes yet — atomic writes go to temp files
    const writesBefore = vi.mocked(fsp.writeFile).mock.calls
      .filter((c) => String(c[0]).includes('agents.json.tmp.'));
    expect(writesBefore).toHaveLength(0);

    // Flush and verify all changes persisted
    await flushAgentConfig(PROJECT_PATH);

    const writesAfter = vi.mocked(fsp.writeFile).mock.calls
      .filter((c) => String(c[0]).includes('agents.json.tmp.'));
    expect(writesAfter).toHaveLength(1);

    const written = JSON.parse(String(writesAfter[0][1]));
    expect(written[0].name).toBe('renamed-1');
    expect(written[0].color).toBe('emerald');
    expect(written[1].name).toBe('renamed-2');
    expect(written[1].color).toBe('rose');
  });
});

// ── Backup and Recovery ──────────────────────────────────────────────

describe('backup and recovery', () => {
  const BACKUP_AGENTS = [
    { id: 'durable_1', name: 'agent-one', color: 'indigo', createdAt: '2024-01-01' },
    { id: 'durable_2', name: 'agent-two', color: 'rose', createdAt: '2024-01-02' },
    { id: 'durable_3', name: 'agent-three', color: 'emerald', createdAt: '2024-01-03' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsp.rename).mockResolvedValue(undefined);
    vi.mocked(fsp.copyFile).mockResolvedValue(undefined);
  });

  describe('auto-recovery on corrupt agents.json', () => {
    it('recovers from backup when main file is corrupt', async () => {
      vi.mocked(pathExists).mockImplementation(async (p: any) => {
        const s = String(p);
        if (s.endsWith('agents.json.bak')) return true;
        if (s.endsWith('agents.json')) return true;
        return false;
      });
      vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
        const s = String(p);
        if (s.endsWith('agents.json.bak')) return JSON.stringify(BACKUP_AGENTS);
        if (s.endsWith('agents.json')) return '{{corrupt';
        return '';
      });

      const result = await listDurable(PROJECT_PATH);
      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('agent-one');
    });

    it('recovers from backup when main file is missing', async () => {
      vi.mocked(pathExists).mockImplementation(async (p: any) => {
        const s = String(p);
        if (s.endsWith('agents.json.bak')) return true;
        if (s.endsWith('agents.json')) return false;
        return false;
      });
      vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
        if (String(p).endsWith('agents.json.bak')) return JSON.stringify(BACKUP_AGENTS);
        return '';
      });

      const result = await listDurable(PROJECT_PATH);
      expect(result).toHaveLength(3);
    });

    it('returns [] when both main and backup are corrupt', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readFile).mockResolvedValue('{{corrupt');

      const result = await listDurable(PROJECT_PATH);
      expect(result).toEqual([]);
    });
  });

  describe('atomic writes', () => {
    it('writeAgentsToDisk uses temp file + rename', async () => {
      // Mock: no existing file
      vi.mocked(pathExists).mockImplementation(async (p: any) => {
        if (String(p).endsWith('agents.json')) return false;
        if (String(p).endsWith('agents.json.bak')) return false;
        if (String(p).endsWith('.git')) return true;
        if (String(p).endsWith('.gitignore')) return false;
        return false;
      });
      vi.mocked(fsp.readFile).mockResolvedValue('[]');
      vi.mocked(isInsideGitRepo).mockResolvedValue(true);
      vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
        cb(null, '', '');
        return {} as any;
      });

      await createDurable(PROJECT_PATH, 'test-agent', 'blue');
      await flushAgentConfig(PROJECT_PATH);

      // Verify temp file was written and then renamed
      const writeCall = vi.mocked(fsp.writeFile).mock.calls.find(
        (call) => String(call[0]).includes('.tmp.'),
      );
      expect(writeCall).toBeDefined();
      expect(vi.mocked(fsp.rename)).toHaveBeenCalled();
    });

    it('creates backup before writing', async () => {
      vi.mocked(pathExists).mockImplementation(async (p: any) => {
        const s = String(p);
        if (s.endsWith('agents.json')) return true;
        if (s.endsWith('agents.json.bak')) return false;
        if (s.endsWith('.git')) return true;
        if (s.endsWith('.gitignore')) return false;
        return false;
      });
      vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
        if (String(p).endsWith('agents.json')) return JSON.stringify(BACKUP_AGENTS);
        return '';
      });

      await listDurable(PROJECT_PATH); // populate cache

      // Trigger a write by renaming an agent (this calls writeAgents internally)
      await renameDurable(PROJECT_PATH, 'durable_1', 'renamed-agent');
      await flushAgentConfig(PROJECT_PATH);

      // Verify copyFile was called (backup creation)
      const copyCall = vi.mocked(fsp.copyFile).mock.calls.find(
        (call) => String(call[1]).endsWith('agents.json.bak'),
      );
      expect(copyCall).toBeDefined();
    });
  });

  describe('getBackupInfo', () => {
    it('returns null when no backup exists', async () => {
      vi.mocked(pathExists).mockImplementation(async (p: any) => {
        if (String(p).endsWith('agents.json.bak')) return false;
        if (String(p).endsWith('agents.json')) return true;
        return false;
      });
      vi.mocked(fsp.readFile).mockResolvedValue('[]');

      expect(await getBackupInfo(PROJECT_PATH)).toBeNull();
    });

    it('returns null when backup has same count as current', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readFile).mockImplementation(async () => {
        return JSON.stringify(BACKUP_AGENTS);
      });

      expect(await getBackupInfo(PROJECT_PATH)).toBeNull();
    });

    it('returns info when backup has more agents than current', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
        const s = String(p);
        if (s.endsWith('agents.json.bak')) return JSON.stringify(BACKUP_AGENTS);
        // Current only has 1 agent
        return JSON.stringify([BACKUP_AGENTS[0]]);
      });

      const info = await getBackupInfo(PROJECT_PATH);
      expect(info).not.toBeNull();
      expect(info!.backupAgents).toHaveLength(3);
      expect(info!.currentCount).toBe(1);
    });
  });

  describe('restoreFromBackup', () => {
    it('restores missing agents from backup', async () => {
      const writtenData: Record<string, string> = {};
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readFile).mockImplementation(async (p: any) => {
        const s = String(p);
        if (writtenData[s]) return writtenData[s];
        if (s.endsWith('agents.json.bak')) return JSON.stringify(BACKUP_AGENTS);
        // Current only has first agent
        return JSON.stringify([BACKUP_AGENTS[0]]);
      });
      vi.mocked(fsp.writeFile).mockImplementation(async (p: any, data: any) => {
        writtenData[String(p)] = String(data);
      });

      const result = await restoreFromBackup(PROJECT_PATH);
      expect(result.restoredCount).toBe(2);
      expect(result.agents).toHaveLength(3);
    });

    it('returns 0 restored when no backup exists', async () => {
      vi.mocked(pathExists).mockImplementation(async (p: any) => {
        if (String(p).endsWith('agents.json.bak')) return false;
        if (String(p).endsWith('agents.json')) return true;
        return false;
      });
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify([BACKUP_AGENTS[0]]));

      const result = await restoreFromBackup(PROJECT_PATH);
      expect(result.restoredCount).toBe(0);
    });

    it('does not duplicate agents already present', async () => {
      vi.mocked(pathExists).mockResolvedValue(true);
      vi.mocked(fsp.readFile).mockImplementation(async () => {
        // Both have all 3 agents
        return JSON.stringify(BACKUP_AGENTS);
      });

      const result = await restoreFromBackup(PROJECT_PATH);
      expect(result.restoredCount).toBe(0);
    });
  });
});
