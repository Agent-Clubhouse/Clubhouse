import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

// Mock child_process (include execFile used by orchestrator providers)
// exec is used by async createDurable (via execGitAsync); execSync by other functions
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  exec: vi.fn((_cmd: string, _opts: any, cb: Function) => {
    cb(null, '', '');
    return {};
  }),
  execFile: vi.fn(),
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
}));

import * as fs from 'fs';
import { exec, execSync } from 'child_process';
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
  ensureGitignore,
  saveAgentIcon,
} from './agent-config';

const PROJECT_PATH = '/test/project';

function mockAgentsFile(agents: any[]) {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    if (String(p).endsWith('agents.json')) return true;
    if (String(p).endsWith('.git')) return true;
    return false;
  });
  vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
    if (String(p).endsWith('agents.json')) return JSON.stringify(agents);
    return '';
  });
}

function mockNoAgentsFile() {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    if (String(p).endsWith('agents.json')) return false;
    if (String(p).endsWith('.git')) return true;
    if (String(p).endsWith('.gitignore')) return false;
    return false;
  });
}

describe('readAgents (via listDurable)', () => {
  it('returns [] when no file exists', () => {
    mockNoAgentsFile();
    expect(listDurable(PROJECT_PATH)).toEqual([]);
  });

  it('returns [] on corrupt JSON', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{{invalid json');
    expect(listDurable(PROJECT_PATH)).toEqual([]);
  });

  it('parses valid agents.json', () => {
    const agents = [{ id: 'durable_1', name: 'test-agent', color: 'indigo', branch: 'test/standby', worktreePath: '/test', createdAt: '2024-01-01' }];
    mockAgentsFile(agents);
    const result = listDurable(PROJECT_PATH);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('durable_1');
    expect(result[0].name).toBe('test-agent');
  });
});

describe('createDurable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const writtenData: Record<string, string> = {};
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('.git')) return true;
      if (s.endsWith('.gitignore')) return false;
      if (s.endsWith('agents.json')) return !!writtenData[s];
      if (s.endsWith('CLAUDE.md')) return false;
      if (s.endsWith('settings.json')) return false;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const s = String(p);
      if (writtenData[s]) return writtenData[s];
      return '[]';
    });
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });
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
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
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
    // mkdirSync should have been called for the worktree path
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalled();
  });

  it('falls back to mkdir when worktree add fails', async () => {
    vi.mocked(exec).mockImplementation((cmd: any, _opts: any, cb: any) => {
      if (String(cmd).includes('git worktree add')) cb(new Error('worktree fail'), '', '');
      else cb(null, '', '');
      return {} as any;
    });
    const config = await createDurable(PROJECT_PATH, 'wt-fail-agent', 'indigo');
    expect(config.id).toMatch(/^durable_/);
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalled();
  });

  it('creates initial commit with .gitignore when repo has no commits', async () => {
    const writtenData: Record<string, string> = {};
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('.git')) return true;
      // .gitignore exists after ensureGitignore creates it
      if (s.endsWith('.gitignore')) return true;
      if (s.endsWith('agents.json')) return !!writtenData[s];
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('.gitignore')) return '';
      if (writtenData[s]) return writtenData[s];
      return '[]';
    });
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      writtenData[String(p)] = String(data);
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
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalled();
  });

  it('appends to existing config, does not overwrite', async () => {
    const existing = [{ id: 'durable_old', name: 'old', color: 'amber', branch: 'old/standby', worktreePath: '/old', createdAt: '2024-01-01' }];
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(existing);
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('.git')) return true;
      if (s.endsWith('.gitignore')) return false;
      if (s.endsWith('agents.json')) return true;
      if (s.endsWith('CLAUDE.local.md')) return false;
      if (s.endsWith('settings.json')) return false;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });

    await createDurable(PROJECT_PATH, 'new-agent', 'emerald');
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

  it('ensureGitignore skips when all patterns already present', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('.gitignore')) return true;
      if (s.endsWith('.git')) return true;
      if (s.endsWith('agents.json')) return false;
      if (s.endsWith('CLAUDE.local.md')) return false;
      if (s.endsWith('settings.json')) return false;
      if (s.endsWith('README.md')) return false;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('.gitignore'))
        return '# Clubhouse agent manager\n.clubhouse/agents/\n.clubhouse/.local/\n.clubhouse/agents.json\n.clubhouse/settings.local.json\n';
      return '[]';
    });

    await createDurable(PROJECT_PATH, 'gitignore-test', 'indigo');
    // Should NOT append because all patterns already exist
    expect(vi.mocked(fs.appendFileSync)).not.toHaveBeenCalled();
  });

  it('appends only missing gitignore patterns', async () => {
    const appendedData: string[] = [];
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('.gitignore')) return true;
      if (s.endsWith('.git')) return true;
      if (s.endsWith('agents.json')) return false;
      if (s.endsWith('CLAUDE.local.md')) return false;
      if (s.endsWith('settings.json')) return false;
      if (s.endsWith('README.md')) return false;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('.gitignore')) return '# Clubhouse agent manager\n.clubhouse/agents/\n';
      return '[]';
    });
    vi.mocked(fs.appendFileSync).mockImplementation((_p: any, data: any) => {
      appendedData.push(String(data));
    });

    await createDurable(PROJECT_PATH, 'partial-test', 'indigo');
    expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalled();
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
    // Verify async exec was used (not execSync) for git operations
    expect(vi.mocked(exec)).toHaveBeenCalled();
    // execSync should NOT be called by createDurable for worktree operations
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
  });
});

describe('deleteDurable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes agent from config file', () => {
    const agents = [
      { id: 'durable_del', name: 'del', color: 'indigo', branch: 'del/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' },
      { id: 'durable_keep', name: 'keep', color: 'amber', branch: 'keep/standby', worktreePath: '/test/wt2', createdAt: '2024-01-01' },
    ];
    let writtenAgents: string = '';
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('agents.json')) return true;
      if (s.endsWith('.git')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(agents));
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenAgents = String(data); });
    vi.mocked(execSync).mockReturnValue('');

    deleteDurable(PROJECT_PATH, 'durable_del');
    const result = JSON.parse(writtenAgents);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('durable_keep');
  });

  it('calls git worktree remove + branch -D', () => {
    const agents = [{ id: 'durable_git', name: 'git', color: 'indigo', branch: 'git/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('agents.json')) return true;
      if (s.endsWith('.git')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(agents));
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(execSync).mockReturnValue('');

    deleteDurable(PROJECT_PATH, 'durable_git');
    const calls = vi.mocked(execSync).mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes('git worktree remove'))).toBe(true);
    expect(calls.some((c) => c.includes('git branch -D'))).toBe(true);
  });

  it('continues if git commands fail', () => {
    const agents = [{ id: 'durable_fail', name: 'fail', color: 'indigo', branch: 'fail/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('agents.json')) return true;
      if (s.endsWith('.git')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(agents));
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(execSync).mockImplementation(() => { throw new Error('git fail'); });

    expect(() => deleteDurable(PROJECT_PATH, 'durable_fail')).not.toThrow();
  });

  it('rmSync if worktree still exists after git', () => {
    const agents = [{ id: 'durable_rm', name: 'rm', color: 'indigo', branch: 'rm/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('agents.json')) return true;
      if (s.endsWith('.git')) return true;
      if (s === '/test/wt') return true; // worktree still exists
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(agents));
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(execSync).mockReturnValue('');

    deleteDurable(PROJECT_PATH, 'durable_rm');
    expect(vi.mocked(fs.rmSync)).toHaveBeenCalledWith('/test/wt', { recursive: true, force: true });
  });

  it('no-op for unknown agentId', () => {
    const agents = [{ id: 'durable_exists', name: 'exists', color: 'indigo', branch: 'exists/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(agents));
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

    expect(() => deleteDurable(PROJECT_PATH, 'nonexistent')).not.toThrow();
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
  });

  it('handles non-worktree agent (just unregisters)', () => {
    const agents = [{ id: 'durable_nowt', name: 'nowt', color: 'indigo', createdAt: '2024-01-01' }];
    let writtenAgents = '';
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(agents));
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenAgents = String(data); });

    deleteDurable(PROJECT_PATH, 'durable_nowt');
    const result = JSON.parse(writtenAgents);
    expect(result.length).toBe(0);
    // No git commands for non-worktree agents
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
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
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(agents));
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenAgents = String(data); });
  });

  it('reorders by orderedIds', () => {
    reorderDurable(PROJECT_PATH, ['durable_c', 'durable_a', 'durable_b']);
    const result = JSON.parse(writtenAgents);
    expect(result.map((a: any) => a.id)).toEqual(['durable_c', 'durable_a', 'durable_b']);
  });

  it('appends agents not in orderedIds', () => {
    reorderDurable(PROJECT_PATH, ['durable_b']);
    const result = JSON.parse(writtenAgents);
    expect(result.map((a: any) => a.id)).toEqual(['durable_b', 'durable_a', 'durable_c']);
  });

  it('ignores unknown ids in orderedIds', () => {
    reorderDurable(PROJECT_PATH, ['nonexistent', 'durable_c', 'durable_a']);
    const result = JSON.parse(writtenAgents);
    expect(result.map((a: any) => a.id)).toEqual(['durable_c', 'durable_a', 'durable_b']);
  });

  it('returns the reordered array', () => {
    const result = reorderDurable(PROJECT_PATH, ['durable_b', 'durable_c', 'durable_a']);
    expect(result.map((a) => a.id)).toEqual(['durable_b', 'durable_c', 'durable_a']);
  });
});

describe('renameDurable', () => {
  it('updates name in config', () => {
    const agents = [{ id: 'durable_ren', name: 'old-name', color: 'indigo', branch: 'old-name/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    let writtenAgents = '';
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(agents));
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenAgents = String(data); });

    renameDurable(PROJECT_PATH, 'durable_ren', 'new-name');
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
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(agents));
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenAgents = String(data); });
  });

  it('updates name only', () => {
    updateDurable(PROJECT_PATH, 'durable_upd', { name: 'new-name' });
    const result = JSON.parse(writtenAgents);
    expect(result[0].name).toBe('new-name');
    expect(result[0].color).toBe('indigo');
    expect(result[0].icon).toBe('durable_upd.png');
  });

  it('updates color only', () => {
    updateDurable(PROJECT_PATH, 'durable_upd', { color: 'emerald' });
    const result = JSON.parse(writtenAgents);
    expect(result[0].color).toBe('emerald');
    expect(result[0].name).toBe('old-name');
  });

  it('sets icon', () => {
    updateDurable(PROJECT_PATH, 'durable_upd', { icon: 'durable_upd_new.png' });
    const result = JSON.parse(writtenAgents);
    expect(result[0].icon).toBe('durable_upd_new.png');
  });

  it('clears icon when null', () => {
    updateDurable(PROJECT_PATH, 'durable_upd', { icon: null });
    const result = JSON.parse(writtenAgents);
    expect(result[0]).not.toHaveProperty('icon');
  });

  it('clears icon when empty string', () => {
    updateDurable(PROJECT_PATH, 'durable_upd', { icon: '' });
    const result = JSON.parse(writtenAgents);
    expect(result[0]).not.toHaveProperty('icon');
  });

  it('no-op for unknown agentId', () => {
    updateDurable(PROJECT_PATH, 'nonexistent', { name: 'foo' });
    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const agentWrites = writeCalls.filter((c) => String(c[0]).endsWith('agents.json'));
    if (agentWrites.length > 0) {
      const lastWritten = JSON.parse(String(agentWrites[agentWrites.length - 1][1]));
      expect(lastWritten[0].name).toBe('old-name'); // not 'foo'
    }
  });
});

describe('getWorktreeStatus', () => {
  it('invalid agent returns isValid:false', () => {
    mockNoAgentsFile();
    const status = getWorktreeStatus(PROJECT_PATH, 'nonexistent');
    expect(status.isValid).toBe(false);
  });

  it('missing .git returns isValid:false', () => {
    const agents = [{ id: 'durable_nogit', name: 'nogit', color: 'indigo', branch: 'nogit/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('agents.json')) return true;
      if (s === '/test/wt') return true;
      if (s === path.join('/test/wt', '.git')) return false;
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(agents));

    const status = getWorktreeStatus(PROJECT_PATH, 'durable_nogit');
    expect(status.isValid).toBe(false);
  });

  it('non-worktree agent returns isValid:false', () => {
    const agents = [{ id: 'durable_nowt', name: 'nowt', color: 'indigo', createdAt: '2024-01-01' }];
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(agents));

    const status = getWorktreeStatus(PROJECT_PATH, 'durable_nowt');
    expect(status.isValid).toBe(false);
  });
});

describe('deleteCommitAndPush', () => {
  it('stages, commits, pushes, deletes', () => {
    const agents = [{ id: 'durable_dcp', name: 'dcp', color: 'indigo', branch: 'dcp/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('agents.json')) return true;
      if (s.endsWith('.git')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(agents));
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (String(cmd).includes('git remote')) return 'origin\n';
      return '';
    });

    const result = deleteCommitAndPush(PROJECT_PATH, 'durable_dcp');
    expect(result.ok).toBe(true);
    const calls = vi.mocked(execSync).mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes('git add -A'))).toBe(true);
    expect(calls.some((c) => c.includes('git commit'))).toBe(true);
    expect(calls.some((c) => c.includes('git push'))).toBe(true);
  });

  it('agent not found returns ok:false', () => {
    mockNoAgentsFile();
    const result = deleteCommitAndPush(PROJECT_PATH, 'nonexistent');
    expect(result.ok).toBe(false);
  });
});

describe('deleteUnregister', () => {
  it('removes from config, leaves files', () => {
    const agents = [
      { id: 'durable_unreg', name: 'unreg', color: 'indigo', branch: 'unreg/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' },
    ];
    let writtenAgents = '';
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(agents));
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenAgents = String(data); });

    const result = deleteUnregister(PROJECT_PATH, 'durable_unreg');
    expect(result.ok).toBe(true);
    const remaining = JSON.parse(writtenAgents);
    expect(remaining.length).toBe(0);
    // No rmSync or git commands
    expect(vi.mocked(fs.rmSync)).not.toHaveBeenCalled();
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
  });
});

describe('deleteForce', () => {
  it('delegates to deleteDurable', () => {
    const agents = [{ id: 'durable_force', name: 'force', color: 'indigo', branch: 'force/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('agents.json')) return true;
      if (s.endsWith('.git')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(agents));
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(execSync).mockReturnValue('');

    const result = deleteForce(PROJECT_PATH, 'durable_force');
    expect(result.ok).toBe(true);
  });
});

describe('getDurableConfig', () => {
  it('returns correct agent by id', () => {
    const agents = [
      { id: 'durable_1', name: 'agent-one', color: 'indigo', branch: 'one/standby', worktreePath: '/test/wt1', createdAt: '2024-01-01' },
      { id: 'durable_2', name: 'agent-two', color: 'emerald', branch: 'two/standby', worktreePath: '/test/wt2', createdAt: '2024-01-01' },
    ];
    mockAgentsFile(agents);
    const result = getDurableConfig(PROJECT_PATH, 'durable_2');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('agent-two');
  });

  it('returns null for unknown agent', () => {
    const agents = [
      { id: 'durable_1', name: 'agent-one', color: 'indigo', branch: 'one/standby', worktreePath: '/test/wt1', createdAt: '2024-01-01' },
    ];
    mockAgentsFile(agents);
    const result = getDurableConfig(PROJECT_PATH, 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns null when no agents file', () => {
    mockNoAgentsFile();
    const result = getDurableConfig(PROJECT_PATH, 'durable_1');
    expect(result).toBeNull();
  });
});

describe('updateDurableConfig', () => {
  it('persists quickAgentDefaults and round-trips', () => {
    const agents = [
      { id: 'durable_upd', name: 'upd', color: 'indigo', branch: 'upd/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' },
    ];
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(agents);

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });

    const defaults = { systemPrompt: 'Be concise', allowedTools: ['Bash(npm test:*)'], defaultModel: 'sonnet' };
    updateDurableConfig(PROJECT_PATH, 'durable_upd', { quickAgentDefaults: defaults });

    // Read back
    const result = getDurableConfig(PROJECT_PATH, 'durable_upd');
    expect(result).not.toBeNull();
    expect(result!.quickAgentDefaults).toEqual(defaults);
  });

  it('no-op for unknown agent', () => {
    const agents = [
      { id: 'durable_1', name: 'one', color: 'indigo', branch: 'one/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' },
    ];
    mockAgentsFile(agents);
    // Should not throw
    expect(() => updateDurableConfig(PROJECT_PATH, 'nonexistent', { quickAgentDefaults: { systemPrompt: 'x' } })).not.toThrow();
  });

  it('persists model field and round-trips', () => {
    const agents = [
      { id: 'durable_model', name: 'model-agent', color: 'indigo', createdAt: '2024-01-01' },
    ];
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(agents);

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });

    updateDurableConfig(PROJECT_PATH, 'durable_model', { model: 'sonnet' });

    const result = getDurableConfig(PROJECT_PATH, 'durable_model');
    expect(result).not.toBeNull();
    expect(result!.model).toBe('sonnet');
  });

  it('removes model field when set to "default"', () => {
    const agents = [
      { id: 'durable_defmodel', name: 'def-model', color: 'indigo', model: 'opus', createdAt: '2024-01-01' },
    ];
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(agents);

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });

    updateDurableConfig(PROJECT_PATH, 'durable_defmodel', { model: 'default' });

    const result = getDurableConfig(PROJECT_PATH, 'durable_defmodel');
    expect(result).not.toBeNull();
    expect(result!.model).toBeUndefined();
  });

  it('persists freeAgentMode when set to true', () => {
    const agents = [
      { id: 'durable_fam', name: 'fam-agent', color: 'indigo', createdAt: '2024-01-01' },
    ];
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(agents);

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });

    updateDurableConfig(PROJECT_PATH, 'durable_fam', { freeAgentMode: true });

    const result = getDurableConfig(PROJECT_PATH, 'durable_fam');
    expect(result).not.toBeNull();
    expect(result!.freeAgentMode).toBe(true);
  });

  it('removes freeAgentMode field when set to false', () => {
    const agents = [
      { id: 'durable_fam_off', name: 'fam-off', color: 'indigo', freeAgentMode: true, createdAt: '2024-01-01' },
    ];
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(agents);

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });

    updateDurableConfig(PROJECT_PATH, 'durable_fam_off', { freeAgentMode: false });

    const result = getDurableConfig(PROJECT_PATH, 'durable_fam_off');
    expect(result).not.toBeNull();
    expect(result!.freeAgentMode).toBeUndefined();
  });
});

describe('ensureGitignore edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default async exec mock for createDurable
    vi.mocked(exec).mockImplementation((_cmd: any, _opts: any, cb: any) => {
      cb(null, '', '');
      return {} as any;
    });
  });

  it('appends selective patterns when .gitignore exists without clubhouse patterns', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('.gitignore')) return true;
      if (s.endsWith('.git')) return true;
      if (s.endsWith('agents.json')) return false;
      if (s.endsWith('settings.json')) return false;
      if (s.endsWith('README.md')) return false;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('.gitignore')) return 'node_modules/\n';
      return '[]';
    });

    await createDurable(PROJECT_PATH, 'append-test', 'indigo');
    expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalled();
    const appendCall = vi.mocked(fs.appendFileSync).mock.calls[0];
    expect(String(appendCall[1])).toContain('.clubhouse/agents/');
    expect(String(appendCall[1])).toContain('.clubhouse/agents.json');
  });

  it('creates .gitignore when none exists', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('.gitignore')) return false;
      if (s.endsWith('.git')) return true;
      if (s.endsWith('agents.json')) return false;
      if (s.endsWith('settings.json')) return false;
      if (s.endsWith('README.md')) return false;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('.gitignore')) throw new Error('not found');
      return '[]';
    });

    await createDurable(PROJECT_PATH, 'create-gitignore-test', 'indigo');
    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const gitignoreWrite = writeCalls.find((c) => String(c[0]).endsWith('.gitignore'));
    expect(gitignoreWrite).toBeDefined();
    expect(String(gitignoreWrite![1])).toContain('.clubhouse/agents/');
  });
});

describe('saveAgentIcon', () => {
  const AGENT_ID = 'test-agent-123';

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('agents.json'))
        return JSON.stringify([{ id: AGENT_ID, name: 'Test Agent' }]);
      return '';
    });
  });

  it('strips standard png data URL prefix', () => {
    const base64Content = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB';
    const dataUrl = `data:image/png;base64,${base64Content}`;

    saveAgentIcon(PROJECT_PATH, AGENT_ID, dataUrl);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const iconWrite = writeCalls.find((c) => String(c[0]).endsWith(`${AGENT_ID}.png`));
    expect(iconWrite).toBeDefined();
    // The written buffer should be the decoded base64, not still contain the prefix
    expect(Buffer.isBuffer(iconWrite![1])).toBe(true);
    expect(iconWrite![1]).toEqual(Buffer.from(base64Content, 'base64'));
  });

  it('strips svg+xml data URL prefix (issue #190)', () => {
    const base64Content = 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==';
    const dataUrl = `data:image/svg+xml;base64,${base64Content}`;

    saveAgentIcon(PROJECT_PATH, AGENT_ID, dataUrl);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const iconWrite = writeCalls.find((c) => String(c[0]).endsWith(`${AGENT_ID}.png`));
    expect(iconWrite).toBeDefined();
    expect(iconWrite![1]).toEqual(Buffer.from(base64Content, 'base64'));
  });

  it('strips jpeg data URL prefix', () => {
    const base64Content = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQ==';
    const dataUrl = `data:image/jpeg;base64,${base64Content}`;

    saveAgentIcon(PROJECT_PATH, AGENT_ID, dataUrl);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const iconWrite = writeCalls.find((c) => String(c[0]).endsWith(`${AGENT_ID}.png`));
    expect(iconWrite).toBeDefined();
    expect(iconWrite![1]).toEqual(Buffer.from(base64Content, 'base64'));
  });

  it('strips webp data URL prefix', () => {
    const base64Content = 'UklGRlYAAABXRUJQVlA4IEoAAADQAQCdASoBAAEAAkA=';
    const dataUrl = `data:image/webp;base64,${base64Content}`;

    saveAgentIcon(PROJECT_PATH, AGENT_ID, dataUrl);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const iconWrite = writeCalls.find((c) => String(c[0]).endsWith(`${AGENT_ID}.png`));
    expect(iconWrite).toBeDefined();
    expect(iconWrite![1]).toEqual(Buffer.from(base64Content, 'base64'));
  });

  it('updates agent icon field in agents.json', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';

    saveAgentIcon(PROJECT_PATH, AGENT_ID, dataUrl);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const agentsWrite = writeCalls.find((c) => String(c[0]).endsWith('agents.json'));
    expect(agentsWrite).toBeDefined();
    const agents = JSON.parse(String(agentsWrite![1]));
    expect(agents[0].icon).toBe(`${AGENT_ID}.png`);
  });
});
