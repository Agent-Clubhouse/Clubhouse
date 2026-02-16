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
import { CopilotCliProvider } from './copilot-cli-provider';
import { OpenCodeProvider } from './opencode-provider';

describe('Provider integration tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      return s.endsWith('/claude') || s.endsWith('/copilot') || s.endsWith('/opencode');
    });
  });

  describe('buildSpawnCommand flag generation', () => {
    it('ClaudeCode: generates correct flags for all options', async () => {
      const provider = new ClaudeCodeProvider();
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        model: 'opus',
        allowedTools: ['Read', 'Write'],
        systemPrompt: 'Be concise',
        mission: 'Fix bug',
      });

      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('opus');
      expect(args).toContain('--append-system-prompt');
      expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('Be concise');
      expect(args.filter(a => a === '--allowedTools')).toHaveLength(2);
      expect(args[args.length - 1]).toBe('Fix bug');
    });

    it('CopilotCli: generates correct flags for model and mission', async () => {
      const provider = new CopilotCliProvider();
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        model: 'gpt-5',
        mission: 'Fix bug',
        systemPrompt: 'Context info',
      });

      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('gpt-5');
      // Copilot bakes mission and system prompt into -p
      expect(args).toContain('-p');
      const pIdx = args.indexOf('-p');
      expect(args[pIdx + 1]).toContain('Context info');
      expect(args[pIdx + 1]).toContain('Fix bug');
    });

    it('OpenCode: only passes mission as positional arg', async () => {
      const provider = new OpenCodeProvider();
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        mission: 'Fix bug',
      });
      expect(args).toEqual(['Fix bug']);
    });

    it('OpenCode: ignores model flag (unsupported)', async () => {
      const provider = new OpenCodeProvider();
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        model: 'opus',
        mission: 'Fix bug',
      });
      expect(args).not.toContain('--model');
    });
  });

  describe('buildHeadlessCommand', () => {
    it('ClaudeCode: generates valid -p invocation with all flags', async () => {
      const provider = new ClaudeCodeProvider();
      const result = await provider.buildHeadlessCommand({
        cwd: '/p',
        mission: 'Fix the auth bug',
        model: 'sonnet',
        allowedTools: ['Read', 'Bash(git:*)'],
        systemPrompt: 'Be thorough',
        outputFormat: 'stream-json',
        permissionMode: 'auto',
        maxTurns: 10,
        maxBudgetUsd: 0.5,
        noSessionPersistence: true,
      });

      expect(result).not.toBeNull();
      const { args } = result!;
      expect(args).toContain('-p');
      expect(args[args.indexOf('-p') + 1]).toBe('Fix the auth bug');
      expect(args).toContain('--output-format');
      expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
      // Permission is handled via env var, not CLI flag
      expect(result!.env).toEqual({ CLAUDE_AUTO_ACCEPT_PERMISSIONS: '1' });
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
      expect(args).toContain('--max-turns');
      expect(args[args.indexOf('--max-turns') + 1]).toBe('10');
      expect(args).toContain('--max-budget-usd');
      expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('0.5');
      expect(args).toContain('--no-session-persistence');
      expect(args).toContain('--append-system-prompt');
      expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('Be thorough');
      expect(args.filter(a => a === '--allowedTools')).toHaveLength(2);
    });

    it('ClaudeCode: returns null when no mission provided', async () => {
      const provider = new ClaudeCodeProvider();
      const result = await provider.buildHeadlessCommand({ cwd: '/p' });
      expect(result).toBeNull();
    });

    it('ClaudeCode: defaults output format to stream-json', async () => {
      const provider = new ClaudeCodeProvider();
      const result = await provider.buildHeadlessCommand({
        cwd: '/p',
        mission: 'test',
      });
      expect(result).not.toBeNull();
      const { args } = result!;
      expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    });

    it('ClaudeCode: supports disallowedTools', async () => {
      const provider = new ClaudeCodeProvider();
      const result = await provider.buildHeadlessCommand({
        cwd: '/p',
        mission: 'test',
        disallowedTools: ['Bash'],
      });
      expect(result).not.toBeNull();
      const { args } = result!;
      expect(args).toContain('--disallowedTools');
      expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash');
    });

    it('CopilotCli: does not have buildHeadlessCommand', () => {
      const provider = new CopilotCliProvider();
      expect(provider.buildHeadlessCommand).toBeUndefined();
    });

    it('OpenCode: does not have buildHeadlessCommand', () => {
      const provider = new OpenCodeProvider();
      expect(provider.buildHeadlessCommand).toBeUndefined();
    });
  });

  describe('writeHooksConfig format', () => {
    it('ClaudeCode: writes hooks in Claude Code format', async () => {
      const provider = new ClaudeCodeProvider();
      vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('/claude'));

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.hooks).toBeDefined();
      // Claude Code uses PascalCase event names
      expect(written.hooks.PreToolUse).toBeDefined();
      expect(written.hooks.PostToolUse).toBeDefined();
      expect(written.hooks.Stop).toBeDefined();
      expect(written.hooks.Notification).toBeDefined();
      expect(written.hooks.PermissionRequest).toBeDefined();
    });

    it('ClaudeCode: writes to .claude/settings.local.json', async () => {
      const provider = new ClaudeCodeProvider();
      vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('/claude'));

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.join('/project', '.claude', 'settings.local.json'),
        expect.any(String),
        'utf-8'
      );
    });

    it('CopilotCli: writes hooks in Copilot format', async () => {
      const provider = new CopilotCliProvider();
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        return s.endsWith('/copilot') || s.includes('.github');
      });

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.hooks).toBeDefined();
      // Copilot uses camelCase event names
      expect(written.hooks.preToolUse).toBeDefined();
      expect(written.hooks.postToolUse).toBeDefined();
      expect(written.hooks.errorOccurred).toBeDefined();
      expect(written.hooks.sessionEnd).toBeDefined();
    });

    it('CopilotCli: writes to .github/hooks/hooks.json', async () => {
      const provider = new CopilotCliProvider();
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        return s.endsWith('/copilot') || s.includes('.github');
      });

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.join('/project', '.github', 'hooks', 'hooks.json'),
        expect.any(String),
        'utf-8'
      );
    });

    it('OpenCode: writeHooksConfig is a no-op', async () => {
      const provider = new OpenCodeProvider();
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });

  describe('getDefaultPermissions', () => {
    it('ClaudeCode quick agents get file tools', () => {
      const provider = new ClaudeCodeProvider();
      const perms = provider.getDefaultPermissions('quick');
      expect(perms).toContain('Read');
      expect(perms).toContain('Write');
      expect(perms).toContain('Edit');
      expect(perms).toContain('Glob');
      expect(perms).toContain('Grep');
    });

    it('CopilotCli quick agents get file tools', () => {
      const provider = new CopilotCliProvider();
      const perms = provider.getDefaultPermissions('quick');
      expect(perms).toContain('Read');
      expect(perms).toContain('Write');
    });

    it('OpenCode returns empty permissions', () => {
      const provider = new OpenCodeProvider();
      const perms = provider.getDefaultPermissions('quick');
      expect(perms).toEqual([]);
    });
  });

  describe('parseHookEvent normalization', () => {
    it('ClaudeCode: normalizes PascalCase events', () => {
      const provider = new ClaudeCodeProvider();
      expect(provider.parseHookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })?.kind).toBe('pre_tool');
      expect(provider.parseHookEvent({ hook_event_name: 'PostToolUse' })?.kind).toBe('post_tool');
      expect(provider.parseHookEvent({ hook_event_name: 'PostToolUseFailure' })?.kind).toBe('tool_error');
      expect(provider.parseHookEvent({ hook_event_name: 'Stop' })?.kind).toBe('stop');
      expect(provider.parseHookEvent({ hook_event_name: 'Notification' })?.kind).toBe('notification');
      expect(provider.parseHookEvent({ hook_event_name: 'PermissionRequest' })?.kind).toBe('permission_request');
    });

    it('CopilotCli: normalizes camelCase events', () => {
      const provider = new CopilotCliProvider();
      expect(provider.parseHookEvent({ hook_event_name: 'preToolUse', tool_name: 'Bash' })?.kind).toBe('pre_tool');
      expect(provider.parseHookEvent({ hook_event_name: 'postToolUse' })?.kind).toBe('post_tool');
      expect(provider.parseHookEvent({ hook_event_name: 'errorOccurred' })?.kind).toBe('tool_error');
      expect(provider.parseHookEvent({ hook_event_name: 'sessionEnd' })?.kind).toBe('stop');
    });

    it('OpenCode: normalizes PascalCase events', () => {
      const provider = new OpenCodeProvider();
      expect(provider.parseHookEvent({ hook_event_name: 'PreToolUse' })?.kind).toBe('pre_tool');
      expect(provider.parseHookEvent({ hook_event_name: 'PostToolUse' })?.kind).toBe('post_tool');
      expect(provider.parseHookEvent({ hook_event_name: 'Stop' })?.kind).toBe('stop');
    });

    it('all providers return null for unknown event', () => {
      const providers = [new ClaudeCodeProvider(), new CopilotCliProvider(), new OpenCodeProvider()];
      for (const p of providers) {
        expect(p.parseHookEvent({ hook_event_name: 'Unknown' })).toBeNull();
        expect(p.parseHookEvent(null)).toBeNull();
        expect(p.parseHookEvent('not-object')).toBeNull();
      }
    });
  });

  describe('provider conventions match expected directory structure', () => {
    it('ClaudeCode uses .claude/', () => {
      const provider = new ClaudeCodeProvider();
      expect(provider.conventions.configDir).toBe('.claude');
      expect(provider.conventions.localInstructionsFile).toBe('CLAUDE.local.md');
      expect(provider.conventions.legacyInstructionsFile).toBe('CLAUDE.md');
      expect(provider.conventions.mcpConfigFile).toBe('.mcp.json');
      expect(provider.conventions.skillsDir).toBe('skills');
      expect(provider.conventions.agentTemplatesDir).toBe('agents');
      expect(provider.conventions.localSettingsFile).toBe('settings.local.json');
    });

    it('CopilotCli uses .github/', () => {
      const provider = new CopilotCliProvider();
      expect(provider.conventions.configDir).toBe('.github');
      expect(provider.conventions.localInstructionsFile).toBe('copilot-instructions.md');
      expect(provider.conventions.mcpConfigFile).toBe('.github/mcp.json');
      expect(provider.conventions.localSettingsFile).toBe('hooks/hooks.json');
    });

    it('OpenCode uses .opencode/', () => {
      const provider = new OpenCodeProvider();
      expect(provider.conventions.configDir).toBe('.opencode');
      expect(provider.conventions.localInstructionsFile).toBe('instructions.md');
      expect(provider.conventions.mcpConfigFile).toBe('.opencode/config.json');
      expect(provider.conventions.localSettingsFile).toBe('config.json');
    });
  });
});
