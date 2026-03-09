import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerManifest,
  registerTrustedManifest,
  getManifest,
  getAllowedCommands,
  unregisterManifest,
  clear,
} from './plugin-manifest-registry';
import type { PluginManifest } from '../../shared/plugin-types';

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    engine: { api: 0.5 },
    scope: 'project',
    ...overrides,
  };
}

describe('plugin-manifest-registry', () => {
  beforeEach(() => {
    clear();
  });

  it('returns undefined for unregistered plugin', () => {
    expect(getManifest('unknown')).toBeUndefined();
  });

  it('returns empty array for allowedCommands of unregistered plugin', () => {
    expect(getAllowedCommands('unknown')).toEqual([]);
  });

  // ── Trusted registration (main-process disk reads) ────────────────

  describe('registerTrustedManifest', () => {
    it('registers and retrieves a manifest', () => {
      const manifest = makeManifest({ allowedCommands: ['git', 'node'] });
      registerTrustedManifest('test-plugin', manifest);
      expect(getManifest('test-plugin')).toBe(manifest);
    });

    it('returns allowedCommands from trusted manifest', () => {
      registerTrustedManifest('test-plugin', makeManifest({ allowedCommands: ['git', 'node'] }));
      expect(getAllowedCommands('test-plugin')).toEqual(['git', 'node']);
    });

    it('returns empty array when trusted manifest has no allowedCommands', () => {
      registerTrustedManifest('test-plugin', makeManifest());
      expect(getAllowedCommands('test-plugin')).toEqual([]);
    });

    it('overwrites trusted manifest on re-registration', () => {
      registerTrustedManifest('test-plugin', makeManifest({ allowedCommands: ['git'] }));
      registerTrustedManifest('test-plugin', makeManifest({ allowedCommands: ['node'] }));
      expect(getAllowedCommands('test-plugin')).toEqual(['node']);
    });
  });

  // ── Untrusted registration (renderer IPC) ──────────────────────────

  describe('registerManifest (untrusted/IPC)', () => {
    it('strips allowedCommands from renderer-sourced manifest', () => {
      registerManifest('test-plugin', makeManifest({ allowedCommands: ['sh', 'bash', 'curl'] }));
      expect(getAllowedCommands('test-plugin')).toEqual([]);
    });

    it('preserves non-sensitive fields', () => {
      registerManifest('test-plugin', makeManifest({
        name: 'Malicious Plugin',
        version: '2.0.0',
        allowedCommands: ['sh'],
      }));
      const manifest = getManifest('test-plugin');
      expect(manifest?.name).toBe('Malicious Plugin');
      expect(manifest?.version).toBe('2.0.0');
      expect(manifest?.allowedCommands).toBeUndefined();
    });

    it('cannot overwrite trusted allowedCommands via untrusted re-registration', () => {
      // Trusted manifest registered during discovery
      registerTrustedManifest('test-plugin', makeManifest({ allowedCommands: ['git'] }));
      // Malicious IPC call tries to add 'sh' to allowedCommands
      registerManifest('test-plugin', makeManifest({ allowedCommands: ['sh', 'bash', 'rm'] }));
      // getAllowedCommands should still return trusted values only
      expect(getAllowedCommands('test-plugin')).toEqual(['git']);
    });

    it('cannot register a fake plugin to gain allowedCommands', () => {
      // Attacker registers a new plugin with allowedCommands via IPC
      registerManifest('evil-plugin', makeManifest({
        id: 'evil-plugin',
        allowedCommands: ['sh', 'bash'],
      }));
      // No trusted manifest exists, so no commands allowed
      expect(getAllowedCommands('evil-plugin')).toEqual([]);
    });
  });

  // ── Self-escalation attack scenarios ─────────────────────────────────

  describe('self-escalation prevention', () => {
    it('blocks self-escalation: register new manifest then exec', () => {
      // Scenario: plugin calls registerManifest to create allowedCommands
      registerManifest('malicious', makeManifest({
        id: 'malicious',
        permissions: ['process'],
        allowedCommands: ['sh', 'bash', 'curl', 'rm'],
      }));
      // process.exec would check getAllowedCommands — should be empty
      expect(getAllowedCommands('malicious')).toEqual([]);
    });

    it('blocks self-escalation: overwrite existing manifest', () => {
      // Plugin was legitimately discovered with only 'git' allowed
      registerTrustedManifest('my-plugin', makeManifest({
        id: 'my-plugin',
        allowedCommands: ['git'],
      }));
      // Plugin's own code tries to escalate via IPC
      registerManifest('my-plugin', makeManifest({
        id: 'my-plugin',
        allowedCommands: ['git', 'sh', 'bash', 'rm'],
      }));
      // Should still only have 'git' from the trusted registration
      expect(getAllowedCommands('my-plugin')).toEqual(['git']);
    });
  });

  // ── Utility functions ──────────────────────────────────────────────

  describe('unregisterManifest', () => {
    it('removes both trusted and untrusted manifests', () => {
      registerTrustedManifest('test-plugin', makeManifest());
      registerManifest('test-plugin', makeManifest());
      expect(unregisterManifest('test-plugin')).toBe(true);
      expect(getManifest('test-plugin')).toBeUndefined();
    });

    it('returns false for unknown plugin', () => {
      expect(unregisterManifest('unknown')).toBe(false);
    });
  });

  describe('clear', () => {
    it('removes all manifests', () => {
      registerTrustedManifest('a', makeManifest({ id: 'a' }));
      registerManifest('b', makeManifest({ id: 'b' }));
      clear();
      expect(getManifest('a')).toBeUndefined();
      expect(getManifest('b')).toBeUndefined();
    });
  });

  describe('getManifest preference', () => {
    it('prefers trusted manifest over untrusted', () => {
      registerTrustedManifest('test-plugin', makeManifest({ name: 'Trusted' }));
      registerManifest('test-plugin', makeManifest({ name: 'Untrusted' }));
      expect(getManifest('test-plugin')?.name).toBe('Trusted');
    });

    it('falls back to untrusted manifest if no trusted exists', () => {
      registerManifest('test-plugin', makeManifest({ name: 'Untrusted' }));
      expect(getManifest('test-plugin')?.name).toBe('Untrusted');
    });
  });
});
