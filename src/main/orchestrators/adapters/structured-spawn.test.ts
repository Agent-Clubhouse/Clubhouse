import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveStructuredSpawn } from './structured-spawn';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

describe('resolveStructuredSpawn', () => {
  afterEach(() => {
    setPlatform(originalPlatform);
  });

  describe('on Windows', () => {
    const npmDir = path.join(os.tmpdir(), 'npm global');

    // cmd.exe caret-escapes the binary once; a batch shim's arguments twice.
    const caret = (p: string): string => p.replace(/ /g, '^ ');

    it.each(['codex.cmd', 'COPILOT.CMD', 'agent.bat'])(
      'routes the %s batch shim through cmd.exe /d /s /c',
      (name) => {
        setPlatform('win32');
        const binary = path.join(npmDir, name);

        const spawn = resolveStructuredSpawn(binary, ['app-server', '--listen', 'stdio://']);

        // Node refuses to spawn .cmd/.bat without a shell (CVE-2024-27980)
        expect(spawn.binary).toBe('cmd.exe');
        expect(spawn.args).toEqual([
          '/d', '/s', '/c',
          `"${caret(binary)} ^^^"app-server^^^" ^^^"--listen^^^" ^^^"stdio://^^^""`,
        ]);
        expect(spawn.windowsVerbatimArguments).toBe(true);
      },
    );

    it('escapes cmd.exe metacharacters, quotes and percent signs (#2339)', () => {
      setPlatform('win32');
      const binary = path.join(npmDir, 'copilot.cmd');

      const spawn = resolveStructuredSpawn(binary, ['{"P":"%PATH%|x"}']);

      // MSVCRT: "{\"P\":\"%PATH%|x\"}", then every metacharacter carets twice.
      expect(spawn.args[3]).toBe(
        `"${caret(binary)} ^^^"{\\^^^"P\\^^^":\\^^^"^^^%PATH^^^%^^^|x\\^^^"}^^^""`,
      );
    });

    it('spawns a native .exe directly', () => {
      setPlatform('win32');
      const binary = path.join(npmDir, 'codex.exe');

      expect(resolveStructuredSpawn(binary, ['app-server'])).toEqual({
        binary,
        args: ['app-server'],
      });
    });

    it('runs a command prefix through cmd.exe instead of sh', () => {
      setPlatform('win32');
      const binary = path.join(npmDir, 'codex.exe');

      const spawn = resolveStructuredSpawn(binary, ['app-server'], 'call init.bat');

      expect(spawn.binary).toBe('cmd.exe');
      expect(spawn.args[3]).toBe(`"call init.bat & ${caret(binary)} ^"app-server^""`);
      expect(spawn.windowsVerbatimArguments).toBe(true);
    });

    it('rejects arguments with line breaks rather than truncating the launch', () => {
      setPlatform('win32');
      const binary = path.join(npmDir, 'claude.cmd');

      expect(() => resolveStructuredSpawn(binary, ['-p', 'line one\nline two']))
        .toThrow(/line break/);
    });
  });

  describe('on Windows with an npm shim', () => {
    let tmp: string | undefined;

    afterEach(async () => {
      if (tmp) await fs.promises.rm(tmp, { recursive: true, force: true });
      tmp = undefined;
    });

    async function writeNpmShim(): Promise<string> {
      tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'npm-shim-'));
      await fs.promises.writeFile(path.join(tmp, 'cli.js'), '');
      const shim = path.join(tmp, 'claude.cmd');
      await fs.promises.writeFile(
        shim,
        '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\cli.js" %*\r\n',
      );
      return shim;
    }

    it('spawns node on the shim\'s script, so arguments skip cmd.exe (#2341)', async () => {
      setPlatform('win32');
      const shim = await writeNpmShim();
      const args = ['--append-system-prompt', 'line one\nline two', '{"url":"https://h/mcp?x=a%20b"}'];

      expect(resolveStructuredSpawn(shim, args)).toEqual({
        binary: 'node',
        args: [path.join(tmp!, 'cli.js'), ...args],
      });
    });

    it('still runs the shim through cmd.exe when there is a command prefix', async () => {
      setPlatform('win32');
      const shim = await writeNpmShim();

      expect(resolveStructuredSpawn(shim, ['-p'], 'call init.bat').binary).toBe('cmd.exe');
    });
  });

  describe('on POSIX', () => {
    it('spawns the binary directly', () => {
      setPlatform('linux');
      const binary = path.join(os.tmpdir(), 'bin', 'codex');

      expect(resolveStructuredSpawn(binary, ['app-server'])).toEqual({
        binary,
        args: ['app-server'],
      });
    });

    it('does not treat a .cmd name specially', () => {
      setPlatform('darwin');

      expect(resolveStructuredSpawn('tool.cmd', ['x']).binary).toBe('tool.cmd');
    });

    it('wraps a command prefix with sh -c and exec "$@"', () => {
      setPlatform('linux');
      const binary = path.join(os.tmpdir(), 'bin', 'codex');

      expect(resolveStructuredSpawn(binary, ['app-server'], '. ./init.sh')).toEqual({
        binary: 'sh',
        args: ['-c', '. ./init.sh && exec "$@"', '_', binary, 'app-server'],
      });
    });

    it('rejects a prefix with disallowed metacharacters', () => {
      setPlatform('linux');

      expect(() => resolveStructuredSpawn('codex', [], 'x; rm -rf /'))
        .toThrow(/disallowed/);
    });
  });
});
