import { describe, it, expect, afterEach } from 'vitest';
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
          `""${binary}" "app-server" "--listen" "stdio://""`,
        ]);
        expect(spawn.windowsVerbatimArguments).toBe(true);
      },
    );

    it('quotes cmd.exe metacharacters, quotes and percent signs', () => {
      setPlatform('win32');
      const binary = path.join(npmDir, 'copilot.cmd');

      const spawn = resolveStructuredSpawn(binary, [
        '--additional-mcp-config',
        '{"mcpServers":{"a&b":{"env":{"P":"%PATH%|x"}}}}',
      ]);

      expect(spawn.args[3]).toBe(
        `""${binary}" "--additional-mcp-config" "{""mcpServers"":{""a&b"":{""env"":{""P"":""%%PATH%%|x""}}}}""`,
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
      expect(spawn.args[3]).toBe(`"call init.bat & "${binary}" "app-server""`);
      expect(spawn.windowsVerbatimArguments).toBe(true);
    });

    it('rejects arguments with line breaks rather than truncating the launch', () => {
      setPlatform('win32');
      const binary = path.join(npmDir, 'claude.cmd');

      expect(() => resolveStructuredSpawn(binary, ['-p', 'line one\nline two']))
        .toThrow(/line break/);
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
