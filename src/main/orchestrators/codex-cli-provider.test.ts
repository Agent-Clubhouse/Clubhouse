import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => { throw new Error('not found'); }),
  execFile: vi.fn((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    // Support --version for checkAvailability validation
    if (args && args[0] === '--version') {
      return cb(null, '1.0.0', '');
    }
    return cb(new Error('not found'), '', '');
  }),
}));

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({
    PATH: `/usr/local/bin${path.delimiter}/usr/bin`,
    OPENAI_API_KEY: 'sk-test-key',
  })),
}));

import * as fs from 'fs';
import * as childProcess from 'child_process';
import { getShellEnvironment } from '../util/shell';
import { CodexCliProvider } from './codex-cli-provider';

/** Match any path whose basename is 'codex' (with or without .exe/.cmd) */
function isCodexPath(p: string | Buffer | URL): boolean {
  const base = path.basename(String(p));
  return base === 'codex' || base === 'codex.exe' || base === 'codex.cmd';
}

describe('CodexCliProvider', () => {
  let provider: CodexCliProvider;

  beforeEach(() => {
    provider = new CodexCliProvider();
    vi.clearAllMocks();
    // Default: binary found at standard path
    vi.mocked(fs.existsSync).mockImplementation((p) => isCodexPath(p as string));
  });

  describe('identity', () => {
    it('has correct id', () => {
      expect(provider.id).toBe('codex-cli');
    });

    it('has correct displayName', () => {
      expect(provider.displayName).toBe('Codex CLI');
    });

    it('has correct shortName', () => {
      expect(provider.shortName).toBe('CX');
    });

    it('has Beta badge', () => {
      expect(provider.badge).toBe('Beta');
    });
  });

  describe('conventions', () => {
    it('uses .codex config dir', () => {
      expect(provider.conventions.configDir).toBe('.codex');
    });

    it('uses AGENTS.md for local instructions', () => {
      expect(provider.conventions.localInstructionsFile).toBe('AGENTS.md');
    });

    it('uses AGENTS.md as legacy instructions', () => {
      expect(provider.conventions.legacyInstructionsFile).toBe('AGENTS.md');
    });

    it('uses .codex/config.toml for MCP config', () => {
      expect(provider.conventions.mcpConfigFile).toBe('.codex/config.toml');
    });

    it('uses skills dir', () => {
      expect(provider.conventions.skillsDir).toBe('skills');
    });

    it('uses agents dir for templates', () => {
      expect(provider.conventions.agentTemplatesDir).toBe('agents');
    });

    it('uses config.toml for local settings', () => {
      expect(provider.conventions.localSettingsFile).toBe('config.toml');
    });
  });

  describe('getCapabilities', () => {
    it('supports headless mode', () => {
      expect(provider.getCapabilities().headless).toBe(true);
    });

    it('does not support structured output', () => {
      expect(provider.getCapabilities().structuredOutput).toBe(false);
    });

    it('does not support hooks', () => {
      expect(provider.getCapabilities().hooks).toBe(false);
    });

    it('supports session resume', () => {
      expect(provider.getCapabilities().sessionResume).toBe(true);
    });

    it('supports permissions via sandbox modes', () => {
      expect(provider.getCapabilities().permissions).toBe(true);
    });

    it('returns object with all required keys', () => {
      const caps = provider.getCapabilities();
      expect(typeof caps.headless).toBe('boolean');
      expect(typeof caps.structuredOutput).toBe('boolean');
      expect(typeof caps.hooks).toBe('boolean');
      expect(typeof caps.sessionResume).toBe('boolean');
      expect(typeof caps.permissions).toBe('boolean');
    });
  });

  describe('checkAvailability', () => {
    it('returns available when binary exists, runs, and API key is set', async () => {
      const result = await provider.checkAvailability();
      expect(result.available).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('returns error when binary not found', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await provider.checkAvailability();
      expect(result.available).toBe(false);
      expect(result.error).toMatch(/Could not find/);
    });

    it('error message includes binary name when not found', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await provider.checkAvailability();
      expect(result.error).toMatch(/codex/);
    });

    it('returns error when binary found but fails to execute', async () => {
      vi.mocked(childProcess.execFile).mockImplementation(
        (_cmd: string, _args: unknown, _opts: unknown, cb: any) => cb(new Error('exec failed'), '', '')
      );

      const result = await provider.checkAvailability();
      expect(result.available).toBe(false);
      expect(result.error).toMatch(/failed to execute/);
      expect(result.error).toMatch(/Reinstall/);
    });

    it('returns error when OPENAI_API_KEY is missing', async () => {
      vi.mocked(getShellEnvironment).mockReturnValue({
        PATH: `/usr/local/bin${path.delimiter}/usr/bin`,
      });

      const result = await provider.checkAvailability();
      expect(result.available).toBe(false);
      expect(result.error).toMatch(/OPENAI_API_KEY/);
    });

    it('passes shell environment to execFile for --version check', async () => {
      const mockEnv = {
        PATH: '/custom/path:/usr/bin',
        OPENAI_API_KEY: 'sk-test-key',
        HOME: '/home/user',
      };
      vi.mocked(getShellEnvironment).mockReturnValue(mockEnv);

      await provider.checkAvailability();

      // execFile is called with (binary, args, opts, cb) — verify opts.env
      const calls = vi.mocked(childProcess.execFile).mock.calls;
      const versionCall = calls.find((c) => (c[1] as string[])?.[0] === '--version');
      expect(versionCall).toBeDefined();
      const opts = versionCall![2] as Record<string, unknown>;
      expect(opts.env).toEqual(mockEnv);
    });

    it('accepts OPENAI_BASE_URL as alternative to OPENAI_API_KEY', async () => {
      vi.mocked(getShellEnvironment).mockReturnValue({
        PATH: `/usr/local/bin${path.delimiter}/usr/bin`,
        OPENAI_BASE_URL: 'https://custom-endpoint.com',
      });

      const result = await provider.checkAvailability();
      expect(result.available).toBe(true);
    });
  });

  describe('buildSpawnCommand', () => {
    it('returns binary path and empty args by default', async () => {
      const { binary, args } = await provider.buildSpawnCommand({ cwd: '/project' });
      expect(binary).toContain('codex');
      expect(args).toEqual([]);
    });

    it('adds --model flag for non-default model', async () => {
      const { args } = await provider.buildSpawnCommand({ cwd: '/p', model: 'gpt-5.3-codex' });
      expect(args).toContain('--model');
      expect(args).toContain('gpt-5.3-codex');
    });

    it('skips --model for default', async () => {
      const { args } = await provider.buildSpawnCommand({ cwd: '/p', model: 'default' });
      expect(args).not.toContain('--model');
    });

    it('skips --model when undefined', async () => {
      const { args } = await provider.buildSpawnCommand({ cwd: '/p' });
      expect(args).not.toContain('--model');
    });

    it('passes mission as last argument', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        mission: 'Fix the bug',
      });
      expect(args[args.length - 1]).toBe('Fix the bug');
    });

    it('combines system prompt and mission into a single argument', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        systemPrompt: 'Be concise',
        mission: 'Fix the bug',
      });
      const lastArg = args[args.length - 1];
      expect(lastArg).toContain('Be concise');
      expect(lastArg).toContain('Fix the bug');
      expect(lastArg).toBe('Be concise\n\nFix the bug');
    });

    it('passes system prompt alone when no mission', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        systemPrompt: 'Be concise',
      });
      expect(args[args.length - 1]).toBe('Be concise');
    });

    it('adds --full-auto when freeAgentMode is true', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        freeAgentMode: true,
      });
      expect(args).toContain('--full-auto');
    });

    it('does not add --full-auto when freeAgentMode is false', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        freeAgentMode: false,
      });
      expect(args).not.toContain('--full-auto');
    });

    it('does not add --full-auto when freeAgentMode is undefined', async () => {
      const { args } = await provider.buildSpawnCommand({ cwd: '/p' });
      expect(args).not.toContain('--full-auto');
    });

    it('places --full-auto before other flags', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        freeAgentMode: true,
        model: 'gpt-5.3-codex',
        mission: 'Fix bug',
      });
      expect(args[0]).toBe('--full-auto');
      expect(args).toContain('--model');
      expect(args[args.length - 1]).toBe('Fix bug');
    });

    it('combines all options correctly', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        model: 'gpt-5.2-codex',
        systemPrompt: 'Be careful',
        mission: 'Deploy it',
        freeAgentMode: true,
      });
      expect(args).toContain('--full-auto');
      expect(args).toContain('--model');
      expect(args).toContain('gpt-5.2-codex');
      expect(args[args.length - 1]).toBe('Be careful\n\nDeploy it');
    });

    it('does not add --dangerously-skip-permissions or --yolo', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        freeAgentMode: true,
      });
      expect(args).not.toContain('--dangerously-skip-permissions');
      expect(args).not.toContain('--yolo');
    });

    it('does not add --allowedTools or --allow-tool (Codex uses sandbox, not per-tool)', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        allowedTools: ['shell', 'apply_patch'],
      });
      expect(args).not.toContain('--allowedTools');
      expect(args).not.toContain('--allow-tool');
    });
  });

  describe('getExitCommand', () => {
    it('returns /exit with carriage return', () => {
      expect(provider.getExitCommand()).toBe('/exit\r');
    });
  });

  describe('writeHooksConfig', () => {
    it('is a no-op (does not write any files)', async () => {
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });
  });

  describe('parseHookEvent', () => {
    it('parses agent-turn-complete as stop', () => {
      const result = provider.parseHookEvent({
        type: 'agent-turn-complete',
        'last-assistant-message': 'Done. All tests pass.',
      });
      expect(result).toEqual({
        kind: 'stop',
        toolName: undefined,
        toolInput: undefined,
        message: 'Done. All tests pass.',
      });
    });

    it('parses agent-turn-complete without message', () => {
      const result = provider.parseHookEvent({
        type: 'agent-turn-complete',
      });
      expect(result).not.toBeNull();
      expect(result!.kind).toBe('stop');
      expect(result!.message).toBeUndefined();
    });

    it('returns null for unknown event types', () => {
      expect(provider.parseHookEvent({ type: 'unknown-event' })).toBeNull();
    });

    it('returns null for null input', () => {
      expect(provider.parseHookEvent(null)).toBeNull();
    });

    it('returns null for non-object input', () => {
      expect(provider.parseHookEvent('string')).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(provider.parseHookEvent(undefined)).toBeNull();
    });

    it('returns null for missing type field', () => {
      expect(provider.parseHookEvent({ message: 'hello' })).toBeNull();
    });

    it('returns null for empty object', () => {
      expect(provider.parseHookEvent({})).toBeNull();
    });
  });

  describe('readInstructions', () => {
    it('reads from AGENTS.md at project root', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('project instructions');
      const result = provider.readInstructions('/project');
      expect(result).toBe('project instructions');
      expect(fs.readFileSync).toHaveBeenCalledWith(path.join('/project', 'AGENTS.md'), 'utf-8');
    });

    it('returns empty string when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = provider.readInstructions('/project');
      expect(result).toBe('');
    });
  });

  describe('writeInstructions', () => {
    it('writes AGENTS.md at project root', () => {
      provider.writeInstructions('/project', 'new instructions');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.join('/project', 'AGENTS.md'),
        'new instructions',
        'utf-8'
      );
    });

    it('does not create subdirectories', () => {
      provider.writeInstructions('/project', 'test');
      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it('round-trip: write then read returns same content', () => {
      const content = 'My custom instructions\nWith multiple lines';
      provider.writeInstructions('/project', content);

      vi.mocked(fs.readFileSync).mockReturnValue(content);
      const result = provider.readInstructions('/project');
      expect(result).toBe(content);
    });
  });

  describe('buildHeadlessCommand', () => {
    it('generates exec command with --json and --full-auto', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/p',
        mission: 'Fix the auth bug',
      });

      expect(result).not.toBeNull();
      const { args } = result!;
      expect(args[0]).toBe('exec');
      expect(args[1]).toBe('Fix the auth bug');
      expect(args).toContain('--json');
      expect(args).toContain('--full-auto');
    });

    it('returns text outputKind', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/p',
        mission: 'Fix bug',
      });
      expect(result!.outputKind).toBe('text');
    });

    it('adds --model for non-default model', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/p',
        mission: 'Fix bug',
        model: 'gpt-5.3-codex',
      });
      expect(result!.args).toContain('--model');
      expect(result!.args[result!.args.indexOf('--model') + 1]).toBe('gpt-5.3-codex');
    });

    it('skips --model for default', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/p',
        mission: 'Fix bug',
        model: 'default',
      });
      expect(result!.args).not.toContain('--model');
    });

    it('combines system prompt and mission', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/p',
        mission: 'Fix the bug',
        systemPrompt: 'Be thorough',
      });
      expect(result!.args[1]).toBe('Be thorough\n\nFix the bug');
    });

    it('returns null when no mission provided', async () => {
      const result = await provider.buildHeadlessCommand({ cwd: '/p' });
      expect(result).toBeNull();
    });

    it('returns null when mission is empty string', async () => {
      const result = await provider.buildHeadlessCommand({ cwd: '/p', mission: '' });
      expect(result).toBeNull();
    });

    it('returns correct binary path', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/p',
        mission: 'test',
      });
      expect(result!.binary).toContain('codex');
    });

    it('does not include env overrides', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/p',
        mission: 'test',
      });
      expect(result!.env).toBeUndefined();
    });
  });

  describe('toolVerb', () => {
    it('returns verb for shell tool', () => {
      expect(provider.toolVerb('shell')).toBe('Running command');
    });

    it('returns verb for shell_command tool', () => {
      expect(provider.toolVerb('shell_command')).toBe('Running command');
    });

    it('returns verb for apply_patch tool', () => {
      expect(provider.toolVerb('apply_patch')).toBe('Editing file');
    });

    it('returns undefined for unknown tools', () => {
      expect(provider.toolVerb('UnknownTool')).toBeUndefined();
    });

    it('returns undefined for Claude Code tool names', () => {
      expect(provider.toolVerb('Bash')).toBeUndefined();
      expect(provider.toolVerb('Edit')).toBeUndefined();
      expect(provider.toolVerb('Read')).toBeUndefined();
    });
  });

  describe('getModelOptions', () => {
    it('returns fallback list including default and codex models', async () => {
      const options = await provider.getModelOptions();
      expect(options.length).toBeGreaterThanOrEqual(4);
      expect(options[0]).toEqual({ id: 'default', label: 'Default' });
      const ids = options.map(o => o.id);
      expect(ids).toContain('gpt-5.3-codex');
      expect(ids).toContain('gpt-5.2-codex');
      expect(ids).toContain('codex-mini-latest');
    });

    it('includes GPT 5 model', async () => {
      const options = await provider.getModelOptions();
      const ids = options.map(o => o.id);
      expect(ids).toContain('gpt-5');
    });

    it('first option is always default', async () => {
      const options = await provider.getModelOptions();
      expect(options[0].id).toBe('default');
      expect(options[0].label).toBe('Default');
    });

    it('passes shell environment to execFile for --help call', async () => {
      const mockEnv = {
        PATH: '/custom/path:/usr/bin',
        OPENAI_API_KEY: 'sk-test-key',
      };
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
    it('returns durable permissions with shell scoped to git/npm/npx', () => {
      const perms = provider.getDefaultPermissions('durable');
      expect(perms).toContain('shell(git:*)');
      expect(perms).toContain('shell(npm:*)');
      expect(perms).toContain('shell(npx:*)');
    });

    it('durable permissions do not include broad shell or apply_patch', () => {
      const perms = provider.getDefaultPermissions('durable');
      expect(perms).not.toContain('shell(*)');
      expect(perms).not.toContain('apply_patch');
    });

    it('returns quick permissions with shell and apply_patch', () => {
      const perms = provider.getDefaultPermissions('quick');
      expect(perms).toContain('shell(*)');
      expect(perms).toContain('apply_patch');
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

  describe('buildSummaryInstruction', () => {
    it('includes agent ID in the instruction', () => {
      const result = provider.buildSummaryInstruction('agent-codex-1');
      expect(result).toContain('clubhouse-summary-agent-codex-1.json');
    });

    it('specifies JSON format', () => {
      const result = provider.buildSummaryInstruction('test');
      expect(result).toContain('"summary"');
      expect(result).toContain('"filesModified"');
    });
  });

  describe('readQuickSummary', () => {
    it('delegates to shared implementation', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ summary: 'Fixed it', filesModified: ['src/index.ts'] })
      );
      const result = await provider.readQuickSummary('agent-1');
      expect(result).toEqual({
        summary: 'Fixed it',
        filesModified: ['src/index.ts'],
      });
    });

    it('returns null when no summary file', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = await provider.readQuickSummary('missing');
      expect(result).toBeNull();
    });
  });
});
