import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearClaudeCliVersionCache, lookupClaudeCliVersion, parseClaudeVersionOutput } from './cli-version';
import { spawnClaude } from './spawn';

vi.mock('../../util/shell', async (importActual) => {
  const actual = await importActual<typeof import('../../util/shell')>();
  return { ...actual, getShellEnvironment: () => ({ ...process.env }) as Record<string, string> };
});

/**
 * `binary` is a plain file (its mtime is the cache key); the spawn runs a
 * node one-liner that prints `$VERSION_OUT` and exits `$VERSION_CODE`, or
 * hangs when `$VERSION_HANG` is set.
 */
const SCRIPT = `
if (process.env.VERSION_HANG) setInterval(() => {}, 1000);
else { process.stdout.write(process.env.VERSION_OUT ?? ''); process.exit(Number(process.env.VERSION_CODE ?? 0)); }
`;

describe('parseClaudeVersionOutput', () => {
  it('reads the version on the line naming Claude Code', () => {
    expect(parseClaudeVersionOutput('2.1.296 (Claude Code)\n')).toBe('2.1.296');
    expect(parseClaudeVersionOutput('Now using node v20.19.0 (npm v10.8.2)\r\n2.1.296 (Claude Code)\r\n')).toBe('2.1.296');
  });

  it('otherwise reads the last line, which is claude\'s, not a command prefix\'s', () => {
    expect(parseClaudeVersionOutput('Python 3.11.4\n2.1.296\n')).toBe('2.1.296');
    expect(parseClaudeVersionOutput('Python 3.11.4\nno version\n')).toBeUndefined();
    expect(parseClaudeVersionOutput('')).toBeUndefined();
  });
});

describe('lookupClaudeCliVersion', () => {
  let tmp: string;
  let binary: string;
  let spawns: string[][];
  const spawn: typeof spawnClaude = (o) => {
    spawns.push(o.args);
    return spawnClaude({ ...o, binary: process.execPath, args: ['-e', SCRIPT] });
  };

  beforeEach(() => {
    clearClaudeCliVersionCache();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-claude-version-'));
    binary = path.join(tmp, 'claude');
    fs.writeFileSync(binary, '');
    spawns = [];
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('runs `--version` and returns the version in its output', async () => {
    expect(await lookupClaudeCliVersion(binary, { env: { VERSION_OUT: '2.1.296 (Claude Code)\n' } }, { spawn })).toBe('2.1.296');
    expect(spawns).toEqual([['--version']]);
  });

  it('keeps a prerelease suffix', async () => {
    expect(await lookupClaudeCliVersion(binary, { env: { VERSION_OUT: '2.1.300-beta.1 (Claude Code)' } }, { spawn })).toBe('2.1.300-beta.1');
  });

  it('caches by binary until its mtime changes', async () => {
    const opts = { env: { VERSION_OUT: '2.1.296' } };
    await lookupClaudeCliVersion(binary, opts, { spawn });
    await lookupClaudeCliVersion(binary, opts, { spawn });
    expect(spawns).toHaveLength(1);

    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(binary, later, later);
    expect(await lookupClaudeCliVersion(binary, { env: { VERSION_OUT: '2.1.296' } }, { spawn })).toBe('2.1.296');
    expect(spawns).toHaveLength(2);
  });

  it('shares one spawn between concurrent lookups', async () => {
    const opts = { env: { VERSION_OUT: '2.1.296' } };
    const [a, b] = await Promise.all([lookupClaudeCliVersion(binary, opts, { spawn }), lookupClaudeCliVersion(binary, opts, { spawn })]);
    expect([a, b]).toEqual(['2.1.296', '2.1.296']);
    expect(spawns).toHaveLength(1);
  });

  it('keys the cache by profile env and command prefix', async () => {
    await lookupClaudeCliVersion(binary, { env: { VERSION_OUT: '2.1.296' } }, { spawn });
    expect(await lookupClaudeCliVersion(binary, { env: { VERSION_OUT: '2.1.297' } }, { spawn })).toBe('2.1.297');
    expect(spawns).toHaveLength(2);
  });

  it.skipIf(process.platform === 'win32')('runs through the command prefix and ignores what the prefix prints', async () => {
    const prefix = 'echo Now using node v20.19.0';
    expect(await lookupClaudeCliVersion(binary, { env: { VERSION_OUT: '2.1.296 (Claude Code)\n' }, commandPrefix: prefix }, { spawn })).toBe('2.1.296');
    // A different prefix is a different cache entry.
    await lookupClaudeCliVersion(binary, { env: { VERSION_OUT: '2.1.296 (Claude Code)\n' } }, { spawn });
    expect(spawns).toHaveLength(2);
  });

  it('does not wait on a pipe held open after claude exits', async () => {
    // The grandchild inherits stdout and outlives its parent.
    const holder = (o: Parameters<typeof spawnClaude>[0]) => spawnClaude({
      ...o,
      binary: process.execPath,
      args: ['-e', "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'inherit' }).unref(); process.stdout.write('2.1.296\\n');"],
    });
    const started = Date.now();
    expect(await lookupClaudeCliVersion(binary, {}, { spawn: holder, timeoutMs: 4000 })).toBe('2.1.296');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('returns undefined and does not cache when the output has no version', async () => {
    const opts = { env: { VERSION_OUT: 'claude: command failed' } };
    expect(await lookupClaudeCliVersion(binary, opts, { spawn })).toBeUndefined();
    expect(await lookupClaudeCliVersion(binary, opts, { spawn })).toBeUndefined();
    expect(spawns).toHaveLength(2);
  });

  it('returns undefined on a nonzero exit', async () => {
    expect(await lookupClaudeCliVersion(binary, { env: { VERSION_OUT: '2.1.296', VERSION_CODE: '1' } }, { spawn })).toBeUndefined();
  });

  it('gives up after the timeout', async () => {
    expect(await lookupClaudeCliVersion(binary, { env: { VERSION_HANG: '1' } }, { spawn, timeoutMs: 200 })).toBeUndefined();
  });

  it('returns undefined when the binary cannot be spawned', async () => {
    expect(await lookupClaudeCliVersion(path.join(tmp, 'missing-claude'))).toBeUndefined();
  });
});
