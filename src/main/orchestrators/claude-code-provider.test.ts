import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => { throw new Error('not found'); }),
}));

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: '/usr/local/bin:/usr/bin' })),
}));

import * as fs from 'fs';
import { ClaudeCodeProvider } from './claude-code-provider';

describe('ClaudeCodeProvider', () => {
  let provider: ClaudeCodeProvider;

  beforeEach(() => {
    provider = new ClaudeCodeProvider();
    vi.clearAllMocks();
    // Default: binary found at standard path
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('/claude'));
  });

  describe('identity', () => {
    it('has correct id and displayName', () => {
      expect(provider.id).toBe('claude-code');
      expect(provider.displayName).toBe('Claude Code');
    });

    it('has no badge', () => {
      expect(provider.badge).toBeUndefined();
    });
  });

  describe('conventions', () => {
    it('uses .claude config dir', () => {
      expect(provider.conventions.configDir).toBe('.claude');
    });

    it('uses CLAUDE.local.md for local instructions', () => {
      expect(provider.conventions.localInstructionsFile).toBe('CLAUDE.local.md');
    });

    it('uses CLAUDE.md as legacy instructions', () => {
      expect(provider.conventions.legacyInstructionsFile).toBe('CLAUDE.md');
    });
  });

  describe('checkAvailability', () => {
    it('returns available when binary exists', async () => {
      const result = await provider.checkAvailability();
      expect(result.available).toBe(true);
    });

    it('returns error when binary not found', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await provider.checkAvailability();
      expect(result.available).toBe(false);
      expect(result.error).toMatch(/Could not find/);
    });
  });

  describe('buildSpawnCommand', () => {
    it('returns binary path and empty args by default', async () => {
      const { binary, args } = await provider.buildSpawnCommand({ cwd: '/project' });
      expect(binary).toContain('claude');
      expect(args).toEqual([]);
    });

    it('adds --model flag for non-default model', async () => {
      const { args } = await provider.buildSpawnCommand({ cwd: '/p', model: 'opus' });
      expect(args).toContain('--model');
      expect(args).toContain('opus');
    });

    it('skips --model for default', async () => {
      const { args } = await provider.buildSpawnCommand({ cwd: '/p', model: 'default' });
      expect(args).not.toContain('--model');
    });

    it('adds --allowedTools for each tool', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        allowedTools: ['Read', 'Write'],
      });
      const toolIndices = args.reduce<number[]>((acc, v, i) => {
        if (v === '--allowedTools') acc.push(i);
        return acc;
      }, []);
      expect(toolIndices).toHaveLength(2);
      expect(args[toolIndices[0] + 1]).toBe('Read');
      expect(args[toolIndices[1] + 1]).toBe('Write');
    });

    it('adds --append-system-prompt', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        systemPrompt: 'Be concise',
      });
      expect(args).toContain('--append-system-prompt');
      expect(args).toContain('Be concise');
    });

    it('appends mission as last argument', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        mission: 'Fix the bug',
      });
      expect(args[args.length - 1]).toBe('Fix the bug');
    });

    it('combines all options correctly', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        model: 'sonnet',
        systemPrompt: 'Be careful',
        allowedTools: ['Bash(git:*)'],
        mission: 'Deploy it',
      });
      expect(args).toContain('--model');
      expect(args).toContain('sonnet');
      expect(args).toContain('--append-system-prompt');
      expect(args).toContain('Be careful');
      expect(args).toContain('--allowedTools');
      expect(args).toContain('Bash(git:*)');
      expect(args[args.length - 1]).toBe('Deploy it');
    });
  });

  describe('getExitCommand', () => {
    it('returns /exit with carriage return', () => {
      expect(provider.getExitCommand()).toBe('/exit\r');
    });
  });

  describe('parseHookEvent', () => {
    it('parses PreToolUse as pre_tool', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });
      expect(result).toEqual({
        kind: 'pre_tool',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        message: undefined,
      });
    });

    it('parses PostToolUse as post_tool', () => {
      const result = provider.parseHookEvent({ hook_event_name: 'PostToolUse', tool_name: 'Read' });
      expect(result?.kind).toBe('post_tool');
    });

    it('parses PostToolUseFailure as tool_error', () => {
      const result = provider.parseHookEvent({ hook_event_name: 'PostToolUseFailure' });
      expect(result?.kind).toBe('tool_error');
    });

    it('parses Stop as stop', () => {
      const result = provider.parseHookEvent({ hook_event_name: 'Stop', message: 'Done' });
      expect(result?.kind).toBe('stop');
      expect(result?.message).toBe('Done');
    });

    it('parses Notification as notification', () => {
      const result = provider.parseHookEvent({ hook_event_name: 'Notification', message: 'Hello' });
      expect(result?.kind).toBe('notification');
    });

    it('parses PermissionRequest as permission_request', () => {
      const result = provider.parseHookEvent({ hook_event_name: 'PermissionRequest' });
      expect(result?.kind).toBe('permission_request');
    });

    it('returns null for unknown event names', () => {
      expect(provider.parseHookEvent({ hook_event_name: 'SomethingElse' })).toBeNull();
    });

    it('returns null for null input', () => {
      expect(provider.parseHookEvent(null)).toBeNull();
    });

    it('returns null for non-object input', () => {
      expect(provider.parseHookEvent('string')).toBeNull();
    });

    it('returns null for missing hook_event_name', () => {
      expect(provider.parseHookEvent({ tool_name: 'Read' })).toBeNull();
    });
  });

  describe('toolVerb', () => {
    it('returns verb for known tools', () => {
      expect(provider.toolVerb('Bash')).toBe('Running command');
      expect(provider.toolVerb('Edit')).toBe('Editing file');
      expect(provider.toolVerb('Read')).toBe('Reading file');
      expect(provider.toolVerb('WebSearch')).toBe('Searching web');
    });

    it('returns undefined for unknown tools', () => {
      expect(provider.toolVerb('UnknownTool')).toBeUndefined();
    });
  });

  describe('getModelOptions', () => {
    it('returns list including default, opus, sonnet, haiku', () => {
      const options = provider.getModelOptions();
      expect(options.length).toBeGreaterThanOrEqual(4);
      expect(options[0]).toEqual({ id: 'default', label: 'Default' });
      const ids = options.map(o => o.id);
      expect(ids).toContain('opus');
      expect(ids).toContain('sonnet');
      expect(ids).toContain('haiku');
    });
  });

  describe('getDefaultPermissions', () => {
    it('returns durable permissions with git/npm/npx', () => {
      const perms = provider.getDefaultPermissions('durable');
      expect(perms).toContain('Bash(git:*)');
      expect(perms).toContain('Bash(npm:*)');
      expect(perms).not.toContain('Read');
    });

    it('returns quick permissions with file tools', () => {
      const perms = provider.getDefaultPermissions('quick');
      expect(perms).toContain('Read');
      expect(perms).toContain('Write');
      expect(perms).toContain('Edit');
      expect(perms).toContain('Glob');
      expect(perms).toContain('Grep');
    });

    it('returns a new array each call (no shared reference)', () => {
      const a = provider.getDefaultPermissions('durable');
      const b = provider.getDefaultPermissions('durable');
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe('writeHooksConfig', () => {
    it('creates .claude dir and writes settings.local.json', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (String(p).endsWith('/claude')) return true;
        return false;
      });

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook/agent-1');

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        path.join('/project', '.claude'),
        { recursive: true }
      );
      expect(fs.writeFileSync).toHaveBeenCalled();
      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.hooks).toBeDefined();
      expect(written.hooks.PreToolUse).toBeDefined();
      expect(written.hooks.Stop).toBeDefined();
    });

    it('merges with existing settings', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ existingKey: 'value' }));

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook/agent-1');

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.existingKey).toBe('value');
      expect(written.hooks).toBeDefined();
    });
  });

  describe('readInstructions', () => {
    it('reads from .claude/CLAUDE.local.md', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('local instructions');
      const result = provider.readInstructions('/project');
      expect(result).toBe('local instructions');
    });

    it('falls back to CLAUDE.md', () => {
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).includes('CLAUDE.local.md')) throw new Error('ENOENT');
        return 'legacy instructions';
      });
      const result = provider.readInstructions('/project');
      expect(result).toBe('legacy instructions');
    });

    it('returns empty string when neither file exists', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = provider.readInstructions('/project');
      expect(result).toBe('');
    });
  });

  describe('writeInstructions', () => {
    it('creates .claude dir and writes CLAUDE.local.md', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (String(p).endsWith('/claude')) return true;
        return false;
      });

      provider.writeInstructions('/project', 'new instructions');

      expect(fs.mkdirSync).toHaveBeenCalledWith(path.join('/project', '.claude'), { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.join('/project', '.claude', 'CLAUDE.local.md'),
        'new instructions',
        'utf-8'
      );
    });
  });
});
