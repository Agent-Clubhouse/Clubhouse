import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => os.tmpdir() } }));
vi.mock('../util/shell', () => ({ getShellEnvironment: vi.fn() }));
vi.mock('../services/plugin-manifest-registry', () => ({ getAllowedCommands: vi.fn(), refreshManifest: vi.fn() }));

import { ipcMain } from 'electron';
import { getShellEnvironment } from '../util/shell';
import { getAllowedCommands } from '../services/plugin-manifest-registry';
import { registerProcessHandlers } from './process-handlers';
import { IPC } from '../../shared/ipc-channels';

describe.runIf(process.platform === 'win32')('plugin process argv on real Windows (#2239)', () => {
  let tmp: string;
  let handler: (...args: any[]) => any;
  beforeEach(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'plugin argv '));
    vi.mocked(ipcMain.handle).mockImplementation((channel, callback) => {
      if (channel === IPC.PROCESS.EXEC) handler = callback;
    });
    registerProcessHandlers();
    vi.mocked(getShellEnvironment).mockReturnValue({ ...process.env, PATH: `${tmp};${path.dirname(process.execPath)}` });
  });
  afterEach(async () => {
    await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it.each(['exe', 'cmd', 'bat'])('round-trips plugin args through an allowed %s', async (kind) => {
    const script = path.join(tmp, 'echo args.js');
    await fs.promises.writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    const hostile = ['a&calc', '|', '^', '%PATH%', '!x!', '<in>out', 'say "hi"', '"&calc&"', 'C:\\data\\', 'with spaces', 'trailing '];
    const command = kind === 'exe' ? 'node' : `tool.${kind}`;
    if (kind !== 'exe') {
      await fs.promises.writeFile(path.join(tmp, command), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    }
    vi.mocked(getAllowedCommands).mockReturnValue([command]);
    const result = await handler({ sender: new EventEmitter() }, {
      pluginId: 'argv-plugin', command, args: kind === 'exe' ? [script, ...hostile] : hostile,
      projectPath: tmp,
    });
    expect({ stderr: result.stderr, exitCode: result.exitCode }).toEqual({ stderr: '', exitCode: 0 });
    expect(JSON.parse(result.stdout)).toEqual(hostile);
  }, 20_000);

  it('rejects a line break in an allowed batch command before executing it', async () => {
    await fs.promises.writeFile(path.join(tmp, 'tool.cmd'), '@echo should never run\r\n');
    vi.mocked(getAllowedCommands).mockReturnValue(['tool.cmd']);
    const result = await handler({ sender: new EventEmitter() }, {
      pluginId: 'argv-plugin', command: 'tool.cmd', args: ['a\r\ncalc'], projectPath: tmp,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('line break');
    expect(result.stdout).toBe('');
  });
});
