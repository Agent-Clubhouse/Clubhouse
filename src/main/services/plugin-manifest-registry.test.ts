import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('./plugin-discovery', () => ({
  discoverCommunityPlugins: vi.fn(() => []),
}));

vi.mock('./plugin-storage', () => ({
  getGlobalPluginDataDir: vi.fn(() => '/plugin-data'),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import * as fs from 'fs';
import * as pluginDiscovery from './plugin-discovery';
import { appLog } from './log-service';
import {
  initializeTrustedManifests,
  refreshManifest,
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
    permissions: ['process'],
    allowedCommands: ['git'],
    contributes: { help: {} },
    ...overrides,
  };
}

describe('plugin-manifest-registry', () => {
  beforeEach(() => {
    delete process.env.CLUBHOUSE_SAFE_MODE;
    vi.clearAllMocks();
    clear();
  });

  it('returns undefined for unregistered plugin', () => {
    expect(getManifest('unknown')).toBeUndefined();
  });

  it('returns empty array for allowedCommands of unregistered plugin', () => {
    expect(getAllowedCommands('unknown')).toEqual([]);
  });

  it('registers and retrieves a trusted manifest', () => {
    const manifest = makeManifest({ allowedCommands: ['git', 'node'] });
    registerTrustedManifest('test-plugin', manifest);
    expect(getManifest('test-plugin')).toBe(manifest);
  });

  it('returns allowedCommands from trusted manifest', () => {
    registerTrustedManifest('test-plugin', makeManifest({ allowedCommands: ['git', 'node'] }));
    expect(getAllowedCommands('test-plugin')).toEqual(['git', 'node']);
  });

  it('returns empty array when manifest has no allowedCommands', () => {
    registerTrustedManifest('test-plugin', makeManifest({ permissions: [] as PluginManifest['permissions'], allowedCommands: undefined }));
    expect(getAllowedCommands('test-plugin')).toEqual([]);
  });

  it('overwrites manifest on trusted re-registration', () => {
    registerTrustedManifest('test-plugin', makeManifest({ allowedCommands: ['git'] }));
    registerTrustedManifest('test-plugin', makeManifest({ allowedCommands: ['node'] }));
    expect(getAllowedCommands('test-plugin')).toEqual(['node']);
  });

  it('unregisters a manifest', () => {
    registerTrustedManifest('test-plugin', makeManifest());
    expect(unregisterManifest('test-plugin')).toBe(true);
    expect(getManifest('test-plugin')).toBeUndefined();
  });

  it('unregisterManifest returns false for unknown plugin', () => {
    expect(unregisterManifest('unknown')).toBe(false);
  });

  it('clear removes all manifests', () => {
    registerTrustedManifest('a', makeManifest({ id: 'a' }));
    registerTrustedManifest('b', makeManifest({ id: 'b' }));
    clear();
    expect(getManifest('a')).toBeUndefined();
    expect(getManifest('b')).toBeUndefined();
  });

  it('loads trusted builtin manifests at initialization', () => {
    initializeTrustedManifests();

    expect(getManifest('hub')).toBeDefined();
    expect(getManifest('terminal')).toBeDefined();
    expect(getManifest('files')).toBeDefined();
  });

  it('loads validated community manifests from disk when external plugins are enabled', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('true');
    vi.mocked(pluginDiscovery.discoverCommunityPlugins).mockReturnValue([
      {
        manifest: makeManifest({ id: 'community-plugin', allowedCommands: ['git', 'node'] }),
        pluginPath: '/plugins/community-plugin',
        fromMarketplace: false,
      },
      {
        manifest: { id: 'broken-plugin' },
        pluginPath: '/plugins/broken-plugin',
        fromMarketplace: false,
      } as any,
    ]);

    initializeTrustedManifests();

    expect(getAllowedCommands('community-plugin')).toEqual(['git', 'node']);
    expect(getManifest('broken-plugin')).toBeUndefined();
    expect(appLog).toHaveBeenCalledWith(
      'core:plugins',
      'warn',
      'Skipping invalid community plugin manifest for security policy',
      expect.objectContaining({
        meta: expect.objectContaining({ pluginPath: '/plugins/broken-plugin' }),
      }),
    );
  });

  it('does not load any manifests in safe mode', () => {
    process.env.CLUBHOUSE_SAFE_MODE = '1';
    vi.mocked(fs.readFileSync).mockReturnValue('true');
    vi.mocked(pluginDiscovery.discoverCommunityPlugins).mockReturnValue([
      {
        manifest: makeManifest({ id: 'community-plugin' }),
        pluginPath: '/plugins/community-plugin',
        fromMarketplace: false,
      },
    ]);

    initializeTrustedManifests();

    expect(getManifest('hub')).toBeUndefined();
    expect(getManifest('community-plugin')).toBeUndefined();
  });

  it('refreshes a community manifest from disk instead of keeping stale renderer state', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('true');
    vi.mocked(pluginDiscovery.discoverCommunityPlugins).mockReturnValue([
      {
        manifest: makeManifest({ id: 'community-plugin', allowedCommands: ['git'] }),
        pluginPath: '/plugins/community-plugin',
        fromMarketplace: false,
      },
    ]);
    initializeTrustedManifests();

    registerTrustedManifest('community-plugin', makeManifest({ id: 'community-plugin', allowedCommands: ['rm', 'bash'] }));
    refreshManifest('community-plugin');

    expect(getAllowedCommands('community-plugin')).toEqual(['git']);
  });

  it('removes a community manifest when refresh cannot find a trusted source', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('true');
    vi.mocked(pluginDiscovery.discoverCommunityPlugins).mockReturnValue([
      {
        manifest: makeManifest({ id: 'community-plugin', allowedCommands: ['git'] }),
        pluginPath: '/plugins/community-plugin',
        fromMarketplace: false,
      },
    ]);
    initializeTrustedManifests();

    vi.mocked(pluginDiscovery.discoverCommunityPlugins).mockReturnValue([]);
    refreshManifest('community-plugin');

    expect(getManifest('community-plugin')).toBeUndefined();
  });
});
