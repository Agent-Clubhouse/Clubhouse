/* eslint-disable no-restricted-syntax -- TODO(TC-CRIT-03): structural readFileSync tests pending behavioral conversion */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

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
});
