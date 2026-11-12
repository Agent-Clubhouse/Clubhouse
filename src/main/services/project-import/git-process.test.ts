import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const fake = vi.hoisted(() => ({
  outputs: [] as Array<{ stdout?: string; stderr?: string; code?: number; wait?: boolean }>,
  calls: [] as Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; shell: boolean; kills: string[] }>,
  rejectDeviceConfig: false,
}));
vi.mock('../log-service', () => ({ appLog: vi.fn() }));
vi.mock('fs', async (original) => ({ ...await original<typeof import('fs')>() }));
vi.mock('child_process', async () => {
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  return {
    spawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; shell: boolean }) => {
      const child = new EventEmitter();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const kills: string[] = [];
      fake.calls.push({ command, args, ...options, kills });
      const output = fake.outputs.shift() ?? { code: 0 };
      Object.assign(child, {
        stdout, stderr,
        kill: (signal: string) => {
          kills.push(signal);
          queueMicrotask(() => child.emit('close', null));
          return true;
        },
      });
      queueMicrotask(() => {
        if (output.stdout) stdout.emit('data', Buffer.from(output.stdout));
        if (output.stderr) stderr.emit('data', Buffer.from(output.stderr));
        if (!output.wait) child.emit('close', fake.rejectDeviceConfig && options.env.GIT_CONFIG_GLOBAL === os.devNull ? 128 : output.code ?? 0);
      });
      return child;
    },
  };
});

import { createImportGit } from './git';

const sha = 'a'.repeat(40);
const source = () => ({ PATH: process.env.PATH, HOME: '/fixture', GIT_TRACE: '/private/trace', GIT_DIR: '/untrusted', GIT_CONFIG_COUNT: '1' });
beforeEach(() => { fake.outputs.length = 0; fake.calls.length = 0; fake.rejectDeviceConfig = false; });

describe('isolated credential-aware Git subprocess boundary', () => {
  it('uses an owned empty regular config instead of a Git-incompatible null device and removes only its temporary state', async () => {
    fake.rejectDeviceConfig = true;
    const configFiles: Array<{ file: string; regular: boolean; linked: boolean; links: number; size: number }> = [];
    const spawn = await import('child_process');
    const original = spawn.spawn;
    const inspect = vi.spyOn(spawn, 'spawn').mockImplementation((...args: Parameters<typeof original>) => {
      const options = args[2];
      if (options && 'env' in options && options.env?.GIT_CONFIG_GLOBAL) {
        const file = options.env.GIT_CONFIG_GLOBAL;
        const stat = fs.lstatSync(file);
        configFiles.push({ file, regular: stat.isFile(), linked: stat.isSymbolicLink(), links: stat.nlink, size: stat.size });
      }
      return original(...args);
    });
    try {
      await expect(createImportGit(source).run(['init'], { cwd: '/fixture' })).resolves.toBe('');
      expect(configFiles).toEqual([{ file: expect.any(String), regular: true, linked: false, links: 1, size: 0 }]);
      expect(fake.calls[2].env.GIT_CONFIG_SYSTEM).toBe(configFiles[0].file);
      expect(fake.calls[2].args).toContain(`core.hooksPath=${configFiles[0].file}`);
      expect(fs.existsSync(configFiles[0].file)).toBe(false);
      expect(fs.existsSync(path.dirname(configFiles[0].file))).toBe(false);
    } finally { inspect.mockRestore(); }
  });

  it('refuses changed isolation bytes after the authority await, preserving them without spawning the owned command', async () => {
    let file = '';
    const open = fs.openSync;
    const capture = vi.spyOn(fs, 'openSync').mockImplementation((name, flags, mode) => {
      const descriptor = open(name, flags, mode);
      if (typeof name === 'string' && flags === 'wx') file = name;
      return descriptor;
    });
    try {
      await expect(createImportGit(source).run(['checkout'], {
        cwd: '/fixture',
        assertCurrent: async () => {
          expect(file).not.toBe('');
          fs.writeFileSync(file, '[include]\npath = private-changed-config\n');
        },
      })).rejects.toMatchObject({ reason: 'git_config_unavailable' });
      expect(fake.calls).toHaveLength(2);
      expect(fs.readFileSync(file, 'utf8')).toContain('private-changed-config');
    } finally {
      capture.mockRestore();
      if (file) { fs.unlinkSync(file); fs.rmdirSync(path.dirname(file)); }
    }
  });

  it('carries only existing authorized credential config in environment, never argv, and disables unsafe inherited behavior', async () => {
    fake.outputs.push(
      { code: 1 },
      { stdout: 'credential.helper\n!authorized-helper --secret=private-value\0credential.https://github.com.username\nexisting-user\0filter.attack.smudge\nbad\0url.file:///evil.insteadof\nhttps://github.com/\0' },
      { stdout: `ref: refs/heads/trunk\tHEAD\n${sha}\tHEAD\n${sha}\trefs/heads/trunk\n` },
    );
    const result = await createImportGit(source).remote('https://github.com/example/repo.git', undefined);
    expect(result.branch).toBe('trunk');
    const call = fake.calls[2];
    expect(call.shell).toBe(false);
    expect(path.isAbsolute(call.command)).toBe(true);
    expect(call.args).toContain('ls-remote');
    expect(call.env).toMatchObject({
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '!authorized-helper --secret=private-value',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.username', GIT_CONFIG_NOSYSTEM: '1',
    });
    expect(call.env.GIT_TRACE).toBeUndefined();
    expect(call.env.GIT_DIR).toBeUndefined();
    expect(call.args.join(' ')).not.toMatch(/private-value|existing-user|filter\.attack|file:\/\/\/evil/);
    expect(call.args).toEqual(expect.arrayContaining(['protocol.allow=never', 'protocol.https.allow=always', 'http.followRedirects=false', 'core.symlinks=false', 'init.templateDir=']));
  });

  it('does not expose raw private/credential diagnostics on failure or progress', async () => {
    fake.outputs.push({ code: 1 }, { code: 1 }, { stderr: 'private repository https://token-secret@github.com/private/repo Receiving objects: 14%\n100%\n', code: 128 });
    const progress = vi.fn();
    await expect(createImportGit(source).run(['fetch', '--', 'origin'], { cwd: '/fixture', onProgress: progress })).rejects.toMatchObject({
      reason: 'git_failed', message: expect.stringContaining('Restore GitHub access'),
    });
    expect(progress.mock.calls).toEqual([[14], [100]]);
    try {
      fake.outputs.push({ code: 1 }, { code: 1 }, { stderr: 'token-secret', code: 128 });
      await createImportGit(source).remote('https://github.com/example/repo.git', undefined);
    } catch (error) {
      expect(String(error)).not.toContain('token-secret');
      expect(String(error)).not.toContain('private/repo');
    }
  });

  it('signals only the specific child for this import on cancellation', async () => {
    fake.outputs.push({ code: 1 }, { code: 1 }, { wait: true });
    const controller = new AbortController();
    const running = createImportGit(source).run(['fetch', '--', 'origin'], { cwd: '/fixture', signal: controller.signal });
    for (let i = 0; i < 10 && fake.calls.length < 3; i++) await Promise.resolve();
    expect(fake.calls).toHaveLength(3);
    controller.abort();
    await expect(running).rejects.toMatchObject({ reason: 'cancelled' });
    expect(fake.calls.map((call) => call.kills)).toEqual([[], [], ['SIGTERM']]);
    expect(fs.existsSync(fake.calls[2].env.GIT_CONFIG_GLOBAL!)).toBe(false);
    expect(fs.existsSync(path.dirname(fake.calls[2].env.GIT_CONFIG_GLOBAL!))).toBe(false);
  });

  it('refuses oversized stdout instead of exposing or retaining unbounded metadata', async () => {
    fake.outputs.push({ code: 1 }, { code: 1 }, { stdout: 'x'.repeat(1024 * 1024 + 1), wait: true });
    await expect(createImportGit(source).remote('https://github.com/example/repo.git', undefined)).rejects.toMatchObject({ reason: 'metadata_limit' });
    expect(fake.calls[2].kills).toEqual(['SIGTERM']);
  });

  it('refuses a relative-only executable search path without spawning anything', async () => {
    const runner = createImportGit(() => ({ ...source(), PATH: `.${path.delimiter}relative-bin${path.delimiter}` }));
    await expect(runner.run(['status'], { cwd: '/fixture' })).rejects.toMatchObject({ reason: 'git_unavailable' });
    expect(fake.calls).toEqual([]);
  });

  it('pins the absolute executable and absolute helper search directories before any later environment change', async () => {
    let current = source();
    const runner = createImportGit(() => current);
    await runner.run(['init'], { cwd: '/fixture' });
    const first = fake.calls[2];
    current = { ...current, PATH: `.${path.delimiter}relative-bin` };
    await runner.run(['status'], { cwd: '/fixture' });
    expect(fake.calls.every((call) => call.command === first.command && call.env.PATH === first.env.PATH)).toBe(true);
    expect(first.env.PATH?.split(path.delimiter).every((directory) => path.isAbsolute(directory))).toBe(true);
  });

  it('runs the final synchronous safety check after credential and authority awaits, before spawning the owned Git command', async () => {
    const assertCurrent = vi.fn(async () => {});
    const beforeSpawn = vi.fn(() => {
      expect(assertCurrent).toHaveBeenCalledOnce();
      expect(fake.calls).toHaveLength(2);
      throw new Error('test-only final safety refusal');
    });
    await expect(createImportGit(source).run(['checkout'], { cwd: '/fixture', assertCurrent, beforeSpawn })).rejects.toThrow('test-only final safety refusal');
    expect(fake.calls).toHaveLength(2);
  });
});
