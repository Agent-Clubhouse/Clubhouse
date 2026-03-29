import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
  };
});

vi.mock('./plugin-discovery', () => ({
  discoverCommunityPlugins: vi.fn(async () => []),
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
      registerTrustedManifest('test-plugin', makeManifest({ allowedCommands: undefined }));
      expect(getAllowedCommands('test-plugin')).toEqual([]);
    });

    it('overwrites trusted manifest on re-registration', () => {
      registerTrustedManifest('test-plugin', makeManifest({ allowedCommands: ['git'] }));
      registerTrustedManifest('test-plugin', makeManifest({ allowedCommands: ['node'] }));
      expect(getAllowedCommands('test-plugin')).toEqual(['node']);
    });
  });

  // ── No untrusted registration path ─────────────────────────────────

  describe('getManifest returns only trusted manifests', () => {
    it('returns undefined when no trusted manifest exists', () => {
      expect(getManifest('unknown-plugin')).toBeUndefined();
    });

    it('returns the trusted manifest', () => {
      registerTrustedManifest('test-plugin', makeManifest({ name: 'Trusted' }));
      expect(getManifest('test-plugin')?.name).toBe('Trusted');
    });
  });

  // ── Security: no renderer path to inject policy ─────────────────────

  describe('security invariants', () => {
    it('getAllowedCommands returns empty for unregistered plugins (deny by default)', () => {
      expect(getAllowedCommands('malicious')).toEqual([]);
    });

    it('only trusted manifests can set allowedCommands', () => {
      registerTrustedManifest('my-plugin', makeManifest({
        id: 'my-plugin',
        allowedCommands: ['git'],
      }));
      expect(getAllowedCommands('my-plugin')).toEqual(['git']);
    });
  });

  // ── Utility functions ──────────────────────────────────────────────

  describe('unregisterManifest', () => {
    it('removes trusted manifest', () => {
      registerTrustedManifest('test-plugin', makeManifest());
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
      registerTrustedManifest('b', makeManifest({ id: 'b' }));
      clear();
      expect(getManifest('a')).toBeUndefined();
      expect(getManifest('b')).toBeUndefined();
    });
  });

  it('loads trusted builtin manifests at initialization', async () => {
    await initializeTrustedManifests();

    expect(getManifest('hub')).toBeDefined();
    expect(getManifest('terminal')).toBeDefined();
    expect(getManifest('files')).toBeDefined();
    expect(getManifest('browser')).toBeDefined();
    expect(getManifest('git')).toBeDefined();
    expect(getManifest('canvas')).toBeDefined();
    expect(getManifest('sessions')).toBeDefined();
    expect(getManifest('group-project')).toBeDefined();
  });

  it('group-project manifest declares annex permission for canvas-over-annex support', async () => {
    await initializeTrustedManifests();

    const manifest = getManifest('group-project');
    expect(manifest).toBeDefined();
    expect(manifest!.permissions).toContain('annex');
  });

  it('loads validated community manifests from disk when external plugins are enabled', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue('true');
    vi.mocked(pluginDiscovery.discoverCommunityPlugins).mockResolvedValue([
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

    await initializeTrustedManifests();

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

  it('does not load any manifests in safe mode', async () => {
    process.env.CLUBHOUSE_SAFE_MODE = '1';
    vi.mocked(fs.readFileSync).mockReturnValue('true');
    vi.mocked(pluginDiscovery.discoverCommunityPlugins).mockResolvedValue([
      {
        manifest: makeManifest({ id: 'community-plugin' }),
        pluginPath: '/plugins/community-plugin',
        fromMarketplace: false,
      },
    ]);

    await initializeTrustedManifests();

    expect(getManifest('hub')).toBeUndefined();
    expect(getManifest('community-plugin')).toBeUndefined();
  });

  it('refreshes a community manifest from disk instead of keeping stale state', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue('true');
    vi.mocked(pluginDiscovery.discoverCommunityPlugins).mockResolvedValue([
      {
        manifest: makeManifest({ id: 'community-plugin', allowedCommands: ['git'] }),
        pluginPath: '/plugins/community-plugin',
        fromMarketplace: false,
      },
    ]);
    await initializeTrustedManifests();

    registerTrustedManifest('community-plugin', makeManifest({ id: 'community-plugin', allowedCommands: ['rm', 'bash'] }));
    await refreshManifest('community-plugin');

    expect(getAllowedCommands('community-plugin')).toEqual(['git']);
  });

  it('removes a community manifest when refresh cannot find a trusted source', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue('true');
    vi.mocked(pluginDiscovery.discoverCommunityPlugins).mockResolvedValue([
      {
        manifest: makeManifest({ id: 'community-plugin', allowedCommands: ['git'] }),
        pluginPath: '/plugins/community-plugin',
        fromMarketplace: false,
      },
    ]);
    await initializeTrustedManifests();

    vi.mocked(pluginDiscovery.discoverCommunityPlugins).mockResolvedValue([]);
    await refreshManifest('community-plugin');

    expect(getManifest('community-plugin')).toBeUndefined();
  });
});
