/* eslint-disable no-restricted-syntax -- TODO(TC-CRIT-03): structural readFileSync tests pending behavioral conversion */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { assertHardenedFuseWire } from '../../forge.config';

/**
 * Validates that forge.config.ts includes the required macOS Info.plist
 * entries so the packaged app shows "Clubhouse" (not "Electron") in
 * system permission dialogs — particularly the local-network prompt
 * triggered by Bonjour/Annex pairing.
 */
describe('forge.config.ts macOS plist entries', () => {
  const configPath = path.resolve(__dirname, '../../forge.config.ts');
  const configSource = fs.readFileSync(configPath, 'utf-8');

  it('sets CFBundleDisplayName to Clubhouse', () => {
    expect(configSource).toContain("CFBundleDisplayName: 'Clubhouse'");
  });

  it('includes NSLocalNetworkUsageDescription', () => {
    expect(configSource).toContain('NSLocalNetworkUsageDescription');
  });

  it('declares _clubhouse-annex._tcp. in NSBonjourServices', () => {
    expect(configSource).toContain('NSBonjourServices');
    expect(configSource).toContain('_clubhouse-annex._tcp.');
  });

  it('sets packagerConfig name to Clubhouse', () => {
    expect(configSource).toMatch(/name:\s*'Clubhouse'/);
  });

  it('registers the clubhouse:// custom URL scheme via CFBundleURLTypes', () => {
    expect(configSource).toContain('CFBundleURLTypes');
    expect(configSource).toContain('CFBundleURLSchemes');
    expect(configSource).toContain("'clubhouse'");
  });

  it('restores the hardened Electron fuse settings and post-package assertion', () => {
    expect(configSource).toContain('new FusesPlugin');
    expect(configSource).toContain('RunAsNode');
    expect(configSource).toContain('EnableCookieEncryption');
    expect(configSource).toContain('EnableNodeOptionsEnvironmentVariable');
    expect(configSource).toContain('EnableNodeCliInspectArguments');
    expect(configSource).toContain('EnableEmbeddedAsarIntegrityValidation');
    expect(configSource).toContain('OnlyLoadAppFromAsar');
    expect(configSource).toContain('postPackage');
    expect(configSource).toContain('assertHardenedFuseWire');
  });

  it('accepts the hardened fuse wire and rejects any drift', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-fuses-'));
    const packagedBinary = path.join(tempDir, 'Clubhouse');
    const sentinel = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
    const fuseWire = Buffer.from([
      1,
      6,
      48,
      49,
      48,
      48,
      49,
      49,
    ]);

    fs.writeFileSync(packagedBinary, Buffer.concat([Buffer.from(sentinel), fuseWire]));
    await expect(assertHardenedFuseWire(packagedBinary)).resolves.toBeUndefined();

    const invalidBinary = Buffer.from(fs.readFileSync(packagedBinary));
    invalidBinary[sentinel.length + 2] = 49;
    fs.writeFileSync(packagedBinary, invalidBinary);

    await expect(assertHardenedFuseWire(packagedBinary)).rejects.toThrow('RunAsNode');
  });
});
