import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { killStructuredChild, resolveStructuredSpawn } from './structured-spawn';
import { writeFakeCliShims, type FakeCliReport } from './testing/fake-cli';
import { clearBinaryCache, findBinaryInPath } from '../shared';

// Real processes, Windows only: a .cmd shim runs through cmd.exe, and the CLI
// it starts must die with it. The platform-mocked cases are in
// structured-spawn.kill.test.ts.

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.runIf(process.platform === 'win32')('killStructuredChild on a real .cmd shim', () => {
  let tmp: string | undefined;
  let child: ChildProcess | undefined;
  let fakePid: number | undefined;

  afterEach(async () => {
    if (fakePid && alive(fakePid)) process.kill(fakePid);
    if (child && child.exitCode === null) child.kill();
    if (tmp) await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('kills the fake CLI under cmd.exe, not just cmd.exe', async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kill-tree-'));
    // One client entry the fake waits on forever, so only a kill ends it.
    const fixture = path.join(tmp, 'wait.jsonl');
    await fs.promises.writeFile(fixture, [
      JSON.stringify({ kind: 'header', format: 'clubhouse-chat-fixture', version: 1, protocol: 'codex-app-server', cli: { name: 'codex', version: '0.0.0' }, source: 'hand-made' }),
      JSON.stringify({ from: 'client', msg: { id: 1, method: 'initialize', params: {} } }),
    ].join('\n') + '\n');
    const report = path.join(tmp, 'report.json');
    const shims = await writeFakeCliShims(path.join(tmp, 'bin'), { codex: { fixture, report } });
    expect(shims.codex.endsWith('.cmd')).toBe(true);

    const cmd = resolveStructuredSpawn(shims.codex, ['app-server']);
    expect(cmd.binary).toBe('cmd.exe');
    child = spawn(cmd.binary, cmd.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: cmd.windowsVerbatimArguments,
    });

    await expect.poll(() => fs.existsSync(report), { timeout: 10_000, interval: 50 }).toBe(true);
    fakePid = (JSON.parse(await fs.promises.readFile(report, 'utf8')) as FakeCliReport).pid;
    expect(fakePid).not.toBe(child.pid); // the fake is cmd.exe's child, not ours
    expect(alive(fakePid)).toBe(true);

    await killStructuredChild(child);

    await expect.poll(() => alive(fakePid!), { timeout: 5_000, interval: 50 }).toBe(false);
  }, 20_000);
});

describe.runIf(process.platform === 'win32')('discovery and launch of a real npm-style install', () => {
  let tmp: string | undefined;
  const originalPATH = process.env.PATH;

  afterEach(async () => {
    process.env.PATH = originalPATH;
    clearBinaryCache();
    if (tmp) await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it.each(['copilot', 'claude', 'codex'])(
    'finds %s.cmd beside its shell script and preserves arguments through it',
    async (name) => {
      tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'npm shim '));
      const bin = path.join(tmp, 'npm global');
      await fs.promises.mkdir(bin);
      const echo = path.join(tmp, 'echo args.js');
      await fs.promises.writeFile(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
      // The layout npm writes: a Unix shell script and its Windows batch shim.
      await fs.promises.writeFile(path.join(bin, name), '#!/bin/sh\nexit 1\n');
      await fs.promises.writeFile(path.join(bin, `${name}.cmd`), `@"${process.execPath}" "${echo}" %*\r\n`);
      process.env.PATH = bin;
      clearBinaryCache();

      const found = findBinaryInPath([name], []);
      expect(found).toBe(path.join(bin, `${name}.cmd`));

      const args = ['--flag', 'value with spaces', 'a&b'];
      const cmd = resolveStructuredSpawn(found, args);
      const child = spawn(cmd.binary, cmd.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: cmd.windowsVerbatimArguments,
      });
      let out = '';
      child.stdout!.on('data', (d) => { out += String(d); });
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual(args);
    },
    20_000,
  );
});
