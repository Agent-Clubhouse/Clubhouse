import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./plugin-store', () => ({
  usePluginStore: {
    getState: vi.fn(() => ({
      plugins: { 'test-plugin': { manifest: { name: 'Test Plugin' } } },
      recordPermissionViolation: vi.fn(),
      disableApp: vi.fn(),
      setPluginStatus: vi.fn(),
      appEnabled: {},
    })),
  },
}));

vi.mock('./renderer-logger', () => ({
  rendererLog: vi.fn(),
}));

import {
  hasPermission,
  permissionDeniedProxy,
  handlePermissionViolation,
  gated,
  _resetEnforcedViolations,
} from './plugin-api-shared';
import { usePluginStore } from './plugin-store';
import type { PluginManifest } from '../../shared/plugin-types';

beforeEach(() => {
  vi.clearAllMocks();
  _resetEnforcedViolations();
  (window as any).clubhouse = {
    plugin: { storageWrite: vi.fn() },
  };
});

describe('hasPermission', () => {
  it('returns true when manifest includes the permission', () => {
    const manifest = { permissions: ['files', 'storage'] } as unknown as PluginManifest;
    expect(hasPermission(manifest, 'files')).toBe(true);
  });

  it('returns false when manifest does not include the permission', () => {
    const manifest = { permissions: ['storage'] } as unknown as PluginManifest;
    expect(hasPermission(manifest, 'files')).toBe(false);
  });

  it('returns false when manifest is undefined', () => {
    expect(hasPermission(undefined, 'files')).toBe(false);
  });

  it('returns false when permissions array is missing', () => {
    const manifest = {} as unknown as PluginManifest;
    expect(hasPermission(manifest, 'files')).toBe(false);
  });
});

describe('permissionDeniedProxy', () => {
  it('returns a proxy that throws on method invocation', () => {
    const proxy = permissionDeniedProxy<{ doSomething: () => void }>('bad-plugin', 'files', 'project');
    expect(() => proxy.doSomething()).toThrow("requires 'files' permission");
  });

  it('throws with plugin id in error message', () => {
    const proxy = permissionDeniedProxy<{ run: () => void }>('evil-plugin', 'process', 'process');
    expect(() => proxy.run()).toThrow('evil-plugin');
  });

  it('does not throw on symbol property access (React dev-mode safety)', () => {
    const proxy = permissionDeniedProxy<Record<string | symbol, unknown>>('p', 'files', 'project');
    expect(proxy[Symbol.toPrimitive]).toBeUndefined();
  });
});

describe('handlePermissionViolation', () => {
  it('records violation in plugin store', () => {
    const mockRecord = vi.fn();
    vi.mocked(usePluginStore.getState).mockReturnValue({
      plugins: { 'test-plugin': { manifest: { name: 'Test Plugin' } } },
      recordPermissionViolation: mockRecord,
      disableApp: vi.fn(),
      setPluginStatus: vi.fn(),
      appEnabled: {},
    } as any);

    handlePermissionViolation('test-plugin', 'files', 'project.readFile');

    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'test-plugin',
        pluginName: 'Test Plugin',
        permission: 'files',
        apiName: 'project.readFile',
      }),
    );
  });

  it('only fires once per pluginId:permission pair', () => {
    const mockRecord = vi.fn();
    vi.mocked(usePluginStore.getState).mockReturnValue({
      plugins: { 'test-plugin': { manifest: { name: 'Test Plugin' } } },
      recordPermissionViolation: mockRecord,
      disableApp: vi.fn(),
      setPluginStatus: vi.fn(),
      appEnabled: {},
    } as any);

    handlePermissionViolation('test-plugin', 'files', 'project.readFile');
    handlePermissionViolation('test-plugin', 'files', 'project.writeFile');

    // Second call with same pluginId:permission should be skipped
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it('fires for different permissions on same plugin', () => {
    const mockRecord = vi.fn();
    vi.mocked(usePluginStore.getState).mockReturnValue({
      plugins: { 'test-plugin': { manifest: { name: 'Test Plugin' } } },
      recordPermissionViolation: mockRecord,
      disableApp: vi.fn(),
      setPluginStatus: vi.fn(),
      appEnabled: {},
    } as any);

    handlePermissionViolation('test-plugin', 'files', 'project');
    handlePermissionViolation('test-plugin', 'process', 'process');

    expect(mockRecord).toHaveBeenCalledTimes(2);
  });
});

describe('gated', () => {
  const manifest = { permissions: ['files'] } as unknown as PluginManifest;
  const noPermManifest = { permissions: [] } as unknown as PluginManifest;

  it('returns constructed API when scope available and permission granted', () => {
    const api = gated(true, 'project', 'project', 'files', 'p', manifest, () => ({ read: () => 'data' }));
    expect(api.read()).toBe('data');
  });

  it('returns permission denied proxy when permission missing', () => {
    const api = gated<{ read: () => string }>(true, 'project', 'project', 'files', 'p', noPermManifest, () => ({ read: () => 'data' }));
    expect(() => api.read()).toThrow("requires 'files' permission");
  });

  it('returns unavailable proxy when scope not available', () => {
    const api = gated<{ read: () => string }>(false, 'project', 'project', 'files', 'p', manifest, () => ({ read: () => 'data' }));
    expect(() => api.read()).toThrow();
  });
});
