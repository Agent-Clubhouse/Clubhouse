import * as path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => '# Instructions'),
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
  findBinaryInPath: vi.fn(() => '/usr/local/bin/copilot'),
  homePath: vi.fn((...segments: string[]) => `/home/user/${segments.join('/')}`),
  buildSummaryInstruction: vi.fn(() => 'Summarize'),
  readQuickSummary: vi.fn(async () => null),
}));

vi.mock('../services/config-pipeline', () => ({
  isClubhouseHookEntry: vi.fn(() => false),
}));

import * as fs from 'fs';
import { CopilotCliProvider } from './copilot-cli-provider';
import { findBinaryInPath } from './shared';

describe('CopilotCliProvider', () => {
  let provider: CopilotCliProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CopilotCliProvider();
  });

  describe('identity', () => {
    it('has correct id and displayName', () => {
      expect(provider.id).toBe('copilot-cli');
      expect(provider.displayName).toBe('GitHub Copilot CLI');
      expect(provider.shortName).toBe('GHCP');
    });
  });

  describe('getCapabilities', () => {
    it('reports headless and hooks support', () => {
      const caps = provider.getCapabilities();
      expect(caps.headless).toBe(true);
      expect(caps.hooks).toBe(true);
      expect(caps.sessionResume).toBe(true);
      expect(caps.permissions).toBe(true);
      expect(caps.structuredOutput).toBe(false);
    });
  });

  describe('conventions', () => {
    it('uses .github directory for config', () => {
      expect(provider.conventions.configDir).toBe('.github');
      expect(provider.conventions.localInstructionsFile).toBe('copilot-instructions.md');
      expect(provider.conventions.mcpConfigFile).toBe('.github/mcp.json');
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
      expect(result.binary).toBe('/usr/local/bin/copilot');
      expect(result.args).toEqual([]);
    });

    it('adds --yolo flag for freeAgentMode', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project', freeAgentMode: true });
      expect(result.args).toContain('--yolo');
    });

    it('adds --model flag for non-default model', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project', model: 'gpt-5' });
      expect(result.args).toContain('--model');
      expect(result.args).toContain('gpt-5');
    });

    it('skips --model flag for default model', async () => {
      const result = await provider.buildSpawnCommand({ cwd: '/project', model: 'default' });
      expect(result.args).not.toContain('--model');
    });

    it('adds -p flag with mission content', async () => {
      const result = await provider.buildSpawnCommand({
        cwd: '/project',
        mission: 'Fix the bug',
      });
      expect(result.args).toContain('-p');
      expect(result.args).toContain('Fix the bug');
    });

    it('combines systemPrompt and mission', async () => {
      const result = await provider.buildSpawnCommand({
        cwd: '/project',
        systemPrompt: 'You are helpful',
        mission: 'Fix the bug',
      });
      const promptIdx = result.args.indexOf('-p');
      expect(result.args[promptIdx + 1]).toContain('You are helpful');
      expect(result.args[promptIdx + 1]).toContain('Fix the bug');
    });

    it('adds --allow-tool flags for allowed tools', async () => {
      const result = await provider.buildSpawnCommand({
        cwd: '/project',
        allowedTools: ['read', 'edit'],
      });
      expect(result.args).toContain('--allow-tool');
      expect(result.args.filter(a => a === '--allow-tool')).toHaveLength(2);
    });
  });

  describe('getExitCommand', () => {
    it('returns /exit with carriage return', () => {
      expect(provider.getExitCommand()).toBe('/exit\r');
    });
  });

  describe('parseHookEvent', () => {
    it('parses preToolUse event', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'preToolUse',
        tool_name: 'shell',
        tool_input: { command: 'ls' },
      });
      expect(result).toEqual({
        kind: 'pre_tool',
        toolName: 'shell',
        toolInput: { command: 'ls' },
        message: undefined,
      });
    });

    it('parses postToolUse event', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'postToolUse',
        toolName: 'edit',
      });
      expect(result).toEqual({
        kind: 'post_tool',
        toolName: 'edit',
        toolInput: undefined,
        message: undefined,
      });
    });

    it('parses sessionEnd event as stop', () => {
      const result = provider.parseHookEvent({ hook_event_name: 'sessionEnd' });
      expect(result?.kind).toBe('stop');
    });

    it('returns null for unknown event', () => {
      const result = provider.parseHookEvent({ hook_event_name: 'unknown' });
      expect(result).toBeNull();
    });

    it('returns null for non-object input', () => {
      expect(provider.parseHookEvent(null)).toBeNull();
      expect(provider.parseHookEvent('string')).toBeNull();
    });
  });

  describe('readInstructions', () => {
    it('reads from .github/copilot-instructions.md', () => {
      const result = provider.readInstructions('/project');
      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join('/project', '.github', 'copilot-instructions.md'),
        'utf-8',
      );
      expect(result).toBe('# Instructions');
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
    it('creates .github directory if needed', () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(false);
      provider.writeInstructions('/project', 'New instructions');
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.join('/project', '.github', 'copilot-instructions.md'),
        'New instructions',
        'utf-8',
      );
    });
  });

  describe('buildHeadlessCommand', () => {
    it('returns null when no mission provided', async () => {
      const result = await provider.buildHeadlessCommand({ cwd: '/project' });
      expect(result).toBeNull();
    });

    it('builds command with mission', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/project',
        mission: 'Fix bug',
      });
      expect(result).not.toBeNull();
      expect(result!.binary).toBe('/usr/local/bin/copilot');
      expect(result!.args).toContain('-p');
      expect(result!.args).toContain('--allow-all');
      expect(result!.args).toContain('--silent');
    });

    it('adds model flag for non-default model', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/project',
        mission: 'Fix bug',
        model: 'gpt-5',
      });
      expect(result!.args).toContain('--model');
      expect(result!.args).toContain('gpt-5');
    });
  });

  describe('getDefaultPermissions', () => {
    it('returns durable permissions for durable kind', () => {
      const perms = provider.getDefaultPermissions('durable');
      expect(perms).toContain('shell(git:*)');
      expect(perms).not.toContain('read');
    });

    it('returns more permissive quick permissions', () => {
      const perms = provider.getDefaultPermissions('quick');
      expect(perms).toContain('shell(git:*)');
      expect(perms).toContain('read');
      expect(perms).toContain('edit');
    });
  });

  describe('toolVerb', () => {
    it('returns verb for known tool', () => {
      expect(provider.toolVerb('shell')).toBe('Running command');
      expect(provider.toolVerb('edit')).toBe('Editing file');
    });

    it('returns undefined for unknown tool', () => {
      expect(provider.toolVerb('unknown')).toBeUndefined();
    });
  });
});
