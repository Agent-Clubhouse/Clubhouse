import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
  copyFileSync: vi.fn(),
}));

import * as fs from 'fs';
import {
  materializeClaudeMd,
  materializePermissions,
  materializeMcpConfig,
  materializeAll,
  repairMissing,
} from './config-materializer';
import { defaultOverrideFlags } from './config-resolver';

const WORKTREE = '/test/worktree';
const PROJECT = '/test/project';

describe('materializeClaudeMd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes CLAUDE.md when content is a string', () => {
    materializeClaudeMd(WORKTREE, '# Hello');
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      path.join(WORKTREE, 'CLAUDE.md'),
      '# Hello',
      'utf-8',
    );
  });

  it('deletes CLAUDE.md when content is null', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    materializeClaudeMd(WORKTREE, null);
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith(path.join(WORKTREE, 'CLAUDE.md'));
  });

  it('does nothing when content is null and file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    materializeClaudeMd(WORKTREE, null);
    expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalled();
  });

  it('does nothing when content is undefined', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    materializeClaudeMd(WORKTREE, undefined);
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalled();
  });
});

describe('materializePermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes permissions to settings.local.json', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{}');
    materializePermissions(WORKTREE, { allow: ['Bash(*)'] });

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(String(writeCall[0])).toContain('settings.local.json');
    const written = JSON.parse(String(writeCall[1]));
    expect(written.permissions).toEqual({ allow: ['Bash(*)'] });
  });

  it('preserves existing hooks key', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      hooks: { PreToolUse: [] },
    }));
    materializePermissions(WORKTREE, { deny: ['rm'] });

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    const written = JSON.parse(String(writeCall[1]));
    expect(written.hooks).toEqual({ PreToolUse: [] });
    expect(written.permissions).toEqual({ deny: ['rm'] });
  });

  it('removes permissions key when null', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      hooks: { PreToolUse: [] },
      permissions: { allow: ['*'] },
    }));
    materializePermissions(WORKTREE, null);

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    const written = JSON.parse(String(writeCall[1]));
    expect(written.permissions).toBeUndefined();
    expect(written.hooks).toEqual({ PreToolUse: [] });
  });

  it('creates .claude directory if missing', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('not found'); });
    materializePermissions(WORKTREE, { allow: ['*'] });
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude'),
      { recursive: true },
    );
  });
});

describe('materializeMcpConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes .mcp.json', () => {
    const config = { mcpServers: { test: { command: 'test-cmd' } } };
    materializeMcpConfig(WORKTREE, config);
    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(String(writeCall[0])).toContain('.mcp.json');
    const written = JSON.parse(String(writeCall[1]));
    expect(written.mcpServers.test.command).toBe('test-cmd');
  });

  it('deletes .mcp.json when null', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    materializeMcpConfig(WORKTREE, null);
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith(path.join(WORKTREE, '.mcp.json'));
  });

  it('no-op when null and file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    materializeMcpConfig(WORKTREE, null);
    expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalled();
  });
});

describe('materializeAll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('not found'); });
  });

  it('writes claudeMd when not overridden', () => {
    const overrides = defaultOverrideFlags();
    const resolved = { claudeMd: '# Test' };
    materializeAll(WORKTREE, resolved, overrides, PROJECT);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const claudeMdWrite = writeCalls.find((c) => String(c[0]).endsWith('CLAUDE.md'));
    expect(claudeMdWrite).toBeDefined();
    expect(claudeMdWrite![1]).toBe('# Test');
  });

  it('skips claudeMd when overridden', () => {
    const overrides = { ...defaultOverrideFlags(), claudeMd: true };
    const resolved = { claudeMd: '# Test' };
    materializeAll(WORKTREE, resolved, overrides, PROJECT);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const claudeMdWrite = writeCalls.find((c) => String(c[0]).endsWith('CLAUDE.md'));
    expect(claudeMdWrite).toBeUndefined();
  });

  it('writes permissions when not overridden', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (String(p).endsWith('.claude')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('settings.local.json')) return '{}';
      throw new Error('not found');
    });

    const overrides = defaultOverrideFlags();
    const resolved = { permissions: { allow: ['Bash(*)'] } };
    materializeAll(WORKTREE, resolved, overrides, PROJECT);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const settingsWrite = writeCalls.find((c) => String(c[0]).endsWith('settings.local.json'));
    expect(settingsWrite).toBeDefined();
    const written = JSON.parse(String(settingsWrite![1]));
    expect(written.permissions).toEqual({ allow: ['Bash(*)'] });
  });

  it('skips permissions when overridden', () => {
    const overrides = { ...defaultOverrideFlags(), permissions: true };
    const resolved = { permissions: { allow: ['Bash(*)'] } };
    materializeAll(WORKTREE, resolved, overrides, PROJECT);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const settingsWrite = writeCalls.find((c) => String(c[0]).endsWith('settings.local.json'));
    expect(settingsWrite).toBeUndefined();
  });
});

describe('repairMissing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-materializes CLAUDE.md when missing', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (String(p).endsWith('CLAUDE.md')) return false;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('not found'); });

    const overrides = defaultOverrideFlags();
    const resolved = { claudeMd: '# Repaired' };
    repairMissing(WORKTREE, resolved, overrides, PROJECT);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const claudeMdWrite = writeCalls.find((c) => String(c[0]).endsWith('CLAUDE.md'));
    expect(claudeMdWrite).toBeDefined();
    expect(claudeMdWrite![1]).toBe('# Repaired');
  });

  it('does not re-materialize CLAUDE.md when it already exists', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (String(p).endsWith('CLAUDE.md')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('not found'); });

    const overrides = defaultOverrideFlags();
    const resolved = { claudeMd: '# Should not write' };
    repairMissing(WORKTREE, resolved, overrides, PROJECT);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const claudeMdWrite = writeCalls.find((c) => String(c[0]).endsWith('CLAUDE.md'));
    expect(claudeMdWrite).toBeUndefined();
  });

  it('skips repair when override is enabled', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('not found'); });

    const overrides = { ...defaultOverrideFlags(), claudeMd: true };
    const resolved = { claudeMd: '# Should not write' };
    repairMissing(WORKTREE, resolved, overrides, PROJECT);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const claudeMdWrite = writeCalls.find((c) => String(c[0]).endsWith('CLAUDE.md'));
    expect(claudeMdWrite).toBeUndefined();
  });

  it('does not repair null claudeMd', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('not found'); });

    const overrides = defaultOverrideFlags();
    const resolved: Record<string, string | null> = { claudeMd: null };
    repairMissing(WORKTREE, resolved, overrides, PROJECT);

    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    const claudeMdWrite = writeCalls.find((c) => String(c[0]).endsWith('CLAUDE.md'));
    expect(claudeMdWrite).toBeUndefined();
  });
});
