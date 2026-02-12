import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
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
import { execSync } from 'child_process';
import {
  listDurable,
  createDurable,
  renameDurable,
  deleteDurable,
  getSettings,
  saveSettings,
  getWorktreeStatus,
  deleteCommitAndPush,
  deleteUnregister,
  deleteForce,
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
    const agents = [{ id: 'durable_1', name: 'test-agent', color: 'indigo', localOnly: false, branch: 'test/standby', worktreePath: '/test', createdAt: '2024-01-01' }];
    mockAgentsFile(agents);
    expect(listDurable(PROJECT_PATH)).toEqual(agents);
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
    vi.mocked(execSync).mockReturnValue('');
  });

  it('generates durable_ prefixed ID', () => {
    const config = createDurable(PROJECT_PATH, 'my-agent', 'indigo', false);
    expect(config.id).toMatch(/^durable_/);
  });

  it('branch = {name}/standby', () => {
    const config = createDurable(PROJECT_PATH, 'my-agent', 'indigo', false);
    expect(config.branch).toBe('my-agent/standby');
  });

  it('worktree path uses agents/ when not localOnly', () => {
    const config = createDurable(PROJECT_PATH, 'my-agent', 'indigo', false);
    expect(config.worktreePath).toContain(path.join('agents', 'my-agent'));
  });

  it('worktree path uses .local/ when localOnly', () => {
    const config = createDurable(PROJECT_PATH, 'my-agent', 'indigo', true);
    expect(config.worktreePath).toContain(path.join('.local', 'my-agent'));
  });

  it('calls git branch + git worktree add when .git exists', () => {
    createDurable(PROJECT_PATH, 'my-agent', 'indigo', false);
    const calls = vi.mocked(execSync).mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes('git branch'))).toBe(true);
    expect(calls.some((c) => c.includes('git worktree add'))).toBe(true);
  });

  it('falls back to mkdir when no git', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('.git')) return false;
      if (s.endsWith('.gitignore')) return false;
      if (s.endsWith('agents.json')) return false;
      if (s.endsWith('CLAUDE.md')) return false;
      if (s.endsWith('settings.json')) return false;
      return false;
    });
    const config = createDurable(PROJECT_PATH, 'no-git-agent', 'indigo', false);
    expect(config.id).toMatch(/^durable_/);
    // git commands should not have been called
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
    // mkdirSync should have been called for the worktree path
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalled();
  });

  it('falls back to mkdir when worktree add fails', () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (String(cmd).includes('git worktree add')) throw new Error('worktree fail');
      return '';
    });
    const config = createDurable(PROJECT_PATH, 'wt-fail-agent', 'indigo', false);
    expect(config.id).toMatch(/^durable_/);
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalled();
  });

  it('appends to existing config, does not overwrite', () => {
    const existing = [{ id: 'durable_old', name: 'old', color: 'amber', localOnly: false, branch: 'old/standby', worktreePath: '/old', createdAt: '2024-01-01' }];
    const writtenData: Record<string, string> = {};
    const agentsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'agents.json');
    writtenData[agentsJsonPath] = JSON.stringify(existing);
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('.git')) return true;
      if (s.endsWith('.gitignore')) return false;
      if (s.endsWith('agents.json')) return true;
      if (s.endsWith('CLAUDE.md')) return false;
      if (s.endsWith('settings.json')) return false;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      return writtenData[String(p)] || '[]';
    });
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => {
      writtenData[String(p)] = String(data);
    });

    createDurable(PROJECT_PATH, 'new-agent', 'emerald', false);
    const written = JSON.parse(writtenData[agentsJsonPath]);
    expect(written.length).toBe(2);
    expect(written[0].id).toBe('durable_old');
    expect(written[1].id).toMatch(/^durable_/);
  });

  it('copies defaultClaudeMd from settings', () => {
    const settingsJsonPath = path.join(PROJECT_PATH, '.clubhouse', 'settings.json');
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s === settingsJsonPath) return true;
      if (s.endsWith('.git')) return true;
      if (s.endsWith('.gitignore')) return false;
      if (s.endsWith('agents.json')) return false;
      if (s.endsWith('CLAUDE.md')) return false;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p) === settingsJsonPath) return JSON.stringify({ defaultClaudeMd: '# My Rules', quickAgentClaudeMd: '' });
      return '[]';
    });

    createDurable(PROJECT_PATH, 'claude-md-agent', 'indigo', false);
    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const claudeMdWrite = writeCalls.find((c) => String(c[0]).endsWith('CLAUDE.md'));
    expect(claudeMdWrite).toBeDefined();
    expect(claudeMdWrite![1]).toBe('# My Rules');
  });

  it('omits model field when "default"', () => {
    const config = createDurable(PROJECT_PATH, 'default-model', 'indigo', false, 'default');
    expect(config).not.toHaveProperty('model');
  });

  it('includes model field when not "default"', () => {
    const config = createDurable(PROJECT_PATH, 'custom-model', 'indigo', false, 'claude-sonnet-4-5-20250929');
    expect(config.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('ensureGitignore adds .clubhouse/ once', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith('.gitignore')) return true;
      if (s.endsWith('.git')) return true;
      if (s.endsWith('agents.json')) return false;
      if (s.endsWith('CLAUDE.md')) return false;
      if (s.endsWith('settings.json')) return false;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('.gitignore')) return 'node_modules/\n.clubhouse/\n';
      return '[]';
    });

    createDurable(PROJECT_PATH, 'gitignore-test', 'indigo', false);
    // Should NOT append because .clubhouse/ already exists
    expect(vi.mocked(fs.appendFileSync)).not.toHaveBeenCalled();
  });
});

describe('deleteDurable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes agent from config file', () => {
    const agents = [
      { id: 'durable_del', name: 'del', color: 'indigo', localOnly: false, branch: 'del/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' },
      { id: 'durable_keep', name: 'keep', color: 'amber', localOnly: false, branch: 'keep/standby', worktreePath: '/test/wt2', createdAt: '2024-01-01' },
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
    const agents = [{ id: 'durable_git', name: 'git', color: 'indigo', localOnly: false, branch: 'git/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
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
    const agents = [{ id: 'durable_fail', name: 'fail', color: 'indigo', localOnly: false, branch: 'fail/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
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
    const agents = [{ id: 'durable_rm', name: 'rm', color: 'indigo', localOnly: false, branch: 'rm/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
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
    const agents = [{ id: 'durable_exists', name: 'exists', color: 'indigo', localOnly: false, branch: 'exists/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (String(p).endsWith('agents.json')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(agents));
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);

    expect(() => deleteDurable(PROJECT_PATH, 'nonexistent')).not.toThrow();
    expect(vi.mocked(execSync)).not.toHaveBeenCalled();
  });
});

describe('renameDurable', () => {
  it('updates name in config', () => {
    const agents = [{ id: 'durable_ren', name: 'old-name', color: 'indigo', localOnly: false, branch: 'old-name/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
    let writtenAgents = '';
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(agents));
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { writtenAgents = String(data); });

    renameDurable(PROJECT_PATH, 'durable_ren', 'new-name');
    const result = JSON.parse(writtenAgents);
    expect(result[0].name).toBe('new-name');
  });
});

describe('getWorktreeStatus', () => {
  it('invalid agent returns isValid:false', () => {
    mockNoAgentsFile();
    const status = getWorktreeStatus(PROJECT_PATH, 'nonexistent');
    expect(status.isValid).toBe(false);
  });

  it('missing .git returns isValid:false', () => {
    const agents = [{ id: 'durable_nogit', name: 'nogit', color: 'indigo', localOnly: false, branch: 'nogit/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
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
});

describe('deleteCommitAndPush', () => {
  it('stages, commits, pushes, deletes', () => {
    const agents = [{ id: 'durable_dcp', name: 'dcp', color: 'indigo', localOnly: false, branch: 'dcp/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
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
      { id: 'durable_unreg', name: 'unreg', color: 'indigo', localOnly: false, branch: 'unreg/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' },
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
    const agents = [{ id: 'durable_force', name: 'force', color: 'indigo', localOnly: false, branch: 'force/standby', worktreePath: '/test/wt', createdAt: '2024-01-01' }];
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

describe('getSettings / saveSettings', () => {
  it('roundtrip persistence', () => {
    const written: Record<string, string> = {};
    vi.mocked(fs.existsSync).mockImplementation((p: any) => !!written[String(p)]);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => written[String(p)] || '');
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, data: any) => { written[String(p)] = String(data); });

    const settings = { defaultClaudeMd: '# Custom', quickAgentClaudeMd: '# Quick' };
    saveSettings(PROJECT_PATH, settings);
    // Now mark the file as existing
    const settingsKey = path.join(PROJECT_PATH, '.clubhouse', 'settings.json');
    vi.mocked(fs.existsSync).mockImplementation((p: any) => String(p) === settingsKey);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => written[String(p)] || '');

    const loaded = getSettings(PROJECT_PATH);
    expect(loaded).toEqual(settings);
  });

  it('returns defaults when no file exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const settings = getSettings(PROJECT_PATH);
    expect(settings).toEqual({ defaultClaudeMd: '', quickAgentClaudeMd: '' });
  });
});
