import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import { isPathWithinRoot, resolvePluginModulePath } from './plugin-protocol';
import { buildPluginModuleUrl } from '../shared/plugin-protocol-url';

const ROOT = '/home/me/.clubhouse/plugins';

describe('isPathWithinRoot', () => {
  it('accepts the root and paths under it', () => {
    expect(isPathWithinRoot(`${ROOT}/p/dist/main.js`, ROOT)).toBe(true);
    expect(isPathWithinRoot(ROOT, ROOT)).toBe(true);
  });

  it('rejects sibling-prefix paths (plugins-evil vs plugins)', () => {
    expect(isPathWithinRoot('/home/me/.clubhouse/plugins-evil/x.js', ROOT)).toBe(false);
  });

  it('rejects paths outside the root', () => {
    expect(isPathWithinRoot('/etc/passwd', ROOT)).toBe(false);
  });
});

describe('resolvePluginModulePath', () => {
  // realpath that returns the path unchanged (no symlinks) and pretends it exists.
  const identityRealpath = (p: string) => Promise.resolve(path.resolve(p));

  it('resolves a valid in-root URL to its real path', async () => {
    const abs = `${ROOT}/automations/dist/main.js`;
    const url = buildPluginModuleUrl(abs, 123);
    await expect(resolvePluginModulePath(url, ROOT, identityRealpath)).resolves.toBe(abs);
  });

  it('ignores the version prefix when resolving the file', async () => {
    const abs = `${ROOT}/p/dist/main.js`;
    const v1 = await resolvePluginModulePath(buildPluginModuleUrl(abs, 1), ROOT, identityRealpath);
    const v2 = await resolvePluginModulePath(buildPluginModuleUrl(abs, 999), ROOT, identityRealpath);
    expect(v1).toBe(abs);
    expect(v2).toBe(abs);
  });

  it('rejects a malformed / wrong-scheme URL', async () => {
    await expect(resolvePluginModulePath('file:///x.js', ROOT, identityRealpath)).rejects.toThrow(
      /Invalid plugin module URL/,
    );
  });

  it('rejects a path that escapes the root via ../ (lexical)', async () => {
    // Construct a URL whose decoded path climbs out of the root.
    const url = buildPluginModuleUrl(`${ROOT}/../../etc/passwd`, 1);
    await expect(resolvePluginModulePath(url, ROOT, identityRealpath)).rejects.toThrow(/Access denied/);
  });

  it('rejects a SYMLINK that escapes the root (realpath resolves outside)', async () => {
    const abs = `${ROOT}/p/dist/main.js`;
    const url = buildPluginModuleUrl(abs, 1);
    // realpath resolves the in-root path to an out-of-root target (symlink escape).
    const escapingRealpath = vi.fn().mockResolvedValue('/etc/shadow');
    await expect(resolvePluginModulePath(url, ROOT, escapingRealpath)).rejects.toThrow(/Access denied/);
    expect(escapingRealpath).toHaveBeenCalled();
  });

  it('propagates a realpath failure (missing file → 404 upstream)', async () => {
    const url = buildPluginModuleUrl(`${ROOT}/p/dist/missing.js`, 1);
    const missingRealpath = vi.fn().mockRejectedValue(new Error('ENOENT'));
    await expect(resolvePluginModulePath(url, ROOT, missingRealpath)).rejects.toThrow(/ENOENT/);
  });
});
