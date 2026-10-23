import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, createReadStream, existsSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';

const require = createRequire(import.meta.url);
const rebuildRequire = createRequire(require.resolve('@electron/rebuild'));
const gypRequire = createRequire(rebuildRequire.resolve('@electron/node-gyp/package.json'));
// Resolve through the actual consumers: a root-only override can leave an
// unsafe nested copy behind. These tests cover the APIs those consumers use.
const tar = rebuildRequire('tar') as typeof import('tar');
const gypTar = gypRequire('tar') as typeof import('tar');
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'clubhouse-tar-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('patched Forge tar extraction', () => {
  it('resolves the patched tar for rebuild and node-gyp', () => {
    expect(rebuildRequire('tar/package.json').version).toBe('7.5.22');
    expect(gypRequire('tar/package.json').version).toBe('7.5.22');
  });

  it('preserves fresh compiler executable modes through the clang file API', async () => {
    const source = temp(), dest = temp(), file = join(temp(), 'clang.tar.gz');
    mkdirSync(join(source, 'bin'));
    writeFileSync(join(source, 'bin/clang'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await tar.c({ file, cwd: source, gzip: true }, ['bin']);
    await tar.x({ file, cwd: dest });
    expect(readFileSync(join(dest, 'bin/clang'), 'utf8')).toContain('exit 0');
    if (process.platform !== 'win32') expect(statSync(join(dest, 'bin/clang')).mode & 0o777).toBe(0o755);
  });

  it('supports node-gyp file and streaming extraction with strip, filter and onwarn', async () => {
    const source = temp(), file = join(temp(), 'headers.tar.gz');
    mkdirSync(join(source, 'node/include'), { recursive: true });
    writeFileSync(join(source, 'node/include/node.h'), '#define TEST 1\n');
    writeFileSync(join(source, 'node/include/ignored.txt'), 'not a header');
    await tar.c({ file, cwd: source, gzip: true }, ['node']);
    for (const streaming of [false, true]) {
      const dest = temp(), warnings: string[] = [];
      const options = { cwd: dest, strip: 1, filter: (path: string) => path.endsWith('.h'), onwarn: (code: string) => { warnings.push(code); } };
      if (streaming) await pipeline(createReadStream(file), gypTar.extract(options));
      else await gypTar.extract({ ...options, file });
      expect(readFileSync(join(dest, 'include/node.h'), 'utf8')).toBe('#define TEST 1\n');
      expect(() => statSync(join(dest, 'include/ignored.txt'))).toThrow();
      expect(warnings).toEqual([]);
    }
  });

  it('rejects excessive decompression with bounded input and an explicit low limit', async () => {
    const source = temp(), file = join(temp(), 'bounded.tar.gz');
    // Only 64 KiB, never a resource-exhaustion payload. The low test threshold
    // exercises the upstream guard without allocating or writing large data.
    writeFileSync(join(source, 'zeros'), Buffer.alloc(64 * 1024));
    await tar.c({ file, cwd: source, gzip: true }, ['zeros']);
    await expect(tar.t({ file, maxDecompressionRatio: 2 })).rejects.toThrow(/decompression|ratio/i);
  });
});

describe('maintained Electron ZIP extraction', () => {
  const packagerRequire = createRequire(require.resolve('@electron/packager'));
  // Exercise Packager's CommonJS/default-import wrapper, not just the fork API.
  const { extractElectronZip } = packagerRequire('./unzip.js') as { extractElectronZip: (file: string, dir: string) => Promise<void> };

  it.skipIf(process.platform === 'win32')('extracts ordinary files, executable modes and in-tree framework symlinks', async () => {
    const source = temp(), dest = temp(), file = join(source, 'electron.zip');
    const zip = new AdmZip();
    zip.addFile('Framework/Versions/A/engine', Buffer.from('engine'), '', 0o755);
    zip.addFile('Framework/Versions/Current', Buffer.from('A'));
    zip.getEntry('Framework/Versions/Current')!.attr = (0o120777 << 16) >>> 0;
    zip.writeZip(file);
    await extractElectronZip(file, dest);
    expect(readFileSync(join(dest, 'Framework/Versions/Current/engine'), 'utf8')).toBe('engine');
    if (process.platform !== 'win32') {
      expect(statSync(join(dest, 'Framework/Versions/A/engine')).mode & 0o777).toBe(0o755);
      expect(readlinkSync(join(dest, 'Framework/Versions/Current'))).toBe('A');
    }
  });

  it('rejects a symlink escaping the extraction root without writing through it', async () => {
    const root = temp(), dest = join(root, 'extract'), outside = join(root, 'outside');
    mkdirSync(dest); mkdirSync(outside);
    const zip = new AdmZip(), file = join(root, 'escape.zip');
    // Even a regression can only write within this test-owned temp directory.
    zip.addFile('link', Buffer.from('../outside'));
    zip.getEntry('link')!.attr = (0o120777 << 16) >>> 0;
    zip.getEntry('link')!.header.made = 0x0314;
    zip.addFile('link/sentinel', Buffer.from('must not escape'));
    zip.writeZip(file);
    await expect(extractElectronZip(file, dest)).rejects.toThrow();
    expect(existsSync(join(outside, 'sentinel'))).toBe(false);
  });
});
