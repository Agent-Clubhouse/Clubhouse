import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerManifest,
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

  it('registers and retrieves a manifest', () => {
    const manifest = makeManifest({ allowedCommands: ['git', 'node'] });
    registerManifest('test-plugin', manifest);
    expect(getManifest('test-plugin')).toBe(manifest);
  });

  it('returns allowedCommands from registered manifest', () => {
    registerManifest('test-plugin', makeManifest({ allowedCommands: ['git', 'node'] }));
    expect(getAllowedCommands('test-plugin')).toEqual(['git', 'node']);
  });

  it('returns empty array when manifest has no allowedCommands', () => {
    registerManifest('test-plugin', makeManifest());
    expect(getAllowedCommands('test-plugin')).toEqual([]);
  });

  it('overwrites manifest on re-registration', () => {
    registerManifest('test-plugin', makeManifest({ allowedCommands: ['git'] }));
    registerManifest('test-plugin', makeManifest({ allowedCommands: ['node'] }));
    expect(getAllowedCommands('test-plugin')).toEqual(['node']);
  });

  it('unregisters a manifest', () => {
    registerManifest('test-plugin', makeManifest());
    expect(unregisterManifest('test-plugin')).toBe(true);
    expect(getManifest('test-plugin')).toBeUndefined();
  });

  it('unregisterManifest returns false for unknown plugin', () => {
    expect(unregisterManifest('unknown')).toBe(false);
  });

  it('clear removes all manifests', () => {
    registerManifest('a', makeManifest({ id: 'a' }));
    registerManifest('b', makeManifest({ id: 'b' }));
    clear();
    expect(getManifest('a')).toBeUndefined();
    expect(getManifest('b')).toBeUndefined();
  });
});
