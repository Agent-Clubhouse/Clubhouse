import * as path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

vi.mock('../util/process-launch', () => ({
  resolveProcessLaunch: vi.fn((binary: string, args: string[]) => ({ binary, args })),
}));

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: '/usr/bin' })),
  invalidateShellEnvironmentCache: vi.fn(),
}));

vi.mock('./shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shared')>();
  return {
    ...actual,
    findBinaryInPath: vi.fn(() => '/home/user/.local/bin/agy'),
    homePath: vi.fn((...segments: string[]) => `/home/user/${segments.join('/')}`),
    testBinaryOverride: vi.fn(() => undefined),
  };
});

vi.mock('../services/log-service', () => ({ appLog: vi.fn() }));

import { execFile } from 'child_process';
import { findBinaryInPath } from './shared';
import { AntigravityCliProvider, parseAgyVersion } from './antigravity-cli-provider';
import { parseAgyModels, probeAgyModels } from './antigravity/models';
import type { ModelList } from './types';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

function execReturns(stdout: string | Error): void {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const cb = args[args.length - 1] as ExecCallback;
    if (stdout instanceof Error) cb(stdout, '', '');
    else cb(null, stdout, '');
    return {} as ReturnType<typeof execFile>;
  }) as unknown as typeof execFile);
}

describe('AntigravityCliProvider', () => {
  let provider: AntigravityCliProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findBinaryInPath).mockReturnValue('/home/user/.local/bin/agy');
    provider = new AntigravityCliProvider();
  });

  describe('identity and conventions', () => {
    it('is the experimental antigravity-cli provider', () => {
      expect(provider.id).toBe('antigravity-cli');
      expect(provider.displayName).toBe('Antigravity CLI');
      expect(provider.badge).toBe('Experimental');
    });

    it('uses the documented workspace files', () => {
      expect(provider.conventions).toMatchObject({
        configDir: '.agents',
        localInstructionsFile: 'AGENTS.md',
        skillsRoot: '.agents/skills',
        mcpConfigFile: '.agents/mcp_config.json',
        hooksFile: 'hooks.json',
        settingsFormat: 'json',
        permissionRules: false,
      });
    });

    it('keeps headless, hooks and session listing off until their gates land', () => {
      expect(provider.getCapabilities()).toMatchObject({
        headless: false,
        hooks: false,
        sessionResume: false,
        supportsPositionalMission: false,
        ignoresToolListChanged: true,
      });
    });

    it('exits with /exit', () => {
      expect(provider.getExitCommand()).toBe('/exit\r');
    });
  });

  describe('binary discovery', () => {
    it('looks for agy at the documented install location', () => {
      provider.getBinaryPath();
      const [names, extra] = vi.mocked(findBinaryInPath).mock.calls[0];
      expect(names).toEqual(['agy']);
      if (process.platform === 'win32') {
        expect(extra[0]).toMatch(/agy[\\/]bin[\\/]agy\.exe$/);
      } else {
        expect(extra).toEqual(['/home/user/.local/bin/agy']);
      }
    });

    it('reports unavailable with the lookup error when agy is missing', async () => {
      vi.mocked(findBinaryInPath).mockImplementation(() => { throw new Error('Could not find agy'); });
      expect(await provider.checkAvailability()).toEqual({ available: false, error: 'Could not find agy' });
      expect(execFile).not.toHaveBeenCalled();
    });

    it('runs agy --version and reports the version', async () => {
      execReturns('agy 1.5.12\n');
      expect(await provider.checkAvailability()).toEqual({ available: true, version: '1.5.12' });
      expect(vi.mocked(execFile).mock.calls[0][1]).toEqual(['--version']);
    });

    it('reports unavailable when agy --version fails', async () => {
      execReturns(new Error('spawn EACCES'));
      const result = await provider.checkAvailability();
      expect(result.available).toBe(false);
      expect(result.error).toContain('agy --version');
    });

    it.each([
      ['agy 1.5.12', '1.5.12'],
      ['Antigravity CLI v1.6.0 (abc)', '1.6.0'],
      ['unknown', null],
    ])('parses %j as %j', (out, version) => {
      expect(parseAgyVersion(out)).toBe(version);
    });
  });

  describe('buildSpawnCommand', () => {
    const cwd = path.join('/', 'work', 'tree');

    it('starts in default mode (Ask first) with no flags', async () => {
      expect(await provider.buildSpawnCommand({ cwd })).toEqual({ binary: '/home/user/.local/bin/agy', args: [] });
    });

    it.each([
      ['plan', ['--mode', 'plan']],
      ['ask', []],
      ['auto_edit', ['--mode', 'accept-edits']],
      ['full_access', ['--dangerously-skip-permissions']],
    ] as const)('maps access %s to %j', async (access, args) => {
      expect((await provider.buildSpawnCommand({ cwd, access })).args).toEqual(args);
    });

    it('refuses Auto rather than letting the CLI fall back to default mode', async () => {
      await expect(provider.buildSpawnCommand({ cwd, access: 'auto' })).rejects.toThrow(/cannot start at Auto/);
    });

    it('maps the legacy free-agent pair the same way: skip-all is Full access, auto is refused', async () => {
      expect((await provider.buildSpawnCommand({ cwd, freeAgentMode: true, permissionMode: 'skip-all' })).args).toEqual(['--dangerously-skip-permissions']);
      await expect(provider.buildSpawnCommand({ cwd, freeAgentMode: true, permissionMode: 'auto' })).rejects.toThrow(/cannot start at Auto/);
      await expect(provider.buildSpawnCommand({ cwd, freeAgentMode: true })).rejects.toThrow(/cannot start at Auto/);
    });

    it('resumes a known conversation by id, else the most recent', async () => {
      expect((await provider.buildSpawnCommand({ cwd, resume: true, sessionId: 'conv-1' })).args).toEqual(['--conversation', 'conv-1']);
      expect((await provider.buildSpawnCommand({ cwd, resume: true })).args).toEqual(['--continue']);
    });

    it('passes model and effort, but not the default model', async () => {
      expect((await provider.buildSpawnCommand({ cwd, model: 'gemini-4-neon-high', effort: 'high' })).args).toEqual(['--model', 'gemini-4-neon-high', '--effort', 'high']);
      expect((await provider.buildSpawnCommand({ cwd, model: 'default' })).args).toEqual([]);
    });

    it('sends a mission as an interactive prompt, never as headless -p', async () => {
      const { args } = await provider.buildSpawnCommand({ cwd, systemPrompt: 'Be brief.', mission: 'Fix the bug' });
      expect(args).toEqual(['--prompt-interactive', 'Be brief.\n\nFix the bug']);
      expect(args).not.toContain('-p');
    });

    it('refuses a Dispatcher launch: no documented switch turns off its browser control', async () => {
      await expect(provider.buildSpawnCommand({ cwd, noDesktopControl: true })).rejects.toThrow(/browser control/);
    });

    it('refuses a sandbox or approval policy it has no verified mapping for', async () => {
      await expect(provider.buildSpawnCommand({ cwd, sandbox: 'read-only' })).rejects.toThrow(/No verified mapping/);
    });

    it('adds no environment variables of its own (the launch shell env is inherited as for every provider)', async () => {
      const result = await provider.buildSpawnCommand({ cwd, access: 'full_access' });
      expect(result.env).toBeUndefined();
    });
  });

  describe('models', () => {
    it('parses the documented agy models listing', () => {
      const out = [
        'gemini-4-neon-xhigh            Gemini 4 Neon (XHigh)',
        'gemini-4-neon-high             Gemini 4 Neon (High)',
        '...',
        'gemini-pro-orchestrator        Orchestrator (Carbon)',
        '',
      ].join('\n');
      expect(parseAgyModels(out)).toEqual([
        { id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)' },
        { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
        { id: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon)' },
      ]);
    });

    it('skips lines outside the slug-column-name format', () => {
      expect(parseAgyModels('--model  x\n-rf\n')).toBeNull();
      expect(parseAgyModels('')).toBeNull();
      expect(parseAgyModels('Warning\nAvailable models:\nWarning: update available\n')).toBeNull();
      expect(parseAgyModels('Warning: something\na-1  A One\r\na-1  dup\r\nb\tB\r\n')).toEqual([{ id: 'a-1', label: 'A One' }, { id: 'b', label: 'B' }]);
    });

    it('refuses output with more model lines than it accepts, rather than cutting it off', () => {
      const many = Array.from({ length: 501 }, (_, i) => `m-${i}  Model ${i}`).join('\n');
      expect(() => parseAgyModels(many)).toThrow(/more than 500/);
      expect(parseAgyModels(many.split('\n').slice(0, 500).join('\n'))).toHaveLength(500);
    });

    it('turns an oversized listing into a rejected probe inside the execFile callback, not an uncaught error', async () => {
      const many = Array.from({ length: 501 }, (_, i) => `m-${i}  Model ${i}`).join('\n');
      execReturns(many);
      const uncaught = vi.fn();
      process.on('uncaughtException', uncaught);
      try {
        const ctx = { binary: '/x/agy', cwd: '/tmp', signal: new AbortController().signal, timeoutMs: 1000 };
        await expect(probeAgyModels(ctx)).rejects.toThrow(/agy models output refused: .*more than 500/);
        await new Promise((r) => setTimeout(r, 0));
        expect(uncaught).not.toHaveBeenCalled();
      } finally {
        process.off('uncaughtException', uncaught);
      }
    });

    it('resolves a normal listing through the same callback', async () => {
      execReturns('gemini-4-neon-high   Gemini 4 Neon (High)\n');
      const ctx = { binary: '/x/agy', cwd: '/tmp', signal: new AbortController().signal, timeoutMs: 1000 };
      expect(await probeAgyModels(ctx)).toEqual([{ id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' }]);
      expect(vi.mocked(execFile).mock.calls[0][1]).toEqual(['models']);
    });

    it('accepts only listed slugs and default', () => {
      const list: ModelList = { models: [{ id: 'default', label: 'Default' }, { id: 'gemini-4-neon-high', label: 'x' }], source: 'live', via: 'handshake', fetchedAt: 0 };
      expect(provider.acceptsModel('gemini-4-neon-high', list)).toBe(true);
      expect(provider.acceptsModel('default', list)).toBe(true);
      expect(provider.acceptsModel('gemini-3-pro', list)).toBe(false);
    });

    it('never peeks by spawning', () => {
      expect(provider.peekModels()).toBeNull();
      expect(execFile).not.toHaveBeenCalled();
    });
  });
});
