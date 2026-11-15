import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveProcessLaunch } from './process-launch';

const execFileAsync = promisify(execFile);
const HOSTILE_ARGS = [
  'a&calc', '|', '^', '%PATH%', '!x!', '<in>out', '100%',
  'say "hello"', '"&calc&"', 'C:\\data\\', 'end\\\\', 'a\\"b', 'with spaces', 'trailing ', '',
];
const nativeWindows = process.platform === 'win32';
let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'process launch '));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('resolveProcessLaunch', () => {
  beforeEach(() => { vi.spyOn(process, 'platform', 'get').mockReturnValue('win32'); });

  it('resolves an exe from case-insensitive PATH/PATHEXT and keeps exact argv', async () => {
    await fs.promises.writeFile(path.join(tmp, 'tool'), '#!/bin/sh');
    const binary = path.join(tmp, 'tool.exe');
    await fs.promises.writeFile(binary, '');
    const launch = resolveProcessLaunch('tool', HOSTILE_ARGS, { Path: `"${tmp}"`, PathExt: '.EXE;.CMD' });
    expect(launch).toEqual({ binary, args: HOSTILE_ARGS });
  });

  it('uses the supplied environment PATHEXT order and escapes a resolved cmd shim', async () => {
    await fs.promises.writeFile(path.join(tmp, 'tool.exe'), '');
    const binary = path.join(tmp, 'tool.cmd');
    await fs.promises.writeFile(binary, '@echo off\r\nnode echo.js %*\r\n');
    const launch = resolveProcessLaunch('tool', ['a&calc', '|', '^', '%PATH%', '!x!', 'say "hi"', 'C:\\data\\', 'a b '], {
      PATH: tmp, PATHEXT: '.CMD;.EXE', SystemRoot: tmp,
    });
    expect(launch).toEqual({
      binary: path.join(tmp, 'System32', 'cmd.exe'),
      args: ['/d', '/v:off', '/s', '/c', '"' + binary.replace(/ /g, '^ ') + ' ' + [
        '^^^"a^^^&calc^^^"', '^^^"^^^|^^^"', '^^^"^^^^^^^"', '^^^"^^^%PATH^^^%^^^"',
        '^^^"^^^!x^^^!^^^"', '^^^"say \\^^^"hi\\^^^"^^^"', '^^^"C^^^:\\data\\\\^^^"', '^^^"a b ^^^"',
      ].join(' ') + '"'],
      windowsVerbatimArguments: true,
    });
  });

  it('resolves explicit and relative native executable paths', async () => {
    const binary = path.join(tmp, 'tool.exe');
    await fs.promises.writeFile(binary, '');
    expect(resolveProcessLaunch(binary, HOSTILE_ARGS, {})).toEqual({ binary, args: HOSTILE_ARGS });
    expect(resolveProcessLaunch('./tool', HOSTILE_ARGS, { PATHEXT: '.EXE' }, tmp)).toEqual({ binary, args: HOSTILE_ARGS });
  });

  it('does not search project cwd or accept shell builtins, directories or Unix scripts', async () => {
    await fs.promises.writeFile(path.join(tmp, 'tool.exe'), '');
    await fs.promises.writeFile(path.join(tmp, 'unix'), '#!/bin/sh');
    await fs.promises.mkdir(path.join(tmp, 'directory.exe'));
    expect(() => resolveProcessLaunch('tool', [], { PATH: '' }, tmp)).toThrow('Could not find');
    for (const binary of ['echo', 'unix', 'directory', 'tool & calc']) {
      expect(() => resolveProcessLaunch(binary, [], { PATH: tmp }, tmp)).toThrow('Could not find');
    }
  });

  it.each(['tool.cmd', 'tool.bat'])('rejects line breaks and NUL before launching %s', async (name) => {
    await fs.promises.writeFile(path.join(tmp, name), '@echo off\r\n');
    for (const arg of ['a\nb', 'a\rb', 'a\0b']) {
      expect(() => resolveProcessLaunch(name, [arg], { PATH: tmp })).toThrow(/line break|NUL/);
    }
  });

  it.each(['tool.cmd', 'tool.bat'])('rejects a plugin batch %s without invoking cmd.exe', async (name) => {
    await fs.promises.writeFile(path.join(tmp, name), '@echo off\r\nnode echo.js %*\r\n');
    expect(() => resolveProcessLaunch(name, HOSTILE_ARGS, { PATH: tmp }, tmp, { allowBatch: false }))
      .toThrow('Plugins cannot run Windows batch files');
  });

  it('uses one escape layer for a batch program that reads its positional parameters', async () => {
    const binary = path.join(tmp, 'reader.cmd');
    await fs.promises.writeFile(binary, '@echo off\r\nif "%~1"=="-f" echo file is %~2\r\n');
    const launch = resolveProcessLaunch('reader', ['-f', 'C:\\file with spaces\\'], { PATH: tmp });
    expect(launch.args.at(-1)).toBe('"' + binary.replace(/ /g, '^ ') + ' ^"-f^" ^"C^:\\file with spaces\\^""');
  });

  it('bypasses a node shim and resolves node.exe using the child environment', async () => {
    const script = path.join(tmp, 'cli.js');
    const node = path.join(tmp, 'node.exe');
    await fs.promises.writeFile(script, '');
    await fs.promises.writeFile(node, '');
    await fs.promises.writeFile(path.join(tmp, 'tool.cmd'), '@node "%~dp0\\cli.js" %*\r\n');
    expect(resolveProcessLaunch('tool', ['line\nbreak', ...HOSTILE_ARGS], { PATH: tmp }, tmp, { allowBatch: false })).toEqual({
      binary: node, args: [script, 'line\nbreak', ...HOSTILE_ARGS],
    });
  });

  it.each(['darwin', 'linux'])('leaves %s launch behavior unchanged', (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    expect(resolveProcessLaunch('arbitrary-tool', HOSTILE_ARGS, {})).toEqual({ binary: 'arbitrary-tool', args: HOSTILE_ARGS });
  });
});

// Picked up by both existing Windows CI unit shards. These exercise the same
// execFile API the five callers use, with a real node child that echoes JSON.
describe.runIf(nativeWindows)('real Windows argv (#2239)', () => {
  it.each([false, true])('preserves positional flags for an ordinary batch reader (trailing slash: %s)', async (trailingSlash) => {
    const reader = path.join(tmp, 'reader.cmd');
    await fs.promises.writeFile(reader, '@echo off\r\nif "%~1"=="-f" echo file is %~2\r\n');
    const file = trailingSlash ? path.join(tmp, 'project files') + path.sep : path.join(tmp, 'project files', 'pom.xml');
    const launch = resolveProcessLaunch(reader, ['-f', file]);
    const { stdout, stderr } = await execFileAsync(launch.binary, launch.args, {
      shell: false, windowsVerbatimArguments: launch.windowsVerbatimArguments, timeout: 10_000,
    });
    expect(stderr).toBe('');
    expect(stdout.trimEnd()).toBe(`file is ${file}`);
  }, 20_000);

  it.each(['exe', 'cmd', 'bat', 'npm'])('preserves hostile args through %s', async (kind) => {
    const script = path.join(tmp, 'echo args.js');
    await fs.promises.writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    let binary = 'node';
    let args = [script, ...HOSTILE_ARGS];
    const env = { ...process.env, PATH: `${tmp};${path.dirname(process.execPath)}`, PATHEXT: '.EXE;.CMD;.BAT' };
    if (kind !== 'exe') {
      binary = `tool.${kind === 'bat' ? 'bat' : 'cmd'}`;
      const body = kind === 'npm'
        ? '@node "%~dp0\\echo args.js" %*\r\n'
        : `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`;
      await fs.promises.writeFile(path.join(tmp, binary), body);
      args = HOSTILE_ARGS;
    }
    const launch = resolveProcessLaunch(binary, args, env);
    expect(!!launch.windowsVerbatimArguments).toBe(kind === 'cmd' || kind === 'bat');
    const { stdout, stderr } = await execFileAsync(launch.binary, launch.args, {
      env, shell: false, windowsVerbatimArguments: launch.windowsVerbatimArguments, timeout: 10_000,
    });
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual(HOSTILE_ARGS);
  }, 20_000);
});
