import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => { throw new Error('ENOENT'); }),
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isDirectory: () => true, birthtime: new Date('2026-04-01T10:00:00Z'), mtime: new Date('2026-04-01T12:00:00Z') })),
  realpath: vi.fn(async (p: string) => p),
  access: vi.fn(async () => { throw new Error('ENOENT'); }),
  readdir: vi.fn(async () => []),
  open: vi.fn(async () => { throw new Error('ENOENT'); }),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => { throw new Error('not found'); }),
  execFile: vi.fn((_cmd: string, args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
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
  invalidateShellEnvironmentCache: vi.fn(),
}));

vi.mock('../services/log-service', () => ({
  appLog: vi.fn(),
}));

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as childProcess from 'child_process';
import { getShellEnvironment, invalidateShellEnvironmentCache } from '../util/shell';
import { CodexCliProvider, parseCodexDebugModels } from './codex-cli-provider';

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

    it('supports hooks', () => {
      expect(provider.getCapabilities().hooks).toBe(true);
    });

    it('supports session resume', () => {
      expect(provider.getCapabilities().sessionResume).toBe(true);
    });

    it('supports permissions via sandbox modes', () => {
      expect(provider.getCapabilities().permissions).toBe(true);
    });

    it('reports structuredMode as true', () => {
      expect(provider.getCapabilities().structuredMode).toBe(true);
    });

    it('returns object with all required keys', () => {
      const caps = provider.getCapabilities();
      expect(typeof caps.headless).toBe('boolean');
      expect(typeof caps.structuredOutput).toBe('boolean');
      expect(typeof caps.hooks).toBe('boolean');
      expect(typeof caps.sessionResume).toBe('boolean');
      expect(typeof caps.permissions).toBe('boolean');
      expect(typeof caps.structuredMode).toBe('boolean');
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

    it('does not block when OPENAI_API_KEY is missing (delegates to binary)', async () => {
      vi.mocked(getShellEnvironment).mockReturnValue({
        PATH: `/usr/local/bin${path.delimiter}/usr/bin`,
      });

      const result = await provider.checkAvailability();
      expect(result.available).toBe(true);
    });

    it('invalidates shell env cache before checking', async () => {
      await provider.checkAvailability();
      expect(invalidateShellEnvironmentCache).toHaveBeenCalled();
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

    it('succeeds with OPENAI_BASE_URL and no OPENAI_API_KEY', async () => {
      vi.mocked(getShellEnvironment).mockReturnValue({
        PATH: `/usr/local/bin${path.delimiter}/usr/bin`,
        OPENAI_BASE_URL: 'https://custom-endpoint.com',
      });

      const result = await provider.checkAvailability();
      expect(result.available).toBe(true);
    });
  });

  describe('buildSpawnCommand — session resume', () => {
    it('resumes the most recent session with `resume --last` when no id is given', async () => {
      const { args } = await provider.buildSpawnCommand({ cwd: '/p', resume: true });
      expect(args.slice(0, 2)).toEqual(['resume', '--last']);
    });

    it('resumes a specific session by id instead of the most recent one', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p', resume: true, sessionId: '019fe8e8-3d42-7c12-8acd-23da607b445a',
      });
      // `codex resume [SESSION_ID] [PROMPT]` — the id is a positional, not a flag
      expect(args.slice(0, 2)).toEqual(['resume', '019fe8e8-3d42-7c12-8acd-23da607b445a']);
      expect(args).not.toContain('--last');
    });

    it('ignores sessionId when resume is not requested', async () => {
      const { args } = await provider.buildSpawnCommand({ cwd: '/p', sessionId: 'abc-123' });
      expect(args).not.toContain('resume');
      expect(args).not.toContain('abc-123');
    });

    it('keeps the prompt in trailingArgs so injected flags cannot displace it', async () => {
      const { args, trailingArgs } = await provider.buildSpawnCommand({
        cwd: '/p', resume: true, sessionId: 'sess-1', mission: 'keep going',
      });
      expect(args).not.toContain('keep going');
      expect(trailingArgs).toEqual(['keep going']);
    });
  });

  describe('buildSpawnCommand — permissionMode', () => {
    it('bypasses sandbox and approvals for skip-all', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p', freeAgentMode: true, permissionMode: 'skip-all',
      });
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
      // The bypass flag replaces the sandbox pair — passing both is contradictory
      expect(args).not.toContain('--sandbox');
      expect(args).not.toContain('--ask-for-approval');
    });

    it('sandboxes without prompting for auto', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p', freeAgentMode: true, permissionMode: 'auto',
      });
      expect(args).toEqual(['--sandbox', 'workspace-write', '--ask-for-approval', 'never']);
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    });

    it('defaults to the sandboxed pair when permissionMode is unset', async () => {
      const { args } = await provider.buildSpawnCommand({ cwd: '/p', freeAgentMode: true });
      expect(args).toEqual(['--sandbox', 'workspace-write', '--ask-for-approval', 'never']);
    });

    it('emits no autonomy flags when freeAgentMode is off, whatever the mode', async () => {
      const { args } = await provider.buildSpawnCommand({ cwd: '/p', permissionMode: 'skip-all' });
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(args).not.toContain('--sandbox');
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

    it('passes mission via trailingArgs, not args', async () => {
      const { args, trailingArgs } = await provider.buildSpawnCommand({
        cwd: '/p',
        mission: 'Fix the bug',
      });
      expect(args).not.toContain('Fix the bug');
      expect(trailingArgs).toEqual(['Fix the bug']);
    });

    it('combines system prompt and mission into a single trailing argument', async () => {
      const { trailingArgs } = await provider.buildSpawnCommand({
        cwd: '/p',
        systemPrompt: 'Be concise',
        mission: 'Fix the bug',
      });
      expect(trailingArgs).toEqual(['Be concise\n\nFix the bug']);
    });

    it('passes system prompt alone when no mission', async () => {
      const { trailingArgs } = await provider.buildSpawnCommand({
        cwd: '/p',
        systemPrompt: 'Be concise',
      });
      expect(trailingArgs).toEqual(['Be concise']);
    });

    it('returns no trailingArgs when neither mission nor systemPrompt is given', async () => {
      const { trailingArgs } = await provider.buildSpawnCommand({ cwd: '/p' });
      expect(trailingArgs).toEqual([]);
    });

    it('adds --sandbox workspace-write --ask-for-approval never when freeAgentMode is true', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        freeAgentMode: true,
      });
      expect(args).toContain('--sandbox');
      expect(args).toContain('workspace-write');
      expect(args).toContain('--ask-for-approval');
      expect(args).toContain('never');
    });

    it('does not add sandbox/approval flags when freeAgentMode is false', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        freeAgentMode: false,
      });
      expect(args).not.toContain('--sandbox');
      expect(args).not.toContain('--ask-for-approval');
    });

    it('does not add sandbox/approval flags when freeAgentMode is undefined', async () => {
      const { args } = await provider.buildSpawnCommand({ cwd: '/p' });
      expect(args).not.toContain('--sandbox');
      expect(args).not.toContain('--ask-for-approval');
    });

    it('places --sandbox before other flags', async () => {
      const { args, trailingArgs } = await provider.buildSpawnCommand({
        cwd: '/p',
        freeAgentMode: true,
        model: 'gpt-5.3-codex',
        mission: 'Fix bug',
      });
      expect(args[0]).toBe('--sandbox');
      expect(args).toContain('--model');
      expect(trailingArgs).toEqual(['Fix bug']);
    });

    it('combines all options correctly', async () => {
      const { args, trailingArgs } = await provider.buildSpawnCommand({
        cwd: '/p',
        model: 'gpt-5.2-codex',
        systemPrompt: 'Be careful',
        mission: 'Deploy it',
        freeAgentMode: true,
      });
      expect(args).toContain('--sandbox');
      expect(args).toContain('workspace-write');
      expect(args).toContain('--model');
      expect(args).toContain('gpt-5.2-codex');
      expect(trailingArgs).toEqual(['Be careful\n\nDeploy it']);
    });

    it('places buildMcpArgs output ahead of trailingArgs so the mission stays the final positional', async () => {
      const { args, trailingArgs } = await provider.buildSpawnCommand({
        cwd: '/p',
        freeAgentMode: true,
        model: 'gpt-5.3-codex',
        mission: 'Fix bug',
      });
      const mcpArgs = provider.buildMcpArgs({
        command: 'node',
        args: ['server.js'],
        env: { CLUBHOUSE_MCP_PORT: '12345' },
      });
      const finalArgs = [...args, ...mcpArgs, ...(trailingArgs ?? [])];
      expect(finalArgs[finalArgs.length - 1]).toBe('Fix bug');
      expect(finalArgs.indexOf('-c')).toBeLessThan(finalArgs.length - 1);
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

    it('passes OPENAI_API_KEY through env when available', async () => {
      vi.mocked(getShellEnvironment).mockReturnValue({
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'sk-test-key',
      });
      const { env } = await provider.buildSpawnCommand({ cwd: '/p' });
      expect(env).toBeDefined();
      expect(env!.OPENAI_API_KEY).toBe('sk-test-key');
    });

    it('passes OPENAI_BASE_URL through env when available', async () => {
      vi.mocked(getShellEnvironment).mockReturnValue({
        PATH: '/usr/bin',
        OPENAI_BASE_URL: 'https://custom.example.com',
      });
      const { env } = await provider.buildSpawnCommand({ cwd: '/p' });
      expect(env).toBeDefined();
      expect(env!.OPENAI_BASE_URL).toBe('https://custom.example.com');
    });

    it('returns empty env when no API keys in shell environment', async () => {
      vi.mocked(getShellEnvironment).mockReturnValue({
        PATH: '/usr/bin',
      });
      const { env } = await provider.buildSpawnCommand({ cwd: '/p' });
      expect(env).toBeDefined();
      expect(env!.OPENAI_API_KEY).toBeUndefined();
      expect(env!.OPENAI_BASE_URL).toBeUndefined();
    });
  });

  describe('getExitCommand', () => {
    it('returns /exit with carriage return', () => {
      expect(provider.getExitCommand()).toBe('/exit\r');
    });
  });

  describe('readInstructions', () => {
    it('reads from AGENTS.md at project root', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('project instructions');
      const result = await provider.readInstructions('/project');
      expect(result).toBe('project instructions');
      expect(fsp.readFile).toHaveBeenCalledWith(path.join('/project', 'AGENTS.md'), 'utf-8');
    });

    it('returns empty string when file does not exist', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      const result = await provider.readInstructions('/project');
      expect(result).toBe('');
    });
  });

  describe('writeInstructions', () => {
    it('writes AGENTS.md at project root', async () => {
      await provider.writeInstructions('/project', 'new instructions');

      expect(fsp.mkdir).toHaveBeenCalledWith(
        path.join('/project'),
        { recursive: true }
      );
      expect(fsp.writeFile).toHaveBeenCalledWith(
        path.join('/project', 'AGENTS.md'),
        'new instructions',
        'utf-8'
      );
    });

    it('round-trip: write then read returns same content', async () => {
      const content = 'My custom instructions\nWith multiple lines';
      await provider.writeInstructions('/project', content);

      vi.mocked(fsp.readFile).mockResolvedValue(content);
      const result = await provider.readInstructions('/project');
      expect(result).toBe(content);
    });
  });

  describe('buildHeadlessCommand — session resume', () => {
    it('continues the most recent thread via the `exec resume` subcommand', async () => {
      const { args } = (await provider.buildHeadlessCommand({
        cwd: '/p', mission: 'and now the tests', resume: true,
      }))!;
      expect(args.slice(0, 4)).toEqual(['exec', 'resume', '--last', 'and now the tests']);
      expect(args).toContain('--json');
    });

    it('resumes a specific thread by id', async () => {
      const { args } = (await provider.buildHeadlessCommand({
        cwd: '/p', mission: 'and now the tests', resume: true, sessionId: 'thread-7',
      }))!;
      expect(args.slice(0, 4)).toEqual(['exec', 'resume', 'thread-7', 'and now the tests']);
    });

    it('omits --sandbox on the resume path — `codex exec resume` rejects it', async () => {
      const { args } = (await provider.buildHeadlessCommand({
        cwd: '/p', mission: 'go on', resume: true,
      }))!;
      expect(args).not.toContain('--sandbox');
      expect(args).not.toContain('--ask-for-approval');
    });

    it('never emits --continue, which Codex removed', async () => {
      const { args } = (await provider.buildHeadlessCommand({
        cwd: '/p', mission: 'go on', resume: true,
      }))!;
      expect(args).not.toContain('--continue');
    });

    it('carries the bypass flag onto the resume path, which does accept it', async () => {
      const { args } = (await provider.buildHeadlessCommand({
        cwd: '/p', mission: 'go on', resume: true, permissionMode: 'skip-all',
      }))!;
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(args).not.toContain('--sandbox');
    });

    it('starts a fresh exec when resume is not requested', async () => {
      const { args } = (await provider.buildHeadlessCommand({ cwd: '/p', mission: 'start' }))!;
      expect(args[0]).toBe('exec');
      expect(args).not.toContain('resume');
    });
  });

  describe('buildHeadlessCommand — permissionMode', () => {
    it('bypasses the sandbox for skip-all', async () => {
      const { args } = (await provider.buildHeadlessCommand({
        cwd: '/p', mission: 'ship it', permissionMode: 'skip-all',
      }))!;
      expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(args).not.toContain('--sandbox');
    });

    it('sandboxes for auto', async () => {
      const { args } = (await provider.buildHeadlessCommand({
        cwd: '/p', mission: 'ship it', permissionMode: 'auto',
      }))!;
      expect(args).toContain('--sandbox');
      expect(args).toContain('workspace-write');
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    });
  });

  describe('buildHeadlessCommand', () => {
    it('generates exec command with --json and --sandbox workspace-write', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/p',
        mission: 'Fix the auth bug',
      });

      expect(result).not.toBeNull();
      const { args } = result!;
      expect(args[0]).toBe('exec');
      expect(args[1]).toBe('Fix the auth bug');
      expect(args).toContain('--json');
      expect(args).toContain('--sandbox');
      expect(args).toContain('workspace-write');
    });

    it('returns stream-json outputKind for JSONL parsing', async () => {
      const result = await provider.buildHeadlessCommand({
        cwd: '/p',
        mission: 'Fix bug',
      });
      expect(result!.outputKind).toBe('stream-json');
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

    it('passes OPENAI_API_KEY through env when available', async () => {
      vi.mocked(getShellEnvironment).mockReturnValue({
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'sk-test-key',
      });
      const result = await provider.buildHeadlessCommand({
        cwd: '/p',
        mission: 'test',
      });
      expect(result!.env).toBeDefined();
      expect(result!.env!.OPENAI_API_KEY).toBe('sk-test-key');
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

  describe('buildMcpArgs', () => {
    const mockServerDef = {
      type: 'stdio',
      command: 'node',
      args: ['/mock/bridge.js'],
      env: { CLUBHOUSE_MCP_PORT: '12345', CLUBHOUSE_AGENT_ID: 'agent-1', CLUBHOUSE_HOOK_NONCE: 'nonce-1' },
    };

    it('returns -c flags for command', () => {
      const args = provider.buildMcpArgs(mockServerDef);
      expect(args).toContain('-c');
      const commandArg = args.find(a => a.includes('mcp_servers.clubhouse.command='));
      expect(commandArg).toBeDefined();
      expect(commandArg).toContain('"node"');
    });

    it('returns -c flags for args array', () => {
      const args = provider.buildMcpArgs(mockServerDef);
      const argsArg = args.find(a => a.includes('mcp_servers.clubhouse.args='));
      expect(argsArg).toBeDefined();
      expect(argsArg).toContain('"/mock/bridge.js"');
    });

    it('returns -c flags for each env var', () => {
      const args = provider.buildMcpArgs(mockServerDef);
      const portArg = args.find(a => a.includes('mcp_servers.clubhouse.env.CLUBHOUSE_MCP_PORT='));
      expect(portArg).toBeDefined();
      expect(portArg).toContain('"12345"');

      const agentArg = args.find(a => a.includes('mcp_servers.clubhouse.env.CLUBHOUSE_AGENT_ID='));
      expect(agentArg).toBeDefined();
      expect(agentArg).toContain('"agent-1"');
    });

    it('all -c flags are paired', () => {
      const args = provider.buildMcpArgs(mockServerDef);
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-c') {
          expect(args[i + 1]).toBeDefined();
          expect(args[i + 1]).toContain('mcp_servers.clubhouse');
        }
      }
    });

    it('handles server with no args', () => {
      const args = provider.buildMcpArgs({ command: 'node' });
      expect(args.some(a => a.includes('.args='))).toBe(false);
    });

    it('handles server with no env', () => {
      const args = provider.buildMcpArgs({ command: 'node' });
      expect(args.some(a => a.includes('.env.'))).toBe(false);
    });
  });

  describe('createStructuredAdapter', () => {
    it('returns a StructuredAdapter with required methods', () => {
      const adapter = provider.createStructuredAdapter();
      expect(adapter).toBeDefined();
      expect(typeof adapter.start).toBe('function');
      expect(typeof adapter.sendMessage).toBe('function');
      expect(typeof adapter.respondToPermission).toBe('function');
      expect(typeof adapter.cancel).toBe('function');
      expect(typeof adapter.dispose).toBe('function');
    });
  });

  describe('parseCodexDebugModels', () => {
    // Trimmed from real `codex debug models` output (codex-cli 0.153.4).
    const REAL_OUTPUT = JSON.stringify({
      models: [
        { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 1 },
        { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 3 },
        { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', priority: 6 },
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 12 },
        { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 43 },
      ],
    });

    it('maps slug/display_name and prepends default', () => {
      const parsed = parseCodexDebugModels(REAL_OUTPUT);
      expect(parsed).not.toBeNull();
      expect(parsed![0]).toEqual({ id: 'default', label: 'Default' });
      expect(parsed![1]).toEqual({ id: 'gpt-6-astra', label: 'GPT-6-Astra' });
    });

    it('excludes models Codex hides from its own picker', () => {
      const ids = parseCodexDebugModels(REAL_OUTPUT)!.map((m) => m.id);
      expect(ids).not.toContain('gpt-reserve');
      expect(ids).not.toContain('codex-auto-review');
    });

    it('orders by catalog priority ascending', () => {
      const ids = parseCodexDebugModels(REAL_OUTPUT)!.map((m) => m.id);
      expect(ids).toEqual(['default', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5']);
    });

    it('treats a missing visibility as listable so a schema change cannot empty the menu', () => {
      const parsed = parseCodexDebugModels(JSON.stringify({
        models: [{ slug: 'gpt-future', display_name: 'GPT Future', priority: 2 }],
      }));
      expect(parsed!.map((m) => m.id)).toContain('gpt-future');
    });

    it('falls back to the slug when display_name is absent', () => {
      const parsed = parseCodexDebugModels(JSON.stringify({
        models: [{ slug: 'gpt-nameless', visibility: 'list', priority: 1 }],
      }));
      expect(parsed![1]).toEqual({ id: 'gpt-nameless', label: 'gpt-nameless' });
    });

    it('returns null for unparseable or unexpected output', () => {
      expect(parseCodexDebugModels('')).toBeNull();
      expect(parseCodexDebugModels('not json')).toBeNull();
      expect(parseCodexDebugModels('{}')).toBeNull();
      expect(parseCodexDebugModels(JSON.stringify({ models: 'nope' }))).toBeNull();
      expect(parseCodexDebugModels(JSON.stringify({ models: [] }))).toBeNull();
      // All entries hidden → nothing to show → fall back rather than render empty
      expect(parseCodexDebugModels(JSON.stringify({
        models: [{ slug: 'x', visibility: 'hide' }],
      }))).toBeNull();
    });
  });

  describe('getModelOptions', () => {
    it('queries `codex debug models`, not the --help text', async () => {
      await provider.getModelOptions();
      const calls = vi.mocked(childProcess.execFile).mock.calls;
      const modelCall = calls.find((c) => (c[1] as string[])?.[0] === 'debug');
      expect(modelCall).toBeDefined();
      expect(modelCall![1]).toEqual(['debug', 'models']);
    });

    it('falls back to a static list when the query fails', async () => {
      const options = await provider.getModelOptions();
      expect(options[0]).toEqual({ id: 'default', label: 'Default' });
      // The fallback must only name models that actually exist in the catalog
      // this provider was verified against (codex-cli 0.153.4).
      const ids = options.map(o => o.id);
      expect(ids).toContain('gpt-5.6-sol');
      expect(ids).not.toContain('codex-mini-latest');
    });

    it('first option is always default', async () => {
      const options = await provider.getModelOptions();
      expect(options[0].id).toBe('default');
      expect(options[0].label).toBe('Default');
    });

    it('passes shell environment to execFile for the model query', async () => {
      const mockEnv = {
        PATH: '/custom/path:/usr/bin',
        OPENAI_API_KEY: 'sk-test-key',
      };
      vi.mocked(getShellEnvironment).mockReturnValue(mockEnv);

      await provider.getModelOptions();

      const calls = vi.mocked(childProcess.execFile).mock.calls;
      const modelCall = calls.find((c) => (c[1] as string[])?.[0] === 'debug');
      expect(modelCall).toBeDefined();
      const opts = modelCall![2] as Record<string, unknown>;
      expect(opts.env).toEqual(mockEnv);
    });
  });

  describe('writeHooksConfig', () => {
    it('creates .codex dir and writes hooks.json', async () => {
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      expect(fsp.mkdir).toHaveBeenCalledWith(
        path.join('/project', '.codex'),
        { recursive: true },
      );
      const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
      const hookCall = writeCalls.find(c => String(c[0]).includes('hooks.json'));
      expect(hookCall).toBeDefined();
      const written = JSON.parse(hookCall![1] as string);
      expect(written.hooks).toBeDefined();
      expect(written.hooks.PreToolUse).toBeDefined();
      expect(written.hooks.PostToolUse).toBeDefined();
      expect(written.hooks.Stop).toBeDefined();
      expect(written.hooks.PermissionRequest).toBeDefined();
    });

    it('curl command uses env var references for agent ID and nonce', async () => {
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');
      const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
      const hookCall = writeCalls.find(c => String(c[0]).includes('hooks.json'));
      const written = JSON.parse(hookCall![1] as string);
      const command = written.hooks.PreToolUse[0].hooks[0].command as string;
      expect(command).toContain(
        process.platform === 'win32' ? '%CLUBHOUSE_AGENT_ID%' : '${CLUBHOUSE_AGENT_ID}',
      );
      expect(command).toContain(
        process.platform === 'win32' ? '%CLUBHOUSE_HOOK_NONCE%' : '${CLUBHOUSE_HOOK_NONCE}',
      );
    });

    it('PermissionRequest has 120s timeout', async () => {
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');
      const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
      const hookCall = writeCalls.find(c => String(c[0]).includes('hooks.json'));
      const written = JSON.parse(hookCall![1] as string);
      const permHook = written.hooks.PermissionRequest[0].hooks[0];
      expect(permHook.timeout).toBe(120);
      expect(permHook.async).toBeUndefined(); // sync for permission approval
    });

    it('standard hooks have async: true and 5s timeout', async () => {
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');
      const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
      const hookCall = writeCalls.find(c => String(c[0]).includes('hooks.json'));
      const written = JSON.parse(hookCall![1] as string);
      const preToolHook = written.hooks.PreToolUse[0].hooks[0];
      expect(preToolHook.async).toBe(true);
      expect(preToolHook.timeout).toBe(5);
    });

    it('merges with existing hooks.json', async () => {
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({
        customKey: 'preserved',
        hooks: { PreToolUse: [{ type: 'custom', command: 'echo user' }] },
      }));

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');
      const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
      const hookCall = writeCalls.find(c => String(c[0]).includes('hooks.json'));
      const written = JSON.parse(hookCall![1] as string);
      expect(written.customKey).toBe('preserved');
      // User hook preserved + our hook added
      expect(written.hooks.PreToolUse.length).toBe(2);
    });

    it('includes all 6 event types', async () => {
      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');
      const writeCalls = vi.mocked(fsp.writeFile).mock.calls;
      const hookCall = writeCalls.find(c => String(c[0]).includes('hooks.json'));
      const written = JSON.parse(hookCall![1] as string);
      const events = Object.keys(written.hooks);
      expect(events).toContain('PreToolUse');
      expect(events).toContain('PostToolUse');
      expect(events).toContain('PostToolUseFailure');
      expect(events).toContain('Stop');
      expect(events).toContain('Notification');
      expect(events).toContain('PermissionRequest');
    });
  });

  describe('parseHookEvent', () => {
    it('parses PreToolUse as pre_tool', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'PreToolUse',
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

    it('parses PostToolUse as post_tool', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'PostToolUse',
        tool_name: 'apply_patch',
      });
      expect(result).toEqual({
        kind: 'post_tool',
        toolName: 'apply_patch',
        toolInput: undefined,
        message: undefined,
      });
    });

    it('parses PostToolUseFailure as tool_error', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'shell',
        message: 'Command failed',
      });
      expect(result!.kind).toBe('tool_error');
      expect(result!.message).toBe('Command failed');
    });

    it('parses Stop as stop', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'Stop',
        message: 'Task complete',
      });
      expect(result).toEqual({
        kind: 'stop',
        toolName: undefined,
        toolInput: undefined,
        message: 'Task complete',
      });
    });

    it('parses PermissionRequest as permission_request', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'PermissionRequest',
        tool_name: 'shell',
        tool_input: { command: 'rm -rf /' },
      });
      expect(result!.kind).toBe('permission_request');
      expect(result!.toolName).toBe('shell');
    });

    it('parses Notification as notification', () => {
      const result = provider.parseHookEvent({
        hook_event_name: 'Notification',
        message: 'Something happened',
      });
      expect(result!.kind).toBe('notification');
      expect(result!.message).toBe('Something happened');
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

    it('returns null when hook_event_name is missing', () => {
      expect(provider.parseHookEvent({ tool_name: 'shell' })).toBeNull();
    });
  });

  /**
   * Stand up a virtual Codex session store over the fs/promises mock.
   *
   * `tree` maps a directory to its entries; `metaByFile` maps a rollout
   * filename to the `session_meta` record that opens it.  Paths are built with
   * path.join so the fixture matches the platform the test runs on — see the
   * Windows-path note in listSessions.
   */
  function mockCodexStore(
    sessionsDir: string,
    tree: Record<string, Array<{ name: string; dir: boolean }>>,
    metaByFile: Record<string, unknown>,
    mtimes: Record<string, string> = {},
  ) {
    vi.mocked(fsp.readdir).mockImplementation((async (dir: string) => {
      const entries = tree[dir];
      if (!entries) throw new Error('ENOENT');
      return entries.map((e) => ({
        name: e.name,
        isDirectory: () => e.dir,
        isFile: () => !e.dir,
      }));
    }) as never);

    vi.mocked(fsp.stat).mockImplementation((async (f: string) => ({
      isDirectory: () => false,
      birthtime: new Date('2026-01-01T00:00:00Z'),
      mtime: new Date(mtimes[path.basename(f)] ?? '2026-04-01T12:00:00Z'),
    })) as never);

    vi.mocked(fsp.open).mockImplementation((async (f: string) => {
      const meta = metaByFile[path.basename(f)];
      if (meta === undefined) throw new Error('ENOENT');
      const text = typeof meta === 'string' ? meta : JSON.stringify(meta) + '\n';
      return {
        read: async (buf: Buffer) => {
          const bytes = Buffer.from(text, 'utf-8');
          bytes.copy(buf);
          return { bytesRead: Math.min(bytes.length, buf.length) };
        },
        close: async () => {},
      };
    }) as never);

    return sessionsDir;
  }

  /** A rollout `session_meta` line as Codex actually writes it. */
  const rolloutMeta = (cwd: string, timestamp: string, id: string, legacy = false) => ({
    timestamp,
    type: 'session_meta',
    // Older Codex releases key the id as `payload.id`; newer ones add `session_id`.
    payload: legacy
      ? { id, timestamp, cwd, originator: 'codex_tui', cli_version: '0.153.4' }
      : { session_id: id, id, timestamp, cwd, originator: 'codex_tui', cli_version: '0.153.4' },
  });

  describe('listSessions', () => {
    // homePath() goes through the electron mock, which roots app paths in tmpdir
    const HOME = path.join(os.tmpdir(), 'clubhouse-test-home');
    const SESSIONS = path.join(HOME, '.codex', 'sessions');
    const PROJECT = path.join(path.sep, 'work', 'my-project');
    const OTHER = path.join(path.sep, 'work', 'other-project');

    const F1 = 'rollout-2026-09-05T17-28-00-01a0741d-6c83-7720-8fc2-6412909a95ab.jsonl';
    const F2 = 'rollout-2026-09-04T09-00-00-019cc073-4ae3-79c3-bc68-eef17cd515f9.jsonl';
    const F3 = 'rollout-2026-09-03T08-00-00-019d0eff-598f-7ce2-92f2-200d97c54271.jsonl';

    const datePartitionedTree = () => ({
      [SESSIONS]: [{ name: '2026', dir: true }],
      [path.join(SESSIONS, '2026')]: [{ name: '09', dir: true }],
      [path.join(SESSIONS, '2026', '09')]: [
        { name: '05', dir: true }, { name: '04', dir: true }, { name: '03', dir: true },
      ],
      [path.join(SESSIONS, '2026', '09', '05')]: [{ name: F1, dir: false }],
      [path.join(SESSIONS, '2026', '09', '04')]: [{ name: F2, dir: false }],
      [path.join(SESSIONS, '2026', '09', '03')]: [{ name: F3, dir: false }],
    });

    it('finds sessions in the date-partitioned rollout store', async () => {
      mockCodexStore(SESSIONS, datePartitionedTree(), {
        [F1]: rolloutMeta(PROJECT, '2026-09-05T17:28:00.000Z', '01a0741d-6c83-7720-8fc2-6412909a95ab'),
        [F2]: rolloutMeta(PROJECT, '2026-09-04T09:00:00.000Z', '019cc073-4ae3-79c3-bc68-eef17cd515f9', true),
        [F3]: rolloutMeta(PROJECT, '2026-09-03T08:00:00.000Z', '019d0eff-598f-7ce2-92f2-200d97c54271'),
      });

      const sessions = await provider.listSessions(PROJECT);
      expect(sessions.map((s) => s.sessionId)).toEqual([
        '01a0741d-6c83-7720-8fc2-6412909a95ab',
        '019cc073-4ae3-79c3-bc68-eef17cd515f9',
        '019d0eff-598f-7ce2-92f2-200d97c54271',
      ]);
    });

    it('takes the session id from the filename, including legacy metadata', async () => {
      mockCodexStore(SESSIONS, datePartitionedTree(), {
        // Legacy record: payload.id only, no session_id
        [F2]: rolloutMeta(PROJECT, '2026-09-04T09:00:00.000Z', '019cc073-4ae3-79c3-bc68-eef17cd515f9', true),
      });

      const sessions = await provider.listSessions(PROJECT);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('019cc073-4ae3-79c3-bc68-eef17cd515f9');
    });

    it('excludes sessions recorded against a different project', async () => {
      mockCodexStore(SESSIONS, datePartitionedTree(), {
        [F1]: rolloutMeta(PROJECT, '2026-09-05T17:28:00.000Z', '01a0741d-6c83-7720-8fc2-6412909a95ab'),
        [F2]: rolloutMeta(OTHER, '2026-09-04T09:00:00.000Z', '019cc073-4ae3-79c3-bc68-eef17cd515f9'),
      });

      const sessions = await provider.listSessions(PROJECT);
      expect(sessions.map((s) => s.sessionId)).toEqual(['01a0741d-6c83-7720-8fc2-6412909a95ab']);
    });

    it('skips a rollout whose metadata has no cwd rather than showing it everywhere', async () => {
      mockCodexStore(SESSIONS, datePartitionedTree(), {
        [F1]: { timestamp: 'x', type: 'session_meta', payload: { id: 'no-cwd' } },
      });
      expect(await provider.listSessions(PROJECT)).toEqual([]);
    });

    it('reports recorded start time and file mtime as last activity', async () => {
      mockCodexStore(SESSIONS, datePartitionedTree(), {
        [F1]: rolloutMeta(PROJECT, '2026-09-05T17:28:00.000Z', '01a0741d-6c83-7720-8fc2-6412909a95ab'),
      }, { [F1]: '2026-09-05T19:00:00Z' });

      const [session] = await provider.listSessions(PROJECT);
      expect(session.startedAt).toBe('2026-09-05T17:28:00.000Z');
      expect(session.lastActiveAt).toBe('2026-09-05T19:00:00.000Z');
    });

    it('sorts by most recently active first', async () => {
      mockCodexStore(SESSIONS, datePartitionedTree(), {
        [F1]: rolloutMeta(PROJECT, '2026-09-05T17:28:00.000Z', '01a0741d-6c83-7720-8fc2-6412909a95ab'),
        [F3]: rolloutMeta(PROJECT, '2026-09-03T08:00:00.000Z', '019d0eff-598f-7ce2-92f2-200d97c54271'),
      }, {
        [F1]: '2026-09-05T10:00:00Z',
        [F3]: '2026-09-09T10:00:00Z',   // touched later despite the older name
      });

      const sessions = await provider.listSessions(PROJECT);
      expect(sessions[0].sessionId).toBe('019d0eff-598f-7ce2-92f2-200d97c54271');
    });

    it('honours CODEX_HOME from a profile instead of the default store', async () => {
      const profileHome = path.join(path.sep, 'profiles', 'agent-a', '.codex');
      const profileSessions = path.join(profileHome, 'sessions');
      mockCodexStore(profileSessions, {
        [profileSessions]: [{ name: '2026', dir: true }],
        [path.join(profileSessions, '2026')]: [{ name: '09', dir: true }],
        [path.join(profileSessions, '2026', '09')]: [{ name: '05', dir: true }],
        [path.join(profileSessions, '2026', '09', '05')]: [{ name: F1, dir: false }],
      }, {
        [F1]: rolloutMeta(PROJECT, '2026-09-05T17:28:00.000Z', '01a0741d-6c83-7720-8fc2-6412909a95ab'),
      });

      const sessions = await provider.listSessions(PROJECT, { CODEX_HOME: profileHome });
      expect(sessions).toHaveLength(1);
      // The default store must not have been consulted
      expect(vi.mocked(fsp.readdir)).not.toHaveBeenCalledWith(SESSIONS, expect.anything());
    });

    it('ignores files that are not rollouts', async () => {
      mockCodexStore(SESSIONS, {
        [SESSIONS]: [
          { name: 'notes.txt', dir: false },
          { name: 'rollout-bogus.jsonl', dir: false },
        ],
      }, {});
      expect(await provider.listSessions(PROJECT)).toEqual([]);
    });

    it('returns empty when the store does not exist', async () => {
      mockCodexStore(SESSIONS, {}, {});
      expect(await provider.listSessions(PROJECT)).toEqual([]);
    });
  });

  describe('readSessionTranscript', () => {
    const HOME = path.join(os.tmpdir(), 'clubhouse-test-home');
    const SESSIONS = path.join(HOME, '.codex', 'sessions');
    const ID = '01a0741d-6c83-7720-8fc2-6412909a95ab';
    const FILE = `rollout-2026-09-05T17-28-00-${ID}.jsonl`;

    beforeEach(() => {
      vi.mocked(fsp.readdir).mockImplementation((async (dir: string) => {
        const tree: Record<string, Array<{ name: string; dir: boolean }>> = {
          [SESSIONS]: [{ name: '2026', dir: true }],
          [path.join(SESSIONS, '2026')]: [{ name: '09', dir: true }],
          [path.join(SESSIONS, '2026', '09')]: [{ name: '05', dir: true }],
          [path.join(SESSIONS, '2026', '09', '05')]: [{ name: FILE, dir: false }],
        };
        const entries = tree[dir];
        if (!entries) throw new Error('ENOENT');
        return entries.map((e) => ({ name: e.name, isDirectory: () => e.dir, isFile: () => !e.dir }));
      }) as never);
    });

    it('locates the rollout by the session id in its filename', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(
        '{"type":"assistant","message":{"role":"assistant"}}\n' as never,
      );
      const events = await provider.readSessionTranscript(ID, '/any');
      expect(events).not.toBeNull();
      expect(vi.mocked(fsp.readFile)).toHaveBeenCalledWith(
        path.join(SESSIONS, '2026', '09', '05', FILE),
        'utf-8',
      );
    });

    it('returns null for a session id with no matching rollout', async () => {
      expect(await provider.readSessionTranscript('does-not-exist', '/any')).toBeNull();
    });

    it('reads from the profile store when CODEX_HOME is set', async () => {
      const profileHome = path.join(path.sep, 'profiles', 'agent-a', '.codex');
      vi.mocked(fsp.readdir).mockImplementation((async () => { throw new Error('ENOENT'); }) as never);
      expect(await provider.readSessionTranscript(ID, '/any', { CODEX_HOME: profileHome })).toBeNull();
      expect(vi.mocked(fsp.readdir)).toHaveBeenCalledWith(
        path.join(profileHome, 'sessions'),
        expect.anything(),
      );
    });
  });

  describe('extractSessionId', () => {
    it('extracts thread_ prefixed IDs', () => {
      const buffer = 'Starting session thread_abc123def456ghij in workspace...';
      expect(provider.extractSessionId(buffer)).toBe('abc123def456ghij');
    });

    it('extracts UUID after thread: label', () => {
      const buffer = 'thread: a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      expect(provider.extractSessionId(buffer)).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    });

    it('extracts UUID after session: label', () => {
      const buffer = 'session: a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      expect(provider.extractSessionId(buffer)).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    });

    it('extracts UUID after resume: label', () => {
      const buffer = 'resume: a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      expect(provider.extractSessionId(buffer)).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    });

    it('returns null when no recognizable ID found', () => {
      expect(provider.extractSessionId('Welcome to Codex CLI')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(provider.extractSessionId('')).toBeNull();
    });

    it('prefers thread_ prefix over UUID patterns', () => {
      const buffer = 'thread_longthreadidentifier session: a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      expect(provider.extractSessionId(buffer)).toBe('longthreadidentifier');
    });
  });

  describe('SessionCapable type guard', () => {
    it('isSessionCapable returns true', async () => {
      const { isSessionCapable } = await import('./types');
      expect(isSessionCapable(provider)).toBe(true);
    });

    it('has listSessions method', () => {
      expect(typeof provider.listSessions).toBe('function');
    });

    it('has readSessionTranscript method', () => {
      expect(typeof provider.readSessionTranscript).toBe('function');
    });

    it('has extractSessionId method', () => {
      expect(typeof provider.extractSessionId).toBe('function');
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

});
