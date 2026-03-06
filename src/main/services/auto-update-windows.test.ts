import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { getSquirrelReleasesUrl, getSquirrelUpdateExePath } from './auto-update-service';

describe('auto-update-service: Squirrel native update helpers', () => {
  describe('getSquirrelReleasesUrl', () => {
    it('returns stable channel URL when previewChannel is false', () => {
      const url = getSquirrelReleasesUrl(false);
      expect(url).toContain('/squirrel/stable/');
    });

    it('returns preview channel URL when previewChannel is true', () => {
      const url = getSquirrelReleasesUrl(true);
      expect(url).toContain('/squirrel/preview/');
    });

    it('includes the platform-arch in the URL path', () => {
      const url = getSquirrelReleasesUrl(false);
      // The path segment should include platform-arch (query params follow)
      const urlPath = new URL(url).pathname;
      expect(urlPath).toMatch(/\/(darwin|win32|linux)-(x64|arm64)$/);
    });

    it('uses the correct base URL', () => {
      const url = getSquirrelReleasesUrl(false);
      expect(url.startsWith('https://stclubhousereleases.blob.core.windows.net/releases/squirrel/')).toBe(true);
    });

    it('includes telemetry query params', () => {
      const url = getSquirrelReleasesUrl(false);
      const parsed = new URL(url);
      expect(parsed.searchParams.has('v')).toBe(true);
      expect(parsed.searchParams.get('os')).toBe(process.platform);
      expect(parsed.searchParams.get('arch')).toBe(process.arch);
    });
  });

  describe('getSquirrelUpdateExePath', () => {
    it('returns a path ending with Update.exe', () => {
      const p = getSquirrelUpdateExePath();
      expect(p).toMatch(/Update\.exe$/);
    });

    it('resolves to one directory above the exe directory', () => {
      const p = getSquirrelUpdateExePath();
      const exeDir = path.dirname(process.execPath);
      const expected = path.resolve(exeDir, '..', 'Update.exe');
      expect(p).toBe(expected);
    });
  });
});
