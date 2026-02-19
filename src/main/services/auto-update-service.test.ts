import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isNewerVersion, verifySHA256 } from './auto-update-service';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

describe('auto-update-service', () => {
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

    it('defaults to .zip when URL has no extension', () => {
      const url = 'https://example.com/artifacts/Clubhouse';
      const ext = path.extname(new URL(url).pathname) || '.zip';
      expect(ext).toBe('.zip');
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
});
