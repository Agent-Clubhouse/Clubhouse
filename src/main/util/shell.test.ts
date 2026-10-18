import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

import { getShellEnvironment, getDefaultShell, invalidateShellEnvironmentCache, preWarmShellEnvironment, cleanSpawnEnv, buildCliSpawnEnv, summarizeSpawnEnv, winQuoteArg, HOST_SESSION_ENV_VARS, isHostSessionEnvVar } from './shell';
import { HOST_SESSION_ENV_FIXTURE, USER_CLAUDE_CONFIG_FIXTURE } from './__fixtures__/host-session-env';
import { execSync, execFile } from 'child_process';

// The module caches the shell env, so we need to reset between tests
// by re-importing. Since that's complex, we test cumulative behavior.

describe('getShellEnvironment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an object with PATH merged from shell output', () => {
    vi.mocked(execSync).mockImplementation(() => 'PATH=/usr/local/bin:/usr/bin\nHOME=/home/user\n');
    const env = getShellEnvironment();
    expect(env).toBeDefined();
    expect(typeof env).toBe('object');
    // Should include keys from process.env and shell output
    expect(env).toHaveProperty('PATH');
    expect(env).toHaveProperty('HOME');
  });

  it('caches the result on subsequent calls', () => {
    vi.mocked(execSync).mockImplementation(() => 'PATH=/usr/bin\n');
    const env1 = getShellEnvironment();
    const env2 = getShellEnvironment();
    // Should be the same reference due to caching
    expect(env1).toBe(env2);
  });
});

describe('invalidateShellEnvironmentCache', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    // Force non-Windows so the execSync code path is exercised
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('causes getShellEnvironment to re-source on next call', () => {
    // Clear any cache left from prior tests
    invalidateShellEnvironmentCache();

    vi.mocked(execSync).mockImplementation(() => 'FOO=bar\n');
    const env1 = getShellEnvironment();
    expect(env1.FOO).toBe('bar');

    // Simulate the user adding a new env var
    vi.mocked(execSync).mockImplementation(() => 'FOO=bar\nNEW_KEY=new_value\n');
    invalidateShellEnvironmentCache();

    const env2 = getShellEnvironment();
    expect(env2.NEW_KEY).toBe('new_value');
    // Should be a different reference since cache was invalidated
    expect(env1).not.toBe(env2);
  });
});

describe('getDefaultShell', () => {
  const originalPlatform = process.platform;
  const originalSHELL = process.env.SHELL;
  const originalCOMSPEC = process.env.COMSPEC;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env.SHELL = originalSHELL;
    process.env.COMSPEC = originalCOMSPEC;
  });

  it('returns SHELL env var on non-Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.SHELL = '/bin/bash';
    expect(getDefaultShell()).toBe('/bin/bash');
  });

  it('falls back to /bin/zsh on non-Windows when SHELL is unset', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.SHELL;
    expect(getDefaultShell()).toBe('/bin/zsh');
  });

  it('returns COMSPEC env var on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    expect(getDefaultShell()).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it('falls back to cmd.exe on Windows when COMSPEC is unset', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env.COMSPEC;
    expect(getDefaultShell()).toBe('cmd.exe');
  });
});

describe('getShellEnvironment host-session stripping', () => {
  const originalPlatform = process.platform;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    vi.clearAllMocks();
    saved = {};
    for (const [k, v] of Object.entries({ ...HOST_SESSION_ENV_FIXTURE, ...USER_CLAUDE_CONFIG_FIXTURE })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    invalidateShellEnvironmentCache();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    invalidateShellEnvironmentCache();
  });

  function expectClean(env: Record<string, string>) {
    for (const key of Object.keys(HOST_SESSION_ENV_FIXTURE)) expect(env).not.toHaveProperty(key);
    expect(env).toMatchObject(USER_CLAUDE_CONFIG_FIXTURE);
  }

  it('strips vars inherited through process.env and the login shell (POSIX)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    // The login shell is a child of Clubhouse, so its `env` echoes them back too.
    vi.mocked(execSync).mockImplementation(() =>
      Object.entries(HOST_SESSION_ENV_FIXTURE).map(([k, v]) => `${k}=${v}`).join('\n') + '\nHOME=/home/user\n');
    const env = getShellEnvironment();
    expectClean(env);
    expect(env.HOME).toBe('/home/user');
  });

  it('strips them when the login shell fails', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.mocked(execSync).mockImplementation(() => { throw new Error('boom'); });
    expectClean(getShellEnvironment());
  });

  it('strips them on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expectClean(getShellEnvironment());
  });

  it('strips them from the pre-warmed cache', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => {
      cb(null, 'CLAUDE_CODE_CHILD_SESSION=1\nHOME=/home/user\n');
    }) as unknown as typeof execFile);
    preWarmShellEnvironment();
    expect(execSync).not.toHaveBeenCalled();
    const env = getShellEnvironment();
    expect(execSync).not.toHaveBeenCalled();
    expectClean(env);
  });
});

describe('cleanSpawnEnv', () => {
  it('removes CLAUDECODE and CLAUDE_CODE_ENTRYPOINT', () => {
    const env: Record<string, string> = {
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      HOME: '/home/user',
    };
    const result = cleanSpawnEnv(env);
    expect(result).toBe(env); // same reference (mutates in place)
    expect(result.CLAUDECODE).toBeUndefined();
    expect(result.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(result.PATH).toBe('/usr/bin');
    expect(result.HOME).toBe('/home/user');
  });

  it('strips every inherited host-session var and keeps user Claude config', () => {
    const env: Record<string, string> = { PATH: '/usr/bin', ...HOST_SESSION_ENV_FIXTURE, ...USER_CLAUDE_CONFIG_FIXTURE };
    cleanSpawnEnv(env);
    for (const key of Object.keys(HOST_SESSION_ENV_FIXTURE)) expect(env).not.toHaveProperty(key);
    expect(env).toEqual({ PATH: '/usr/bin', ...USER_CLAUDE_CONFIG_FIXTURE });
  });

  it('covers every name in HOST_SESSION_ENV_VARS', () => {
    const env: Record<string, string> = Object.fromEntries(HOST_SESSION_ENV_VARS.map((k) => [k, 'x']));
    expect(cleanSpawnEnv(env)).toEqual({});
  });

  it('strips any CLAUDE_CODE_MESSAGING_ var, not just the known ones', () => {
    const env: Record<string, string> = { CLAUDE_CODE_MESSAGING_FUTURE_THING: 'x', CLAUDE_CODE_MESSAGINGX: 'kept' };
    expect(cleanSpawnEnv(env)).toEqual({ CLAUDE_CODE_MESSAGINGX: 'kept' });
  });

  it('matches names case-insensitively (Windows env keys)', () => {
    expect(isHostSessionEnvVar('ClaudeCode')).toBe(true);
    expect(isHostSessionEnvVar('claude_code_messaging_socket')).toBe(true);
    expect(isHostSessionEnvVar('CLAUDE_CONFIG_DIR')).toBe(false);
  });

  it('leaves undefined-valued envs typed as such', () => {
    const env: Record<string, string | undefined> = { CLAUDE_PID: '1', HOME: undefined };
    expect(cleanSpawnEnv(env)).toEqual({ HOME: undefined });
  });

  it('is a no-op when keys are not present', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' };
    const result = cleanSpawnEnv(env);
    expect(result).toBe(env);
    expect(result.PATH).toBe('/usr/bin');
  });
});

describe('buildCliSpawnEnv', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    // Windows skips shell sourcing; pin a POSIX platform so execSync is used.
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    invalidateShellEnvironmentCache();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    invalidateShellEnvironmentCache();
  });

  it('starts from the login shell env so the CLI can find its own login', () => {
    vi.mocked(execSync).mockImplementation(() => 'HOME=/home/user\nPATH=/opt/homebrew/bin:/usr/bin\nUSER=someone\n');
    const env = buildCliSpawnEnv({ CLUBHOUSE_AGENT_ID: 'agent-1' });
    expect(env.HOME).toBe('/home/user');
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin');
    expect(env.USER).toBe('someone');
    expect(env.CLUBHOUSE_AGENT_ID).toBe('agent-1');
  });

  it('lets overrides win over the shell env', () => {
    vi.mocked(execSync).mockImplementation(() => 'HOME=/home/user\nCOPILOT_HOME=/shell\n');
    expect(buildCliSpawnEnv({ COPILOT_HOME: '/profile' }).COPILOT_HOME).toBe('/profile');
  });

  it('strips nested-agent markers and never mutates the cached shell env', () => {
    vi.mocked(execSync).mockImplementation(() => 'HOME=/home/user\nCLAUDECODE=1\n');
    const env = buildCliSpawnEnv({ CLAUDE_CODE_ENTRYPOINT: 'cli' });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    // The cached env is cleaned at the source, and buildCliSpawnEnv works on a copy.
    expect(getShellEnvironment().CLAUDECODE).toBeUndefined();
    expect(getShellEnvironment().HOME).toBe('/home/user');
  });

  it('strips host-session vars from overrides and keeps user Claude config', () => {
    vi.mocked(execSync).mockImplementation(() => 'HOME=/home/user\n');
    const env = buildCliSpawnEnv({ ...HOST_SESSION_ENV_FIXTURE, ...USER_CLAUDE_CONFIG_FIXTURE });
    for (const key of Object.keys(HOST_SESSION_ENV_FIXTURE)) expect(env).not.toHaveProperty(key);
    expect(env).toMatchObject(USER_CLAUDE_CONFIG_FIXTURE);
  });

  it('works with no overrides', () => {
    vi.mocked(execSync).mockImplementation(() => 'HOME=/home/user\n');
    expect(buildCliSpawnEnv().HOME).toBe('/home/user');
  });
});

describe('summarizeSpawnEnv', () => {
  const originalPlatform = process.platform;
  afterEach(() => { Object.defineProperty(process, 'platform', { value: originalPlatform }); });

  it('names the login-critical vars a stripped env is missing, without values', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const summary = summarizeSpawnEnv({ CLUBHOUSE_AGENT_ID: 'a', CLUBHOUSE_HOOK_NONCE: 'secret-nonce' });
    expect(summary).toEqual({ keyCount: 2, missing: ['HOME', 'PATH', 'USER', 'SHELL'] });
    expect(JSON.stringify(summary)).not.toContain('secret-nonce');
  });

  it('reports nothing missing for a full env and skips undefined values', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(summarizeSpawnEnv({ HOME: '/h', PATH: '/p', USER: 'u', SHELL: '/bin/zsh', GONE: undefined })).toEqual({ keyCount: 4, missing: [] });
  });

  it('checks the Windows login vars case-insensitively', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(summarizeSpawnEnv({ Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u' })).toEqual({ keyCount: 2, missing: [] });
    expect(summarizeSpawnEnv({}).missing).toEqual(['PATH', 'USERPROFILE']);
  });
});

describe('winQuoteArg', () => {
  it('returns empty quoted string for empty input', () => {
    expect(winQuoteArg('')).toBe('""');
  });

  it('wraps a simple argument in double quotes', () => {
    expect(winQuoteArg('hello')).toBe('"hello"');
  });

  it('wraps an argument with spaces in double quotes', () => {
    expect(winQuoteArg('hello world')).toBe('"hello world"');
  });

  it('escapes embedded double quotes by doubling them', () => {
    expect(winQuoteArg('say "hi"')).toBe('"say ""hi"""');
  });

  it('handles argument with only a double quote', () => {
    expect(winQuoteArg('"')).toBe('""""');
  });

  it('handles special shell characters', () => {
    expect(winQuoteArg('a&b|c')).toBe('"a&b|c"');
  });

  it('doubles percent signs so %VAR% is not expanded by cmd.exe', () => {
    expect(winQuoteArg('%PATH%')).toBe('"%%PATH%%"');
    expect(winQuoteArg('prefix %USERNAME% suffix')).toBe('"prefix %%USERNAME%% suffix"');
  });

  it('handles a long mission-text-like argument', () => {
    const longArg = 'Fix the bug in src/main/services/foo.ts where the "parser" fails';
    const result = winQuoteArg(longArg);
    expect(result).toBe('"Fix the bug in src/main/services/foo.ts where the ""parser"" fails"');
  });
});

describe('preWarmShellEnvironment', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateShellEnvironmentCache();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('calls execFile asynchronously to resolve shell env', () => {
    preWarmShellEnvironment();
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      expect.any(String),
      ['-ilc', 'env'],
      expect.objectContaining({ encoding: 'utf-8', timeout: 5000 }),
      expect.any(Function),
    );
  });

  it('populates cache when async callback fires', () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: string, _args: string[], _opts: any, cb?: any) => {
        if (cb) cb(null, 'WARM_KEY=warm_value\n', '');
        return {} as any;
      },
    );

    preWarmShellEnvironment();

    const env = getShellEnvironment();
    expect(env.WARM_KEY).toBe('warm_value');
  });

  it('does not overwrite cache if getShellEnvironment was called first', () => {
    // Simulate: sync getShellEnvironment runs before async callback
    vi.mocked(execSync).mockImplementation(() => 'SYNC_KEY=sync_value\n');
    getShellEnvironment(); // populates cache synchronously

    // Now pre-warm fires — should not overwrite
    vi.mocked(execFile).mockImplementation(
      (_cmd: string, _args: string[], _opts: any, cb?: any) => {
        if (cb) cb(null, 'ASYNC_KEY=async_value\n', '');
        return {} as any;
      },
    );

    preWarmShellEnvironment();

    const env = getShellEnvironment();
    expect(env.SYNC_KEY).toBe('sync_value');
    // ASYNC_KEY should NOT be present since cache was already populated
    expect(env.ASYNC_KEY).toBeUndefined();
  });

  it('falls back to process.env on error', () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: string, _args: string[], _opts: any, cb?: any) => {
        if (cb) cb(new Error('shell failed'), '', '');
        return {} as any;
      },
    );

    preWarmShellEnvironment();

    const env = getShellEnvironment();
    // Should have process.env entries
    expect(env).toBeDefined();
    expect(typeof env.PATH).toBe('string');
  });

  it('is a no-op on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    preWarmShellEnvironment();
    // Should not call execFile on Windows
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    // But cache should be populated with process.env
    const env = getShellEnvironment();
    expect(env).toBeDefined();
  });
});
