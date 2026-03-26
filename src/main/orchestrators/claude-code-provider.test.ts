import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => { throw new Error('ENOENT'); }),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => { throw new Error('not found'); }),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => cb(new Error('not found'), '', '')),
}));

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: `/usr/local/bin${path.delimiter}/usr/bin` })),
}));

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { ClaudeCodeProvider } from './claude-code-provider';

/** Match any path whose basename is 'claude' (with or without .exe/.cmd) */
function isClaudePath(p: string | Buffer | URL): boolean {
  const base = path.basename(String(p));
  return base === 'claude' || base === 'claude.exe' || base === 'claude.cmd';
}

describe('ClaudeCodeProvider', () => {
  let provider: ClaudeCodeProvider;

  beforeEach(() => {
    provider = new ClaudeCodeProvider();
    vi.clearAllMocks();
    // Default: binary found at standard path
    vi.mocked(fs.existsSync).mockImplementation((p) => isClaudePath(p as string));
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

    it('uses CLAUDE.md for local instructions', () => {
      expect(provider.conventions.localInstructionsFile).toBe('CLAUDE.md');
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

    it('passes shell option to execFile on Windows for .cmd compatibility', async () => {
      const { execFile } = await import('child_process');
      vi.mocked(execFile).mockImplementation(
        (_cmd: any, _args: any, opts: any, cb: any) => {
          // Verify shell option matches platform
          if (process.platform === 'win32') {
            expect(opts.shell).toBe(true);
          }
          cb(null, '{}', '');
          return {} as any;
        }
      );
      await provider.checkAvailability();
    });

    it('passes shell environment to execFile for auth check', async () => {
      const { execFile } = await import('child_process');
      const { getShellEnvironment } = await import('../util/shell');
      const mockEnv = { PATH: '/custom/path:/usr/bin', HOME: '/home/user' };
      vi.mocked(getShellEnvironment).mockReturnValue(mockEnv);
      vi.mocked(execFile).mockImplementation(
        (_cmd: any, _args: any, opts: any, cb: any) => {
          expect(opts.env).toEqual(mockEnv);
          cb(null, '{}', '');
          return {} as any;
        }
      );
      await provider.checkAvailability();
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

    it('uses --permission-mode auto when freeAgentMode is true (default)', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        freeAgentMode: true,
      });
      expect(args).toContain('--permission-mode');
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('auto');
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('uses --dangerously-skip-permissions when freeAgentMode is true and permissionMode is skip-all', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        freeAgentMode: true,
        permissionMode: 'skip-all',
      });
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).not.toContain('--permission-mode');
    });

    it('does not add permission flags when freeAgentMode is false', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        freeAgentMode: false,
      });
      expect(args).not.toContain('--dangerously-skip-permissions');
      expect(args).not.toContain('--permission-mode');
    });

    it('does not add permission flags when freeAgentMode is undefined', async () => {
      const { args } = await provider.buildSpawnCommand({ cwd: '/p' });
      expect(args).not.toContain('--dangerously-skip-permissions');
      expect(args).not.toContain('--permission-mode');
    });

    it('places --permission-mode before other flags', async () => {
      const { args } = await provider.buildSpawnCommand({
        cwd: '/p',
        freeAgentMode: true,
        model: 'opus',
        mission: 'Fix bug',
      });
      expect(args[0]).toBe('--permission-mode');
      expect(args[1]).toBe('auto');
      expect(args).toContain('--model');
      expect(args[args.length - 1]).toBe('Fix bug');
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
    it('returns list including default, opus, sonnet, haiku', async () => {
      const options = await provider.getModelOptions();
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
        if (isClaudePath(p as string)) return true;
        return false;
      });

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      expect(fsp.mkdir).toHaveBeenCalledWith(
        path.join('/project', '.claude'),
        { recursive: true }
      );
      expect(fsp.writeFile).toHaveBeenCalled();
      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written.hooks).toBeDefined();
      expect(written.hooks.PreToolUse).toBeDefined();
      expect(written.hooks.Stop).toBeDefined();
    });

    it('curl command uses env var references for agent ID and nonce', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (isClaudePath(p as string)) return true;
        return false;
      });

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      const command = written.hooks.PreToolUse[0].hooks[0].command as string;
      if (process.platform === 'win32') {
        expect(command).toContain('%CLUBHOUSE_AGENT_ID%');
        expect(command).toContain('%CLUBHOUSE_HOOK_NONCE%');
      } else {
        expect(command).toContain('${CLUBHOUSE_AGENT_ID}');
        expect(command).toContain('${CLUBHOUSE_HOOK_NONCE}');
      }
      expect(command).not.toContain('/hook/agent-');
    });

    it('merges with existing settings', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ existingKey: 'value' }));

      await provider.writeHooksConfig('/project', 'http://127.0.0.1:9999/hook');

      const written = JSON.parse(vi.mocked(fsp.writeFile).mock.calls[0][1] as string);
      expect(written.existingKey).toBe('value');
      expect(written.hooks).toBeDefined();
    });
  });

  describe('readInstructions', () => {
    it('reads from CLAUDE.md at project root', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('project instructions');
      const result = await provider.readInstructions('/project');
      expect(result).toBe('project instructions');
      expect(fsp.readFile).toHaveBeenCalledWith(path.join('/project', 'CLAUDE.md'), 'utf-8');
    });

    it('returns empty string when file does not exist', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      const result = await provider.readInstructions('/project');
      expect(result).toBe('');
    });
  });

  describe('writeInstructions', () => {
    it('writes CLAUDE.md at project root', async () => {
      await provider.writeInstructions('/project', 'new instructions');

      expect(fsp.mkdir).toHaveBeenCalledWith(
        path.join('/project'),
        { recursive: true }
      );
      expect(fsp.writeFile).toHaveBeenCalledWith(
        path.join('/project', 'CLAUDE.md'),
        'new instructions',
        'utf-8'
      );
    });
  });

  describe('getCapabilities', () => {
    it('reports structuredMode as true', () => {
      expect(provider.getCapabilities().structuredMode).toBe(true);
    });
  });

  describe('createStructuredAdapter', () => {
    it('returns a StructuredAdapter with required methods', () => {
      const adapter = provider.createStructuredAdapter!();
      expect(adapter).toBeDefined();
      expect(typeof adapter.start).toBe('function');
      expect(typeof adapter.sendMessage).toBe('function');
      expect(typeof adapter.respondToPermission).toBe('function');
      expect(typeof adapter.cancel).toBe('function');
      expect(typeof adapter.dispose).toBe('function');
    });
  });

  describe('resolveProjectDir (via listSessions and readSessionTranscript)', () => {
    // Use a custom config dir to avoid path.resolve ambiguity with homedir
    const customConfigDir = '/test/config';
    const projectsDir = path.join(customConfigDir, 'projects');
    const profileEnv = { CLAUDE_CONFIG_DIR: customConfigDir };

    // Encode cwd the same way the provider does
    function encodeCwd(cwd: string): string {
      return path.resolve(cwd).replace(/[/\\]/g, '-');
    }

    it('listSessions returns empty when projects dir does not exist', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (isClaudePath(p as string)) return true;
        return false;
      });

      const result = await provider.listSessions('/my/project', profileEnv);
      expect(result).toEqual([]);
    });

    it('readSessionTranscript returns null when projects dir does not exist', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        if (isClaudePath(p as string)) return true;
        return false;
      });

      const result = await provider.readSessionTranscript('some-id', '/my/project', profileEnv);
      expect(result).toBeNull();
    });

    it('resolves project dir with leading dash', async () => {
      const encoded = encodeCwd('/my/project');
      const projectDir = path.join(projectsDir, encoded);

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        if (isClaudePath(s)) return true;
        if (s === projectsDir) return true;
        if (s === projectDir) return true;
        return false;
      });

      await provider.readSessionTranscript('test-session', '/my/project', profileEnv);
      expect(fs.existsSync).toHaveBeenCalledWith(projectDir);
    });

    it('resolves project dir without leading dash when with-dash does not exist', async () => {
      const encoded = encodeCwd('/my/project');
      const encodedNoDash = encoded.replace(/^-/, '');
      const projectDirWithDash = path.join(projectsDir, encoded);
      const projectDirWithoutDash = path.join(projectsDir, encodedNoDash);

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        if (isClaudePath(s)) return true;
        if (s === projectsDir) return true;
        if (s === projectDirWithDash) return false;
        if (s === projectDirWithoutDash) return true;
        return false;
      });

      await provider.readSessionTranscript('test-session', '/my/project', profileEnv);
      expect(fs.existsSync).toHaveBeenCalledWith(projectDirWithDash);
      expect(fs.existsSync).toHaveBeenCalledWith(projectDirWithoutDash);
    });

    it('uses CLAUDE_CONFIG_DIR from profileEnv when provided', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        if (isClaudePath(s)) return true;
        if (s === projectsDir) return true;
        return false;
      });

      await provider.listSessions('/my/project', profileEnv);
      expect(fs.existsSync).toHaveBeenCalledWith(projectsDir);
    });

    it('returns empty/null when no matching project dir exists', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        if (isClaudePath(s)) return true;
        if (s === projectsDir) return true;
        return false;
      });

      const sessions = await provider.listSessions('/my/project', profileEnv);
      expect(sessions).toEqual([]);

      const transcript = await provider.readSessionTranscript('id', '/my/project', profileEnv);
      expect(transcript).toBeNull();
    });

    it('both methods resolve the same project dir for the same cwd', async () => {
      const encoded = encodeCwd('/my/project');
      const projectDir = path.join(projectsDir, encoded);
      const existsSyncCalls: string[] = [];

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        existsSyncCalls.push(s);
        if (isClaudePath(s)) return true;
        if (s === projectsDir) return true;
        if (s === projectDir) return true;
        return false;
      });

      await provider.listSessions('/my/project', profileEnv);
      await provider.readSessionTranscript('id', '/my/project', profileEnv);

      const projectDirChecks = existsSyncCalls.filter(c => c === projectDir);
      // At least 2: one from each method's resolveProjectDir call
      // (listSessions also re-checks projectDir as a session location)
      expect(projectDirChecks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('readSessionTranscript file format support', () => {
    const customConfigDir = '/test/config';
    const projectsDir = path.join(customConfigDir, 'projects');
    const profileEnv = { CLAUDE_CONFIG_DIR: customConfigDir };

    function encodeCwd(cwd: string): string {
      return path.resolve(cwd).replace(/[/\\]/g, '-');
    }

    function setupProjectDir() {
      const encoded = encodeCwd('/my/project');
      const projectDir = path.join(projectsDir, encoded);
      return { encoded, projectDir };
    }

    it('reads .jsonl session file from sessions/ subdirectory', async () => {
      const { projectDir } = setupProjectDir();
      const sessionsDir = path.join(projectDir, 'sessions');
      const jsonlPath = path.join(sessionsDir, 'test-session.jsonl');

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        if (isClaudePath(s)) return true;
        if (s === projectsDir) return true;
        if (s === projectDir) return true;
        if (s === jsonlPath) return true;
        return false;
      });
      vi.mocked(fsp.readFile).mockImplementation(async (p) => {
        if (String(p) === jsonlPath) return '{"type":"user","message":"hello"}\n';
        throw new Error('ENOENT');
      });

      const result = await provider.readSessionTranscript('test-session', '/my/project', profileEnv);
      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
      expect(result![0].type).toBe('user');
    });

    it('falls back to .json session file when .jsonl is not found', async () => {
      const { projectDir } = setupProjectDir();
      const sessionsDir = path.join(projectDir, 'sessions');
      const jsonlPath = path.join(sessionsDir, 'test-session.jsonl');
      const jsonPath = path.join(sessionsDir, 'test-session.json');

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        if (isClaudePath(s)) return true;
        if (s === projectsDir) return true;
        if (s === projectDir) return true;
        // .jsonl does NOT exist
        if (s === jsonlPath) return false;
        // .json DOES exist
        if (s === jsonPath) return true;
        return false;
      });
      vi.mocked(fsp.readFile).mockImplementation(async (p) => {
        if (String(p) === jsonPath) return '{"type":"user","message":"from json"}\n';
        throw new Error('ENOENT');
      });

      const result = await provider.readSessionTranscript('test-session', '/my/project', profileEnv);
      expect(result).not.toBeNull();
      expect(result).toHaveLength(1);
      expect(result![0].message).toBe('from json');
    });

    it('prefers .jsonl over .json when both exist', async () => {
      const { projectDir } = setupProjectDir();
      const sessionsDir = path.join(projectDir, 'sessions');
      const jsonlPath = path.join(sessionsDir, 'test-session.jsonl');
      const jsonPath = path.join(sessionsDir, 'test-session.json');

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        if (isClaudePath(s)) return true;
        if (s === projectsDir) return true;
        if (s === projectDir) return true;
        if (s === jsonlPath) return true;
        if (s === jsonPath) return true;
        return false;
      });
      vi.mocked(fsp.readFile).mockImplementation(async (p) => {
        if (String(p) === jsonlPath) return '{"type":"user","message":"from jsonl"}\n';
        if (String(p) === jsonPath) return '{"type":"user","message":"from json"}\n';
        throw new Error('ENOENT');
      });

      const result = await provider.readSessionTranscript('test-session', '/my/project', profileEnv);
      expect(result).not.toBeNull();
      expect(result![0].message).toBe('from jsonl');
    });

    it('reads .json from project root when sessions/ dir has no match', async () => {
      const { projectDir } = setupProjectDir();
      const jsonPath = path.join(projectDir, 'test-session.json');

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        if (isClaudePath(s)) return true;
        if (s === projectsDir) return true;
        if (s === projectDir) return true;
        if (s === jsonPath) return true;
        return false;
      });
      vi.mocked(fsp.readFile).mockImplementation(async (p) => {
        if (String(p) === jsonPath) return '{"type":"system","message":"root json"}\n';
        throw new Error('ENOENT');
      });

      const result = await provider.readSessionTranscript('test-session', '/my/project', profileEnv);
      expect(result).not.toBeNull();
      expect(result![0].message).toBe('root json');
    });
  });

  describe('extractSessionId', () => {
    it('extracts UUID from "session: <uuid>" pattern', () => {
      const buffer = 'some output\nsession: a1b2c3d4-e5f6-7890-abcd-ef1234567890\nmore output';
      const result = provider.extractSessionId!(buffer);
      expect(result).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    });

    it('extracts UUID from "Session: <uuid>" (capitalized)', () => {
      const buffer = 'Session: 12345678-abcd-ef01-2345-678901234567';
      const result = provider.extractSessionId!(buffer);
      expect(result).toBe('12345678-abcd-ef01-2345-678901234567');
    });

    it('extracts UUID from "resume: <uuid>" pattern', () => {
      const buffer = 'resume: fedcba98-7654-3210-fedc-ba9876543210';
      const result = provider.extractSessionId!(buffer);
      expect(result).toBe('fedcba98-7654-3210-fedc-ba9876543210');
    });

    it('returns null when no session ID found', () => {
      const buffer = 'some output without any session info';
      const result = provider.extractSessionId!(buffer);
      expect(result).toBeNull();
    });

    it('returns null for empty buffer', () => {
      const result = provider.extractSessionId!('');
      expect(result).toBeNull();
    });
  });
});
