import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => '# OpenCode Instructions'),
  writeFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execSync: vi.fn(() => {
    throw new Error('not found');
  }),
}));

vi.mock('util', () => ({
  promisify: vi.fn((fn: any) => vi.fn(async (...args: any[]) => fn(...args))),
}));

vi.mock('./shared', () => ({
  findBinaryInPath: vi.fn(() => '/usr/local/bin/opencode'),
  homePath: vi.fn((...segments: string[]) => `/home/user/${segments.join('/')}`),
  buildSummaryInstruction: vi.fn(() => 'Summarize'),
  readQuickSummary: vi.fn(async () => null),
}));

import * as fs from 'fs';
import { OpenCodeProvider } from './opencode-provider';
import { findBinaryInPath } from './shared';

describe('OpenCodeProvider', () => {
  let provider: OpenCodeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OpenCodeProvider();
  });

  describe('identity', () => {
    it('has correct id and displayName', () => {
      expect(provider.id).toBe('opencode');
      expect(provider.displayName).toBe('OpenCode');
      expect(provider.shortName).toBe('OC');
      expect(provider.badge).toBe('Beta');
    });
  });

  describe('getCapabilities', () => {
    it('reports headless but no hooks or permissions', () => {
      const caps = provider.getCapabilities();
      expect(caps.headless).toBe(true);
      expect(caps.hooks).toBe(false);
      expect(caps.permissions).toBe(false);
      expect(caps.sessionResume).toBe(true);
      expect(caps.structuredOutput).toBe(false);
    });
  });

  describe('conventions', () => {
    it('uses .opencode directory for config', () => {
      expect(provider.conventions.configDir).toBe('.opencode');
      expect(provider.conventions.localInstructionsFile).toBe('instructions.md');
      expect(provider.conventions.mcpConfigFile).toBe('opencode.json');
    });
  });

  describe('checkAvailability', () => {
    it('returns available when binary found', async () => {
      const result = await provider.checkAvailability();
      expect(result).toEqual({ available: true });
    });

    it('returns unavailable when binary not found', async () => {
      vi.mocked(findBinaryInPath).mockImplementationOnce(() => {
        throw new Error('not found');
      });
      const result = await provider.checkAvailability();
      expect(result.available).toBe(false);
      expect(result.error).toBe('not found');
    });
  });

  describe('buildSpawnCommand', () => {
    it('returns binary and empty args for basic spawn', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project' });
      expect(result.binary).toBe('/usr/local/bin/opencode');
      expect(result.args).toEqual([]);
    });

    it('adds --model for non-default model', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project', model: 'anthropic/claude-opus-4-6' });
      expect(result.args).toContain('--model');
      expect(result.args).toContain('anthropic/claude-opus-4-6');
    });

    it('skips --model for default', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project', model: 'default' });
      expect(result.args).not.toContain('--model');
    });
  });

  describe('getExitCommand', () => {
    it('returns /exit with carriage return', () => {
      expect(provider.getExitCommand()).toBe('/exit\r');
    });
  });

  describe('writeHooksConfig', () => {
    it('is a no-op', async () => {
      await provider.writeHooksConfig('/project', 'http://localhost:3000');
      // Should not throw or write anything
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('parseHookEvent', () => {
    it('parses event with kind field', () => {
      const result = provider.parseHookEvent({
        kind: 'pre_tool',
        tool_name: 'bash',
        tool_input: { command: 'ls' },
      });
      expect(result).toEqual({
        kind: 'pre_tool',
        toolName: 'bash',
        toolInput: { command: 'ls' },
        message: undefined,
      });
    });

    it('returns null when kind is missing', () => {
      const result = provider.parseHookEvent({ tool_name: 'bash' });
      expect(result).toBeNull();
    });

    it('returns null for non-object input', () => {
      expect(provider.parseHookEvent(null)).toBeNull();
      expect(provider.parseHookEvent(42)).toBeNull();
    });
  });

  describe('readInstructions', () => {
    it('reads from .opencode/instructions.md', () => {
      const result = provider.readInstructions('/project');
      expect(fs.readFileSync).toHaveBeenCalledWith(
        '/project/.opencode/instructions.md',
        'utf-8',
      );
      expect(result).toBe('# OpenCode Instructions');
    });

    it('returns empty string when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
        throw new Error('ENOENT');
      });
      const result = provider.readInstructions('/project');
      expect(result).toBe('');
    });
  });

  describe('writeInstructions', () => {
    it('creates .opencode directory if needed', () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(false);
      provider.writeInstructions('/project', 'New content');
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('buildHeadlessCommand', () => {
    it('returns null when no mission provided', async () => {
      const result = await provider.buildHeadlessCommand({ cwd: '/project' });
      expect(result).toBeNull();
    });

    it('builds command with run subcommand and json format', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/project',
        mission: 'Fix bug',
      });
      expect(result).not.toBeNull();
      expect(result!.binary).toBe('/usr/local/bin/opencode');
      expect(result!.args).toContain('run');
      expect(result!.args).toContain('Fix bug');
      expect(result!.args).toContain('--format');
      expect(result!.args).toContain('json');
    });

    it('adds model flag for non-default model', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/project',
        mission: 'Fix bug',
        model: 'anthropic/claude-opus-4-6',
      });
      expect(result!.args).toContain('--model');
    });
  });

  describe('getDefaultPermissions', () => {
    it('returns bash-prefixed permissions for durable kind', () => {
      const perms = provider.getDefaultPermissions('durable');
      expect(perms).toContain('bash(git:*)');
      expect(perms).not.toContain('read');
    });

    it('returns more permissive quick permissions', () => {
      const perms = provider.getDefaultPermissions('quick');
      expect(perms).toContain('bash(git:*)');
      expect(perms).toContain('read');
      expect(perms).toContain('edit');
      expect(perms).toContain('glob');
      expect(perms).toContain('grep');
    });
  });

  describe('toolVerb', () => {
    it('returns verb for known tool', () => {
      expect(provider.toolVerb('bash')).toBe('Running command');
      expect(provider.toolVerb('write')).toBe('Writing file');
    });

    it('returns undefined for unknown tool', () => {
      expect(provider.toolVerb('unknown')).toBeUndefined();
    });
  });
});
