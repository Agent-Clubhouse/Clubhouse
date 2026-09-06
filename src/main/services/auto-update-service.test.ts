import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isNewerVersion, parseVersion, verifySHA256, appendTelemetryParams, isTransientError, withRetry, shellEscape, buildMacUpdateScript, buildMacQuitUpdateScript, getSquirrelReleasesUrl, getSquirrelUpdateExePath, applyPlatformUpdate, platformUpdateHandlers } from './auto-update-service';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

describe('auto-update-service', () => {
  describe('platform update dispatch', () => {
    it('uses the same platform implementation for apply and apply-on-quit options', async () => {
      const applyLinuxUpdate = vi.spyOn(platformUpdateHandlers, 'applyLinuxUpdate').mockResolvedValue(true);
      const context = { downloadPath: '/tmp/Clubhouse.deb', version: '1.0.0', artifactUrl: null };

      await expect(applyPlatformUpdate(context, { relaunch: true }, 'linux')).resolves.toBe(true);
      await expect(applyPlatformUpdate(context, { relaunch: false }, 'linux')).resolves.toBe(true);

      expect(applyLinuxUpdate).toHaveBeenNthCalledWith(1, context, { relaunch: true });
      expect(applyLinuxUpdate).toHaveBeenNthCalledWith(2, context, { relaunch: false });
      applyLinuxUpdate.mockRestore();
    });

  });

  describe('isNewerVersion', () => {
    it('returns true when major version is higher', () => {
      expect(isNewerVersion('1.0.0', '0.25.0')).toBe(true);
    });

    it('returns true when minor version is higher', () => {
      expect(isNewerVersion('0.26.0', '0.25.0')).toBe(true);
    });

    it('returns true when patch version is higher', () => {
      expect(isNewerVersion('0.25.1', '0.25.0')).toBe(true);
    });

    it('returns false when versions are equal', () => {
      expect(isNewerVersion('0.25.0', '0.25.0')).toBe(false);
    });

    it('returns false when version is lower', () => {
      expect(isNewerVersion('0.24.0', '0.25.0')).toBe(false);
    });

    it('returns false when major is lower despite higher minor', () => {
      expect(isNewerVersion('0.99.0', '1.0.0')).toBe(false);
    });

    it('handles two-part versions', () => {
      expect(isNewerVersion('1.0', '0.9')).toBe(true);
    });

    it('handles single-part versions', () => {
      expect(isNewerVersion('2', '1')).toBe(true);
    });

    it('returns true for 1.0.0 vs 0.0.1', () => {
      expect(isNewerVersion('1.0.0', '0.0.1')).toBe(true);
    });

    it('returns false for 0.0.1 vs 1.0.0', () => {
      expect(isNewerVersion('0.0.1', '1.0.0')).toBe(false);
    });

    // Preview (rc) version comparisons — legacy format
    it('rc version is newer than older stable', () => {
      expect(isNewerVersion('0.32.0rc', '0.31.0')).toBe(true);
    });

    it('stable version is newer than same-base rc', () => {
      expect(isNewerVersion('0.32.0', '0.32.0rc')).toBe(true);
    });

    it('rc version is not newer than same-base stable', () => {
      expect(isNewerVersion('0.32.0rc', '0.32.0')).toBe(false);
    });

    it('two equal rc versions are not newer', () => {
      expect(isNewerVersion('0.32.0rc', '0.32.0rc')).toBe(false);
    });

    it('higher-base rc is newer than lower stable', () => {
      expect(isNewerVersion('1.0.0rc', '0.99.0')).toBe(true);
    });

    it('lower-base rc is not newer than higher stable', () => {
      expect(isNewerVersion('0.31.0rc', '0.32.0')).toBe(false);
    });

    // Beta prerelease version comparisons
    it('beta version is newer than older stable', () => {
      expect(isNewerVersion('0.34.0-beta.1', '0.33.0')).toBe(true);
    });

    it('stable version is newer than same-base beta', () => {
      expect(isNewerVersion('0.34.0', '0.34.0-beta.2')).toBe(true);
    });

    it('beta version is not newer than same-base stable', () => {
      expect(isNewerVersion('0.34.0-beta.2', '0.34.0')).toBe(false);
    });

    it('higher beta number is newer than lower', () => {
      expect(isNewerVersion('0.34.0-beta.2', '0.34.0-beta.1')).toBe(true);
    });

    it('lower beta number is not newer than higher', () => {
      expect(isNewerVersion('0.34.0-beta.1', '0.34.0-beta.2')).toBe(false);
    });

    it('equal beta versions are not newer', () => {
      expect(isNewerVersion('0.34.0-beta.1', '0.34.0-beta.1')).toBe(false);
    });

    it('beta is newer than legacy rc with same base', () => {
      expect(isNewerVersion('0.34.0-beta.1', '0.34.0rc')).toBe(true);
    });

    it('lower-base beta is not newer than higher stable', () => {
      expect(isNewerVersion('0.33.0-beta.1', '0.34.0')).toBe(false);
    });
  });

  describe('parseVersion', () => {
    it('parses stable version', () => {
      const result = parseVersion('1.2.3');
      expect(result).toEqual({ parts: [1, 2, 3], prerelease: false, prereleaseNum: 0 });
    });

    it('parses rc version', () => {
      const result = parseVersion('1.2.3rc');
      expect(result).toEqual({ parts: [1, 2, 3], prerelease: true, prereleaseNum: 0 });
    });

    it('parses two-part version', () => {
      const result = parseVersion('1.0');
      expect(result).toEqual({ parts: [1, 0], prerelease: false, prereleaseNum: 0 });
    });

    it('parses two-part rc version', () => {
      const result = parseVersion('1.0rc');
      expect(result).toEqual({ parts: [1, 0], prerelease: true, prereleaseNum: 0 });
    });

    it('parses beta version', () => {
      const result = parseVersion('0.34.0-beta.1');
      expect(result).toEqual({ parts: [0, 34, 0], prerelease: true, prereleaseNum: 1 });
    });

    it('parses higher beta number', () => {
      const result = parseVersion('0.34.0-beta.15');
      expect(result).toEqual({ parts: [0, 34, 0], prerelease: true, prereleaseNum: 15 });
    });
  });

  describe('artifact URL extension parsing', () => {
    // The downloadUpdate function uses: path.extname(new URL(url).pathname) || '.zip'
    // This determines the local file extension, which is critical for Windows (.exe)

    it('extracts .exe for Windows installer URLs', () => {
      const url = 'https://stclubhousereleases.blob.core.windows.net/releases/artifacts/Clubhouse-1.0.0-win32-x64-Setup.exe';
      const ext = path.extname(new URL(url).pathname) || '.zip';
      expect(ext).toBe('.exe');
    });

    it('extracts .zip for macOS update URLs', () => {
      const url = 'https://stclubhousereleases.blob.core.windows.net/releases/artifacts/Clubhouse-1.0.0-darwin-arm64.zip';
      const ext = path.extname(new URL(url).pathname) || '.zip';
      expect(ext).toBe('.zip');
    });

    it('extracts .dmg for macOS installer URLs', () => {
      const url = 'https://stclubhousereleases.blob.core.windows.net/releases/artifacts/Clubhouse-1.0.0-darwin-arm64.dmg';
      const ext = path.extname(new URL(url).pathname) || '.zip';
      expect(ext).toBe('.dmg');
    });

    it('extracts .deb for Linux package URLs', () => {
      const url = 'https://stclubhousereleases.blob.core.windows.net/releases/artifacts/Clubhouse-1.0.0-linux-x64.deb';
      const ext = path.extname(new URL(url).pathname) || '.zip';
      expect(ext).toBe('.deb');
    });

    it('extracts .rpm for Linux package URLs', () => {
      const url = 'https://stclubhousereleases.blob.core.windows.net/releases/artifacts/Clubhouse-1.0.0-linux-x64.rpm';
      const ext = path.extname(new URL(url).pathname) || '.zip';
      expect(ext).toBe('.rpm');
    });

    it('defaults to .zip when URL has no extension', () => {
      const url = 'https://example.com/artifacts/Clubhouse';
      const ext = path.extname(new URL(url).pathname) || '.zip';
      expect(ext).toBe('.zip');
    });
  });

  describe('appendTelemetryParams', () => {
    it('appends v, os, and arch query params to a plain URL', () => {
      const result = appendTelemetryParams('https://example.com/latest.json');
      expect(result).toMatch(/^https:\/\/example\.com\/latest\.json\?v=.+&os=.+&arch=.+$/);
    });

    it('uses & separator when URL already has query params', () => {
      const result = appendTelemetryParams('https://example.com/latest.json?foo=bar');
      expect(result).toMatch(/\?foo=bar&v=.+&os=.+&arch=.+$/);
      // Should not have double ?
      expect(result.split('?').length).toBe(2);
    });

    it('includes the current platform and arch', () => {
      const result = appendTelemetryParams('https://example.com/file');
      expect(result).toContain(`os=${process.platform}`);
      expect(result).toContain(`arch=${process.arch}`);
    });

    it('does not alter the URL pathname (extension parsing still works)', () => {
      const url = 'https://example.com/artifacts/Clubhouse-1.0.0-Setup.exe';
      const result = appendTelemetryParams(url);
      // pathname-based extension parsing should still yield .exe
      const ext = path.extname(new URL(result).pathname);
      expect(ext).toBe('.exe');
    });
  });

  describe('isTransientError', () => {
    it('returns true for ETIMEDOUT', () => {
      expect(isTransientError(new Error('read ETIMEDOUT'))).toBe(true);
    });

    it('returns true for ECONNRESET', () => {
      expect(isTransientError(new Error('socket hang up ECONNRESET'))).toBe(true);
    });

    it('returns true for ECONNREFUSED', () => {
      expect(isTransientError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true);
    });

    it('returns true for ENOTFOUND', () => {
      expect(isTransientError(new Error('getaddrinfo ENOTFOUND example.com'))).toBe(true);
    });

    it('returns true for "Request timed out"', () => {
      expect(isTransientError(new Error('Request timed out'))).toBe(true);
    });

    it('returns true for "Download timed out"', () => {
      expect(isTransientError(new Error('Download timed out'))).toBe(true);
    });

    it('returns false for HTTP 404', () => {
      expect(isTransientError(new Error('HTTP 404 fetching ...'))).toBe(false);
    });

    it('returns false for checksum failure', () => {
      expect(isTransientError(new Error('SHA-256 checksum verification failed'))).toBe(false);
    });

    it('handles non-Error values', () => {
      expect(isTransientError('ETIMEDOUT')).toBe(true);
      expect(isTransientError('some other error')).toBe(false);
    });
  });

  describe('withRetry', () => {
    it('returns result on first success', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const result = await withRetry(fn, { retries: 3, baseDelayMs: 1 });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on transient error and succeeds', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('read ETIMEDOUT'))
        .mockResolvedValueOnce('ok');
      const result = await withRetry(fn, { retries: 3, baseDelayMs: 1 });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('throws immediately on non-transient error', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('HTTP 404'));
      await expect(withRetry(fn, { retries: 3, baseDelayMs: 1 })).rejects.toThrow('HTTP 404');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws after all retries exhausted', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('read ETIMEDOUT'));
      await expect(
        withRetry(fn, { retries: 2, baseDelayMs: 1 }),
      ).rejects.toThrow('read ETIMEDOUT');
      expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    });

    it('uses exponential backoff delays', async () => {
      vi.useFakeTimers();
      try {
        const fn = vi.fn()
          .mockRejectedValueOnce(new Error('ECONNRESET'))
          .mockRejectedValueOnce(new Error('ECONNRESET'))
          .mockResolvedValueOnce('ok');

        const promise = withRetry(fn, { retries: 3, baseDelayMs: 1000 });

        // First retry delay: 1000 * 2^0 = 1000ms
        expect(fn).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(999);
        expect(fn).toHaveBeenCalledTimes(1); // not yet
        await vi.advanceTimersByTimeAsync(1);
        expect(fn).toHaveBeenCalledTimes(2);

        // Second retry delay: 1000 * 2^1 = 2000ms
        await vi.advanceTimersByTimeAsync(1999);
        expect(fn).toHaveBeenCalledTimes(2); // not yet
        await vi.advanceTimersByTimeAsync(1);
        expect(fn).toHaveBeenCalledTimes(3);

        const result = await promise;
        expect(result).toBe('ok');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('verifySHA256', () => {
    let tmpFile: string;

    beforeEach(() => {
      tmpFile = path.join(os.tmpdir(), `test-sha256-${Date.now()}.txt`);
    });

    afterEach(() => {
      try { fs.unlinkSync(tmpFile); } catch {}
    });

    it('returns true for matching hash', async () => {
      const content = 'hello world';
      fs.writeFileSync(tmpFile, content);
      const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
      const result = await verifySHA256(tmpFile, expectedHash);
      expect(result).toBe(true);
    });

    it('returns false for mismatched hash', async () => {
      fs.writeFileSync(tmpFile, 'hello world');
      const result = await verifySHA256(tmpFile, 'deadbeef'.repeat(8));
      expect(result).toBe(false);
    });

    it('rejects for non-existent file', async () => {
      await expect(verifySHA256('/tmp/nonexistent-file-12345.txt', 'abc')).rejects.toThrow();
    });

    it('handles empty file', async () => {
      fs.writeFileSync(tmpFile, '');
      const expectedHash = crypto.createHash('sha256').update('').digest('hex');
      const result = await verifySHA256(tmpFile, expectedHash);
      expect(result).toBe(true);
    });

    it('handles binary content', async () => {
      const buf = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      fs.writeFileSync(tmpFile, buf);
      const expectedHash = crypto.createHash('sha256').update(buf).digest('hex');
      const result = await verifySHA256(tmpFile, expectedHash);
      expect(result).toBe(true);
    });
  });

  describe('shellEscape', () => {
    it('wraps simple strings in single quotes', () => {
      expect(shellEscape('/Applications/MyApp.app')).toBe("'/Applications/MyApp.app'");
    });

    it('escapes single quotes within the string', () => {
      expect(shellEscape("it's")).toBe("'it'\\''s'");
    });

    it('neutralizes backticks', () => {
      const escaped = shellEscape('path/`whoami`/file');
      expect(escaped).toBe("'path/`whoami`/file'");
      // Inside single quotes, backticks are literal — no command substitution
    });

    it('neutralizes $() subshell syntax', () => {
      const escaped = shellEscape('path/$(rm -rf /)/file');
      expect(escaped).toBe("'path/$(rm -rf /)/file'");
    });

    it('neutralizes double quotes', () => {
      const escaped = shellEscape('path "with" quotes');
      expect(escaped).toBe("'path \"with\" quotes'");
    });
  });

  describe('buildMacUpdateScript', () => {
    it('uses single-quoted escaped paths', () => {
      const script = buildMacUpdateScript(
        '/Applications/My App.app',
        '/tmp/New App.app',
        '/tmp/extract',
        '/tmp/download.zip',
        '/tmp/script.sh',
      );
      expect(script).toContain("'/Applications/My App.app'");
      expect(script).toContain("'/tmp/New App.app'");
      expect(script).not.toContain('"');
    });

    it('prevents injection via malicious path with backticks', () => {
      const script = buildMacUpdateScript(
        '/Applications/`curl evil.com`.app',
        '/tmp/new.app',
        '/tmp/extract',
        '/tmp/download.zip',
        '/tmp/script.sh',
      );
      // Backticks are inside single quotes, so they're literal
      expect(script).toContain("'/Applications/`curl evil.com`.app'");
    });
  });

  describe('buildMacQuitUpdateScript', () => {
    it('uses single-quoted escaped paths', () => {
      const script = buildMacQuitUpdateScript(
        '/Applications/My App.app',
        '/tmp/download.zip',
        '/tmp/extract',
        '/tmp/script.sh',
      );
      expect(script).toContain("'/Applications/My App.app'");
      expect(script).not.toContain('"/Applications/My App.app"');
    });

    it('prevents injection via $() in path', () => {
      const script = buildMacQuitUpdateScript(
        '/Applications/$(rm -rf /).app',
        '/tmp/download.zip',
        '/tmp/extract',
        '/tmp/script.sh',
      );
      expect(script).toContain("'/Applications/$(rm -rf /).app'");
    });
  });

  // ── execFileSync arg-array construction (TC-HIGH) ──────────────────────────
  // applyUpdate() calls execFileSync with array arguments (never a shell string)
  // to prevent shell injection. The tests below verify the arg-array construction
  // indirectly via the exported helper functions that build the argument values.

  describe('getSquirrelReleasesUrl — arg-array value safety', () => {
    it('returns a URL-safe string for the stable channel', () => {
      const url = getSquirrelReleasesUrl(false);
      // Must be a valid URL — no shell metacharacters that could be dangerous
      // if mistakenly passed to a shell-form exec call.
      expect(url).toMatch(/^https?:\/\//);
      expect(url).not.toContain(';');
      expect(url).not.toContain('&&');
      expect(url).not.toContain('|');
      expect(url).not.toContain('`');
    });

    it('returns a URL-safe string for the preview channel', () => {
      const url = getSquirrelReleasesUrl(true);
      expect(url).toMatch(/^https?:\/\//);
      expect(url).toContain('preview');
    });

    it('stable channel does not contain "preview"', () => {
      const stable = getSquirrelReleasesUrl(false);
      expect(stable).toContain('stable');
      expect(stable).not.toContain('preview');
    });
  });

  describe('getSquirrelUpdateExePath — arg-array value safety', () => {
    it('resolves to an absolute path containing Update.exe', () => {
      const exePath = getSquirrelUpdateExePath();
      // Must be an absolute OS path — safe to pass as a literal execFileSync arg.
      expect(path.isAbsolute(exePath)).toBe(true);
      expect(exePath).toContain('Update.exe');
    });

    it('does not contain shell metacharacters', () => {
      const exePath = getSquirrelUpdateExePath();
      expect(exePath).not.toContain(';');
      expect(exePath).not.toContain('&&');
      expect(exePath).not.toContain('|');
      expect(exePath).not.toContain('`');
      expect(exePath).not.toContain('$');
    });
  });

  describe('buildMacUpdateScript — exec arg safety (no unquoted shell metacharacters)', () => {
    it('all path arguments are individually shell-escaped via shellEscape()', () => {
      // Each arg must be wrapped in single quotes. This verifies that the script
      // construction uses shellEscape() for every path rather than raw interpolation,
      // which matches how execFileSync-launched bash would interpret the args.
      const script = buildMacUpdateScript(
        '/Applications/Clubhouse.app',
        '/tmp/new.app',
        '/tmp/extract',
        '/tmp/download.zip',
        '/tmp/script.sh',
      );
      // Each path appears as a single-quoted literal in the script
      expect(script).toContain("'/Applications/Clubhouse.app'");
      expect(script).toContain("'/tmp/new.app'");
      expect(script).toContain("'/tmp/extract'");
      expect(script).toContain("'/tmp/download.zip'");
      expect(script).toContain("'/tmp/script.sh'");
    });

    it('does not use eval or unquoted command substitution', () => {
      const script = buildMacUpdateScript(
        '/Applications/App.app',
        '/tmp/new.app',
        '/tmp/extract',
        '/tmp/download.zip',
        '/tmp/script.sh',
      );
      // Script only uses rm/mv/open with shell-escaped args — no eval, no $() subshell
      expect(script).not.toContain('eval');
      expect(script).not.toMatch(/\$\([^)]/);
    });

    it('quit-update script uses unzip with shell-escaped positional args, not eval', () => {
      const script = buildMacQuitUpdateScript(
        '/Applications/App.app',
        '/tmp/download.zip',
        '/tmp/extract',
        '/tmp/script.sh',
      );
      // unzip is called with positional args (all paths are shell-escaped)
      expect(script).toContain('unzip');
      expect(script).not.toContain('eval');
      // The only $() allowed is the safe APP_PATH=$(find ...) variable assignment
      // with a shell-escaped path; it should NOT include raw user-controlled data.
      const subshells = script.match(/\$\([^)]+\)/g) ?? [];
      for (const s of subshells) {
        // Each subshell should reference the shellEscape-d tmpExtract path
        // and use 'find' with controlled args — no user-supplied raw string
        expect(s).toContain('find');
      }
    });

    it('a path with spaces is quoted correctly and does not split into multiple args', () => {
      const script = buildMacUpdateScript(
        '/Applications/My Clubhouse.app',
        '/tmp/My New.app',
        '/tmp/extract dir',
        '/tmp/my download.zip',
        '/tmp/my script.sh',
      );
      // Space-containing paths must be single-quoted — spaces inside quotes are literal
      expect(script).toContain("'/Applications/My Clubhouse.app'");
      expect(script).toContain("'/tmp/My New.app'");
    });
  });
});
