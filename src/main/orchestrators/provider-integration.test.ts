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
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    if (cb) cb(new Error('not found'), { stdout: '', stderr: '' });
    return { stdout: '', stderr: '' };
  }),
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

    it('CopilotCli: generates correct flags for model, mission, and allowedTools', async () => {
      const provider = new CopilotCliProvider();
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        model: 'claude-sonnet-4-5',
        mission: 'Fix bug',
        systemPrompt: 'Context info',
        allowedTools: ['read', 'edit'],
      });

      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-5');
      // Copilot uses --allow-tool for individual tools
      expect(args.filter(a => a === '--allow-tool')).toHaveLength(2);
      // Copilot bakes mission and system prompt into -p
      expect(args).toContain('-p');
      const pIdx = args.indexOf('-p');
      expect(args[pIdx + 1]).toContain('Context info');
      expect(args[pIdx + 1]).toContain('Fix bug');
    });

    it('OpenCode: passes model flag when provided', async () => {
      const provider = new OpenCodeProvider();
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        model: 'anthropic/claude-sonnet-4-5',
      });
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('anthropic/claude-sonnet-4-5');
    });

    it('OpenCode: no args when no options', async () => {
      const provider = new OpenCodeProvider();
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
      });
      expect(args).toEqual([]);
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
        noSessionPersistence: true,
      });

      expect(result).not.toBeNull();
      const { args } = result!;
      expect(result!.outputKind).toBe('stream-json');
      expect(args).toContain('-p');
      expect(args[args.indexOf('-p') + 1]).toBe('Fix the auth bug');
      expect(args).toContain('--output-format');
      expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
      // Permission is handled via --dangerously-skip-permissions flag
      expect(args).toContain('--dangerously-skip-permissions');
      expect(result!.env).toBeUndefined();
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
      expect(args).not.toContain('--max-turns');
      expect(args).not.toContain('--max-budget-usd');
      expect(args).toContain('--no-session-persistence');
      expect(args).toContain('--append-system-prompt');
      expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('Be thorough');
      expect(args.filter(a => a === '--allowedTools')).toHaveLength(2);
    });

    it('ClaudeCode: always adds --dangerously-skip-permissions even without permissionMode', async () => {
      const provider = new ClaudeCodeProvider();
      const result = await provider.buildHeadlessCommand({
        cwd: '/p',
        mission: 'test',
      });
      expect(result).not.toBeNull();
      expect(result!.args).toContain('--dangerously-skip-permissions');
      expect(result!.env).toBeUndefined();
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

    it('CopilotCli: generates headless command with --allow-all --silent and text outputKind', async () => {
      const provider = new CopilotCliProvider();
      const result = await provider.buildHeadlessCommand!({
        cwd: '/p',
        mission: 'Fix the bug',
        model: 'claude-sonnet-4-5',
        systemPrompt: 'Be thorough',
      });

      expect(result).not.toBeNull();
      expect(result!.outputKind).toBe('text');
      const { args } = result!;
      expect(args).toContain('-p');
      const pIdx = args.indexOf('-p');
      expect(args[pIdx + 1]).toContain('Be thorough');
      expect(args[pIdx + 1]).toContain('Fix the bug');
      expect(args).toContain('--allow-all');
      expect(args).toContain('--silent');
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-5');
    });

    it('CopilotCli: returns null when no mission', async () => {
      const provider = new CopilotCliProvider();
      const result = await provider.buildHeadlessCommand!({ cwd: '/p' });
      expect(result).toBeNull();
    });

    it('OpenCode: generates headless command with run --format json and text outputKind', async () => {
      const provider = new OpenCodeProvider();
      const result = await provider.buildHeadlessCommand!({
        cwd: '/p',
        mission: 'Fix the bug',
        model: 'anthropic/claude-sonnet-4-5',
      });

      expect(result).not.toBeNull();
      expect(result!.outputKind).toBe('text');
      const { args } = result!;
      expect(args[0]).toBe('run');
      expect(args[1]).toBe('Fix the bug');
      expect(args).toContain('--format');
      expect(args[args.indexOf('--format') + 1]).toBe('json');
      expect(args).toContain('--model');
      expect(args[args.indexOf('--model') + 1]).toBe('anthropic/claude-sonnet-4-5');
    });

    it('OpenCode: returns null when no mission', async () => {
      const provider = new OpenCodeProvider();
      const result = await provider.buildHeadlessCommand!({ cwd: '/p' });
      expect(result).toBeNull();
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

    it('CopilotCli: writes hooks with version 1 wrapper and bash/timeoutSec properties', async () => {
      const provider = new CopilotCliProvider();
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        return s.endsWith('/copilot') || s.includes('.github');
      });

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      // Must have version 1 wrapper
      expect(written.version).toBe(1);
      expect(written.hooks).toBeDefined();
      // Copilot uses camelCase event names
      expect(written.hooks.preToolUse).toBeDefined();
      expect(written.hooks.postToolUse).toBeDefined();
      expect(written.hooks.errorOccurred).toBeDefined();
      // Flat array per event, uses type/bash/timeoutSec (not command/timeout)
      const entry = written.hooks.preToolUse[0];
      expect(entry.type).toBe('command');
      expect(entry.bash).toBeDefined();
      expect(entry.timeoutSec).toBe(5);
      expect(entry.command).toBeUndefined();
      expect(entry.timeout).toBeUndefined();
      expect(entry.async).toBeUndefined();
      // Each event type encodes its name in the URL path
      expect(entry.bash).toContain('/preToolUse');
      const postEntry = written.hooks.postToolUse[0];
      expect(postEntry.bash).toContain('/postToolUse');
      const errEntry = written.hooks.errorOccurred[0];
      expect(errEntry.bash).toContain('/errorOccurred');
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

    it('CopilotCli quick agents get PascalCase file tools', () => {
      const provider = new CopilotCliProvider();
      const perms = provider.getDefaultPermissions('quick');
      expect(perms).toContain('Read');
      expect(perms).toContain('Write');
      expect(perms).toContain('Edit');
      expect(perms).toContain('Glob');
      expect(perms).toContain('Grep');
    });

    it('CopilotCli durable agents get PascalCase Bash permissions', () => {
      const provider = new CopilotCliProvider();
      const perms = provider.getDefaultPermissions('durable');
      expect(perms).toContain('Bash(git:*)');
      expect(perms).toContain('Bash(npm:*)');
      expect(perms).toContain('Bash(npx:*)');
    });

    it('OpenCode quick agents get lowercase tool permissions', () => {
      const provider = new OpenCodeProvider();
      const perms = provider.getDefaultPermissions('quick');
      expect(perms).toContain('read');
      expect(perms).toContain('edit');
      expect(perms).toContain('glob');
      expect(perms).toContain('grep');
      expect(perms).toContain('bash(git:*)');
    });

    it('OpenCode durable agents get bash permissions', () => {
      const provider = new OpenCodeProvider();
      const perms = provider.getDefaultPermissions('durable');
      expect(perms).toContain('bash(git:*)');
      expect(perms).toContain('bash(npm:*)');
      expect(perms).toContain('bash(npx:*)');
      expect(perms).not.toContain('read');
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
      expect(provider.parseHookEvent({ hook_event_name: 'preToolUse', tool_name: 'shell' })?.kind).toBe('pre_tool');
      expect(provider.parseHookEvent({ hook_event_name: 'postToolUse' })?.kind).toBe('post_tool');
      expect(provider.parseHookEvent({ hook_event_name: 'errorOccurred' })?.kind).toBe('tool_error');
      expect(provider.parseHookEvent({ hook_event_name: 'sessionEnd' })?.kind).toBe('stop');
    });

    it('CopilotCli: handles camelCase tool fields (toolName, toolArgs)', () => {
      const provider = new CopilotCliProvider();
      const event = provider.parseHookEvent({
        hook_event_name: 'preToolUse',
        toolName: 'shell',
        toolArgs: '{"command": "git status"}',
      });
      expect(event).not.toBeNull();
      expect(event!.toolName).toBe('shell');
      expect(event!.toolInput).toEqual({ command: 'git status' });
    });

    it('CopilotCli: handles snake_case tool fields as fallback', () => {
      const provider = new CopilotCliProvider();
      const event = provider.parseHookEvent({
        hook_event_name: 'preToolUse',
        tool_name: 'read',
        tool_input: { path: '/foo' },
      });
      expect(event).not.toBeNull();
      expect(event!.toolName).toBe('read');
      expect(event!.toolInput).toEqual({ path: '/foo' });
    });

    it('OpenCode: uses kind field directly', () => {
      const provider = new OpenCodeProvider();
      expect(provider.parseHookEvent({ kind: 'pre_tool', toolName: 'bash' })?.kind).toBe('pre_tool');
      expect(provider.parseHookEvent({ kind: 'post_tool' })?.kind).toBe('post_tool');
      expect(provider.parseHookEvent({ kind: 'stop' })?.kind).toBe('stop');
    });

    it('all providers return null for unknown event', () => {
      const providers = [new ClaudeCodeProvider(), new CopilotCliProvider(), new OpenCodeProvider()];
      for (const p of providers) {
        expect(p.parseHookEvent(null)).toBeNull();
        expect(p.parseHookEvent('not-object')).toBeNull();
      }
      // Claude and Copilot return null for unknown hook_event_name
      expect(new ClaudeCodeProvider().parseHookEvent({ hook_event_name: 'Unknown' })).toBeNull();
      expect(new CopilotCliProvider().parseHookEvent({ hook_event_name: 'Unknown' })).toBeNull();
      // OpenCode returns null when kind is missing
      expect(new OpenCodeProvider().parseHookEvent({ hook_event_name: 'Unknown' })).toBeNull();
    });
  });

  describe('provider conventions match expected directory structure', () => {
    it('ClaudeCode uses .claude/', () => {
      const provider = new ClaudeCodeProvider();
      expect(provider.conventions.configDir).toBe('.claude');
      expect(provider.conventions.localInstructionsFile).toBe('CLAUDE.md');
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

    it('OpenCode uses .opencode/ with opencode.json', () => {
      const provider = new OpenCodeProvider();
      expect(provider.conventions.configDir).toBe('.opencode');
      expect(provider.conventions.localInstructionsFile).toBe('instructions.md');
      expect(provider.conventions.mcpConfigFile).toBe('opencode.json');
      expect(provider.conventions.localSettingsFile).toBe('opencode.json');
    });
  });

  describe('getCapabilities', () => {
    it('ClaudeCode: all capabilities enabled', () => {
      const caps = new ClaudeCodeProvider().getCapabilities();
      expect(caps).toEqual({
        headless: true,
        structuredOutput: true,
        hooks: true,
        sessionResume: true,
        permissions: true,
      });
    });

    it('CopilotCli: no structuredOutput', () => {
      const caps = new CopilotCliProvider().getCapabilities();
      expect(caps.headless).toBe(true);
      expect(caps.structuredOutput).toBe(false);
      expect(caps.hooks).toBe(true);
      expect(caps.sessionResume).toBe(true);
      expect(caps.permissions).toBe(true);
    });

    it('OpenCode: no hooks or permissions', () => {
      const caps = new OpenCodeProvider().getCapabilities();
      expect(caps.headless).toBe(true);
      expect(caps.structuredOutput).toBe(false);
      expect(caps.hooks).toBe(false);
      expect(caps.sessionResume).toBe(true);
      expect(caps.permissions).toBe(false);
    });

    it('all providers return an object with all required keys', () => {
      const requiredKeys = ['headless', 'structuredOutput', 'hooks', 'sessionResume', 'permissions'];
      const providers = [new ClaudeCodeProvider(), new CopilotCliProvider(), new OpenCodeProvider()];
      for (const p of providers) {
        const caps = p.getCapabilities();
        for (const key of requiredKeys) {
          expect(typeof (caps as any)[key]).toBe('boolean');
        }
      }
    });
  });

  describe('writeHooksConfig merge behavior', () => {
    it('ClaudeCode: preserves existing user hooks alongside Clubhouse hooks', async () => {
      const provider = new ClaudeCodeProvider();
      vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('/claude'));

      // Simulate existing user hooks
      const existingConfig = {
        someOtherSetting: true,
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: 'echo "user pre-tool hook"' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'echo "user stop hook"' }] }],
        },
      };
      vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify(existingConfig));

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      // User's other settings preserved
      expect(written.someOtherSetting).toBe(true);
      // PreToolUse should have user entry + our entry
      expect(written.hooks.PreToolUse).toHaveLength(2);
      expect(written.hooks.PreToolUse[0].hooks[0].command).toBe('echo "user pre-tool hook"');
      expect(written.hooks.PreToolUse[1].hooks[0].command).toContain('CLUBHOUSE_AGENT_ID');
      // Stop should have user entry + our entry
      expect(written.hooks.Stop).toHaveLength(2);
    });

    it('ClaudeCode: replaces stale Clubhouse entries (idempotent)', async () => {
      const provider = new ClaudeCodeProvider();
      vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('/claude'));

      // Simulate existing config with old Clubhouse entries
      const existingConfig = {
        hooks: {
          PreToolUse: [
            { hooks: [{ type: 'command', command: 'cat | curl -s -X POST http://127.0.0.1:8888/hook/${CLUBHOUSE_AGENT_ID} || true' }] },
            { hooks: [{ type: 'command', command: 'echo "user hook"' }] },
          ],
        },
      };
      vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify(existingConfig));

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      // Should have user entry + new Clubhouse entry (old one replaced)
      expect(written.hooks.PreToolUse).toHaveLength(2);
      expect(written.hooks.PreToolUse[0].hooks[0].command).toBe('echo "user hook"');
      expect(written.hooks.PreToolUse[1].hooks[0].command).toContain('127.0.0.1:9999');
    });

    it('CopilotCli: preserves existing user hooks alongside Clubhouse hooks', async () => {
      const provider = new CopilotCliProvider();
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        return s.endsWith('/copilot') || s.includes('.github');
      });

      // Simulate existing user hooks
      const existingConfig = {
        version: 1,
        hooks: {
          preToolUse: [{ bash: 'echo "user pre-tool hook"', timeoutSec: 10 }],
          customEvent: [{ bash: 'echo "custom"' }],
        },
      };
      vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify(existingConfig));

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.version).toBe(1);
      // preToolUse should have user entry + our entry
      expect(written.hooks.preToolUse).toHaveLength(2);
      expect(written.hooks.preToolUse[0].bash).toBe('echo "user pre-tool hook"');
      expect(written.hooks.preToolUse[1].bash).toContain('CLUBHOUSE_AGENT_ID');
      // Custom event preserved
      expect(written.hooks.customEvent).toHaveLength(1);
    });

    it('CopilotCli: handles missing config file gracefully', async () => {
      const provider = new CopilotCliProvider();
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        return s.endsWith('/copilot') || s.includes('.github');
      });
      // readFileSync throws (no existing file)
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(written.version).toBe(1);
      expect(written.hooks.preToolUse).toHaveLength(1);
      expect(written.hooks.preToolUse[0].bash).toContain('CLUBHOUSE_AGENT_ID');
    });
  });

  describe('getModelOptions', () => {
    it('CopilotCli: falls back to static list when binary not found', async () => {
      const provider = new CopilotCliProvider();
      const options = await provider.getModelOptions();
      const ids = options.map(o => o.id);
      expect(ids).toContain('default');
      expect(ids).toContain('claude-sonnet-4.5');
      expect(ids).toContain('gpt-5');
    });

    it('OpenCode: falls back to default when binary not found', async () => {
      const provider = new OpenCodeProvider();
      const options = await provider.getModelOptions();
      expect(options).toEqual([{ id: 'default', label: 'Default' }]);
    });

    it('ClaudeCode: falls back to static list when binary not found', async () => {
      const provider = new ClaudeCodeProvider();
      const options = await provider.getModelOptions();
      const ids = options.map(o => o.id);
      expect(ids).toContain('default');
      expect(ids).toContain('opus');
      expect(ids).toContain('sonnet');
      expect(ids).toContain('haiku');
    });
  });
});
