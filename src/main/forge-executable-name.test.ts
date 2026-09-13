import { describe, it, expect } from 'vitest';

import forgeConfig, { packagerExecutableName } from '../../forge.config';

/**
 * Regression coverage for #1833: `executableName` doubles as
 * `CFBundleDisplayName` on macOS and overrode the explicit "Clubhouse" display
 * name, leaving Finder showing a lowercase "clubhouse" while the menu bar
 * (driven by `CFBundleName`) showed "Clubhouse". The lowercase binary name is
 * only required by Linux `.deb`/`.rpm` packaging.
 */
describe('packagerExecutableName', () => {
  it('emits the lowercase binary name on Linux, where .deb/.rpm require it', () => {
    expect(packagerExecutableName('linux')).toEqual({ executableName: 'clubhouse' });
  });

  it('leaves executableName unset on macOS so CFBundleDisplayName stays "Clubhouse"', () => {
    expect(packagerExecutableName('darwin')).toEqual({});
    expect(packagerExecutableName('darwin')).not.toHaveProperty('executableName');
  });

  it('leaves executableName unset on Windows', () => {
    expect(packagerExecutableName('win32')).toEqual({});
    expect(packagerExecutableName('win32')).not.toHaveProperty('executableName');
  });
});

describe('forge packagerConfig branding', () => {
  const packagerConfig = forgeConfig.packagerConfig;

  it('brands the bundle "Clubhouse" via both CFBundleName and CFBundleDisplayName', () => {
    // packagerConfig.name becomes CFBundleName (the menu bar); extendInfo
    // supplies CFBundleDisplayName (Finder, Get Info, the Dock).
    expect(packagerConfig.name).toBe('Clubhouse');
    expect(packagerConfig.extendInfo).toMatchObject({ CFBundleDisplayName: 'Clubhouse' });
  });

  it('derives executableName from the build platform', () => {
    expect(packagerConfig.executableName).toBe(
      packagerExecutableName(process.platform).executableName,
    );
  });
});
