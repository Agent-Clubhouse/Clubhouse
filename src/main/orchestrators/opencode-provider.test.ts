import * as path from 'path';
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

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: `/usr/local/bin${path.delimiter}/usr/bin` })),
}));

import * as fs from 'fs';
import * as childProcess from 'child_process';
import { getShellEnvironment } from '../util/shell';
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

    it('uses opencode.json for local settings', () => {
      expect(provider.conventions.localSettingsFile).toBe('opencode.json');
    });

    it('has skills and agent templates dirs', () => {
      expect(provider.conventions.skillsDir).toBe('skills');
      expect(provider.conventions.agentTemplatesDir).toBe('agents');
    });

    it('uses instructions.md as legacy instructions file', () => {
      expect(provider.conventions.legacyInstructionsFile).toBe('instructions.md');
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

    it('returns generic error for non-Error throws', async () => {
      vi.mocked(findBinaryInPath).mockImplementationOnce(() => {
        throw 'string error';
      });
      const result = await provider.checkAvailability();
      expect(result.available).toBe(false);
      expect(result.error).toBe('Could not find OpenCode CLI');
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

    it('skips --model when undefined', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project' });
      expect(result.args).not.toContain('--model');
    });

    it('does not add --yolo or --dangerously-skip-permissions (not supported)', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project', freeAgentMode: true });
      expect(result.args).not.toContain('--yolo');
      expect(result.args).not.toContain('--dangerously-skip-permissions');
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
      expect(fs.mkdirSync).not.toHaveBeenCalled();
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

    it('accepts camelCase toolName field', () => {
      const result = provider.parseHookEvent({
        kind: 'post_tool',
        toolName: 'edit',
      });
      expect(result?.toolName).toBe('edit');
    });

    it('prefers tool_name over toolName when both present', () => {
      const result = provider.parseHookEvent({
        kind: 'pre_tool',
        tool_name: 'bash',
        toolName: 'edit',
      });
      expect(result?.toolName).toBe('bash');
    });

    it('parses stop event', () => {
      const result = provider.parseHookEvent({
        kind: 'stop',
        message: 'Done',
      });
      expect(result).toEqual({
        kind: 'stop',
        toolName: undefined,
        toolInput: undefined,
        message: 'Done',
      });
    });

    it('parses tool_error event', () => {
      const result = provider.parseHookEvent({
        kind: 'tool_error',
        tool_name: 'bash',
        message: 'Command failed',
      });
      expect(result?.kind).toBe('tool_error');
      expect(result?.message).toBe('Command failed');
    });

    it('returns null when kind is missing', () => {
      const result = provider.parseHookEvent({ tool_name: 'bash' });
      expect(result).toBeNull();
    });

    it('returns null for non-object input', () => {
      expect(provider.parseHookEvent(null)).toBeNull();
      expect(provider.parseHookEvent(42)).toBeNull();
      expect(provider.parseHookEvent('string')).toBeNull();
      expect(provider.parseHookEvent(undefined)).toBeNull();
    });
  });

  describe('readInstructions', () => {
    it('reads from .opencode/instructions.md', () => {
      const result = provider.readInstructions('/project');
      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join('/project', '.opencode', 'instructions.md'),
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
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        path.join('/project', '.opencode'),
        { recursive: true },
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.join('/project', '.opencode', 'instructions.md'),
        'New content',
        'utf-8',
      );
    });

    it('skips mkdir when directory exists', () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      provider.writeInstructions('/project', 'New content');
      expect(fs.mkdirSync).not.toHaveBeenCalled();
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
      expect(result!.args).toContain('anthropic/claude-opus-4-6');
    });

    it('skips model flag for default model', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/project',
        mission: 'Fix bug',
        model: 'default',
      });
      expect(result!.args).not.toContain('--model');
    });

    it('returns text outputKind', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/project',
        mission: 'Fix bug',
      });
      expect(result!.outputKind).toBe('text');
    });
  });

  describe('getModelOptions', () => {
    it('returns fallback list when binary command fails', async () => {
      // execFile mock already throws by default
      const options = await provider.getModelOptions();
      expect(options).toEqual([{ id: 'default', label: 'Default' }]);
    });

    it('first option is always default', async () => {
      const options = await provider.getModelOptions();
      expect(options[0].id).toBe('default');
      expect(options[0].label).toBe('Default');
    });

    it('every option has id and label strings', async () => {
      const options = await provider.getModelOptions();
      for (const opt of options) {
        expect(typeof opt.id).toBe('string');
        expect(typeof opt.label).toBe('string');
        expect(opt.id.length).toBeGreaterThan(0);
        expect(opt.label.length).toBeGreaterThan(0);
      }
    });

    it('passes shell environment to execFile for models call', async () => {
      const mockEnv = { PATH: '/custom/path:/usr/bin', HOME: '/home/user' };
      vi.mocked(getShellEnvironment).mockReturnValue(mockEnv);

      await provider.getModelOptions();

      const calls = vi.mocked(childProcess.execFile).mock.calls;
      const modelsCall = calls.find((c) => (c[1] as string[])?.[0] === 'models');
      expect(modelsCall).toBeDefined();
      const opts = modelsCall![2] as Record<string, unknown>;
      expect(opts.env).toEqual(mockEnv);
    });
  });

  describe('getDefaultPermissions', () => {
    it('returns durable permissions using OpenCode tool names', () => {
      const perms = provider.getDefaultPermissions('durable');
      expect(perms).toEqual(['bash(git:*)', 'bash(npm:*)', 'bash(npx:*)']);
    });

    it('durable permissions use "bash" not "Bash" or "shell"', () => {
      const perms = provider.getDefaultPermissions('durable');
      for (const p of perms) {
        expect(p).not.toMatch(/^Bash/);
        expect(p).not.toMatch(/^shell/);
        expect(p).toMatch(/^bash/);
      }
    });

    it('returns quick permissions with file tool names', () => {
      const perms = provider.getDefaultPermissions('quick');
      expect(perms).toContain('bash(git:*)');
      expect(perms).toContain('bash(npm:*)');
      expect(perms).toContain('bash(npx:*)');
      expect(perms).toContain('read');
      expect(perms).toContain('edit');
      expect(perms).toContain('glob');
      expect(perms).toContain('grep');
    });

    it('quick permissions use lowercase tool names (not PascalCase)', () => {
      const perms = provider.getDefaultPermissions('quick');
      for (const p of perms) {
        expect(p).not.toMatch(/^[A-Z]/);
      }
    });

    it('quick permissions do NOT use Claude Code tool names', () => {
      const perms = provider.getDefaultPermissions('quick');
      expect(perms).not.toContain('Read');
      expect(perms).not.toContain('Write');
      expect(perms).not.toContain('Edit');
      expect(perms).not.toContain('Glob');
      expect(perms).not.toContain('Grep');
      expect(perms).not.toContain('Bash(git:*)');
    });

    it('quick permissions do NOT use Copilot tool names for shell', () => {
      const perms = provider.getDefaultPermissions('quick');
      expect(perms).not.toContain('shell(git:*)');
      expect(perms).not.toContain('search');
    });

    it('quick permissions include all durable permissions', () => {
      const durable = provider.getDefaultPermissions('durable');
      const quick = provider.getDefaultPermissions('quick');
      for (const perm of durable) {
        expect(quick).toContain(perm);
      }
    });

    it('returns a new array each call (no shared reference)', () => {
      const a = provider.getDefaultPermissions('durable');
      const b = provider.getDefaultPermissions('durable');
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });

    it('quick returns a new array each call', () => {
      const a = provider.getDefaultPermissions('quick');
      const b = provider.getDefaultPermissions('quick');
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe('toolVerb', () => {
    it('maps all OpenCode tool names to verbs', () => {
      expect(provider.toolVerb('bash')).toBe('Running command');
      expect(provider.toolVerb('edit')).toBe('Editing file');
      expect(provider.toolVerb('write')).toBe('Writing file');
      expect(provider.toolVerb('read')).toBe('Reading file');
      expect(provider.toolVerb('glob')).toBe('Searching files');
      expect(provider.toolVerb('grep')).toBe('Searching code');
    });

    it('does NOT map Claude Code tool names', () => {
      expect(provider.toolVerb('Bash')).toBeUndefined();
      expect(provider.toolVerb('Read')).toBeUndefined();
      expect(provider.toolVerb('Write')).toBeUndefined();
      expect(provider.toolVerb('Edit')).toBeUndefined();
      expect(provider.toolVerb('Glob')).toBeUndefined();
      expect(provider.toolVerb('Grep')).toBeUndefined();
    });

    it('does NOT map Copilot tool names', () => {
      expect(provider.toolVerb('shell')).toBeUndefined();
      expect(provider.toolVerb('search')).toBeUndefined();
      expect(provider.toolVerb('agent')).toBeUndefined();
    });

    it('returns undefined for unknown tool', () => {
      expect(provider.toolVerb('unknown')).toBeUndefined();
    });
  });

  describe('buildSummaryInstruction', () => {
    it('delegates to shared implementation', () => {
      const result = provider.buildSummaryInstruction('agent-1');
      expect(result).toBe('Summarize');
    });
  });

  describe('readQuickSummary', () => {
    it('delegates to shared implementation', async () => {
      const result = await provider.readQuickSummary('agent-1');
      expect(result).toBeNull();
    });
  });
});
