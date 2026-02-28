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

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: `/usr/local/bin${path.delimiter}/usr/bin` })),
}));

import * as fs from 'fs';
import * as childProcess from 'child_process';
import { getShellEnvironment } from '../util/shell';
import { CopilotCliProvider } from './copilot-cli-provider';
import { findBinaryInPath } from './shared';
import { isClubhouseHookEntry } from '../services/config-pipeline';

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

    it('has Beta badge', () => {
      expect(provider.badge).toBe('Beta');
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

    it('uses hooks/hooks.json for local settings', () => {
      expect(provider.conventions.localSettingsFile).toBe('hooks/hooks.json');
    });

    it('has skills and agent templates dirs', () => {
      expect(provider.conventions.skillsDir).toBe('skills');
      expect(provider.conventions.agentTemplatesDir).toBe('agents');
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
      expect(result.error).toBe('Could not find Copilot CLI');
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

  describe('writeHooksConfig', () => {
    it('creates hooks directory and writes hooks.json', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        path.join('/project', '.github', 'hooks'),
        { recursive: true },
      );
      expect(fs.writeFileSync).toHaveBeenCalled();

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.hooks).toBeDefined();
      expect(written.hooks.preToolUse).toBeDefined();
      expect(written.hooks.postToolUse).toBeDefined();
      expect(written.hooks.errorOccurred).toBeDefined();
    });

    it('curl command uses env var references for agent ID and nonce', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      const hookEntry = written.hooks.preToolUse[0];
      if (process.platform === 'win32') {
        expect(hookEntry.bash).toContain('%CLUBHOUSE_AGENT_ID%');
        expect(hookEntry.bash).toContain('%CLUBHOUSE_HOOK_NONCE%');
      } else {
        expect(hookEntry.bash).toContain('${CLUBHOUSE_AGENT_ID}');
        expect(hookEntry.bash).toContain('${CLUBHOUSE_HOOK_NONCE}');
      }
    });

    it('merges with existing settings preserving user hooks', async () => {
      const existingConfig = {
        version: 1,
        hooks: {
          preToolUse: [{ type: 'command', bash: 'echo user-hook', timeoutSec: 3 }],
        },
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(existingConfig));
      vi.mocked(isClubhouseHookEntry).mockReturnValue(false);

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      // User hook should be preserved (first), Clubhouse hook appended
      expect(written.hooks.preToolUse.length).toBeGreaterThan(1);
      expect(written.hooks.preToolUse[0].bash).toBe('echo user-hook');
    });

    it('replaces stale Clubhouse entries', async () => {
      const existingConfig = {
        version: 1,
        hooks: {
          preToolUse: [{ type: 'command', bash: 'old-clubhouse-hook' }],
        },
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(existingConfig));
      vi.mocked(isClubhouseHookEntry).mockReturnValue(true);

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      // Stale hook should be removed, only new Clubhouse hook present
      expect(written.hooks.preToolUse).toHaveLength(1);
      expect(written.hooks.preToolUse[0].bash).not.toBe('old-clubhouse-hook');
    });

    it('each hook entry has type command and timeoutSec', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      for (const eventKey of ['preToolUse', 'postToolUse', 'errorOccurred']) {
        const entry = written.hooks[eventKey][0];
        expect(entry.type).toBe('command');
        expect(entry.timeoutSec).toBe(5);
      }
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

    it('parses errorOccurred event as tool_error', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'errorOccurred',
        message: 'Something went wrong',
      });
      expect(result).toEqual({
        kind: 'tool_error',
        toolName: undefined,
        toolInput: undefined,
        message: 'Something went wrong',
      });
    });

    it('parses sessionEnd event as stop', () => {
      const result = provider.parseHookEvent({ hook_event_name: 'sessionEnd' });
      expect(result?.kind).toBe('stop');
    });

    it('accepts camelCase toolName field', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'preToolUse',
        toolName: 'read',
      });
      expect(result?.toolName).toBe('read');
    });

    it('prefers tool_name over toolName when both present', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'preToolUse',
        tool_name: 'shell',
        toolName: 'read',
      });
      expect(result?.toolName).toBe('shell');
    });

    it('parses toolArgs as string (JSON)', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'preToolUse',
        tool_name: 'shell',
        toolArgs: '{"command":"git status"}',
      });
      expect(result?.toolInput).toEqual({ command: 'git status' });
    });

    it('parses toolArgs as object', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'preToolUse',
        tool_name: 'edit',
        toolArgs: { path: '/file.ts', content: 'code' },
      });
      expect(result?.toolInput).toEqual({ path: '/file.ts', content: 'code' });
    });

    it('returns null for unknown event', () => {
      const result = provider.parseHookEvent({ hook_event_name: 'unknown' });
      expect(result).toBeNull();
    });

    it('returns null for non-object input', () => {
      expect(provider.parseHookEvent(null)).toBeNull();
      expect(provider.parseHookEvent('string')).toBeNull();
      expect(provider.parseHookEvent(42)).toBeNull();
      expect(provider.parseHookEvent(undefined)).toBeNull();
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

    it('combines systemPrompt and mission', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/project',
        mission: 'Fix bug',
        systemPrompt: 'Be thorough',
      });
      const pIdx = result!.args.indexOf('-p');
      expect(result!.args[pIdx + 1]).toContain('Be thorough');
      expect(result!.args[pIdx + 1]).toContain('Fix bug');
    });
  });

  describe('getModelOptions', () => {
    it('returns fallback model list when binary help fails', async () => {
      // execFile mock already throws by default
      const options = await provider.getModelOptions();
      expect(options.length).toBeGreaterThanOrEqual(4);
      expect(options[0]).toEqual({ id: 'default', label: 'Default' });
      const ids = options.map(o => o.id);
      expect(ids).toContain('claude-sonnet-4.5');
      expect(ids).toContain('claude-opus-4.6');
      expect(ids).toContain('gpt-5');
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

    it('passes shell environment to execFile for --help call', async () => {
      const mockEnv = { PATH: '/custom/path:/usr/bin', HOME: '/home/user' };
      vi.mocked(getShellEnvironment).mockReturnValue(mockEnv);

      await provider.getModelOptions();

      const calls = vi.mocked(childProcess.execFile).mock.calls;
      const helpCall = calls.find((c) => (c[1] as string[])?.[0] === '--help');
      expect(helpCall).toBeDefined();
      const opts = helpCall![2] as Record<string, unknown>;
      expect(opts.env).toEqual(mockEnv);
    });
  });

  describe('getDefaultPermissions', () => {
    it('returns durable permissions using Copilot tool names', () => {
      const perms = provider.getDefaultPermissions('durable');
      expect(perms).toEqual(['shell(git:*)', 'shell(npm:*)', 'shell(npx:*)']);
    });

    it('durable permissions use "shell" not "Bash" or "bash"', () => {
      const perms = provider.getDefaultPermissions('durable');
      for (const p of perms) {
        expect(p).not.toMatch(/^Bash/);
        expect(p).not.toMatch(/^bash/);
        expect(p).toMatch(/^shell/);
      }
    });

    it('returns quick permissions with file tool names', () => {
      const perms = provider.getDefaultPermissions('quick');
      expect(perms).toContain('shell(git:*)');
      expect(perms).toContain('shell(npm:*)');
      expect(perms).toContain('shell(npx:*)');
      expect(perms).toContain('read');
      expect(perms).toContain('edit');
      expect(perms).toContain('search');
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
    it('maps all Copilot tool names to verbs', () => {
      expect(provider.toolVerb('shell')).toBe('Running command');
      expect(provider.toolVerb('edit')).toBe('Editing file');
      expect(provider.toolVerb('read')).toBe('Reading file');
      expect(provider.toolVerb('search')).toBe('Searching code');
      expect(provider.toolVerb('agent')).toBe('Running agent');
    });

    it('does NOT map Claude Code tool names', () => {
      expect(provider.toolVerb('Bash')).toBeUndefined();
      expect(provider.toolVerb('Read')).toBeUndefined();
      expect(provider.toolVerb('Write')).toBeUndefined();
      expect(provider.toolVerb('Edit')).toBeUndefined();
      expect(provider.toolVerb('Glob')).toBeUndefined();
      expect(provider.toolVerb('Grep')).toBeUndefined();
    });

    it('does NOT map OpenCode tool names', () => {
      expect(provider.toolVerb('bash')).toBeUndefined();
      expect(provider.toolVerb('write')).toBeUndefined();
      expect(provider.toolVerb('glob')).toBeUndefined();
      expect(provider.toolVerb('grep')).toBeUndefined();
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
