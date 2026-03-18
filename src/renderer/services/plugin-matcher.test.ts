import { describe, it, expect } from 'vitest';
import { matchPlugins, type PluginInfo } from './plugin-matcher';

describe('matchPlugins', () => {
  it('should return matched for identical plugins', () => {
    const remote: PluginInfo[] = [{ id: 'foo', version: '1.0.0', name: 'Foo' }];
    const local: PluginInfo[] = [{ id: 'foo', version: '1.0.0', name: 'Foo' }];
    const results = matchPlugins(remote, local);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('matched');
    expect(results[0].localVersion).toBe('1.0.0');
    expect(results[0].remoteVersion).toBe('1.0.0');
  });

  it('should return missing for plugins not installed locally', () => {
    const remote: PluginInfo[] = [{ id: 'foo', version: '1.0.0' }];
    const local: PluginInfo[] = [];
    const results = matchPlugins(remote, local);
    expect(results[0].status).toBe('missing');
    expect(results[0].localVersion).toBeUndefined();
  });

  it('should return version_mismatch for different versions', () => {
    const remote: PluginInfo[] = [{ id: 'foo', version: '2.0.0' }];
    const local: PluginInfo[] = [{ id: 'foo', version: '1.0.0' }];
    const results = matchPlugins(remote, local);
    expect(results[0].status).toBe('version_mismatch');
    expect(results[0].localVersion).toBe('1.0.0');
    expect(results[0].remoteVersion).toBe('2.0.0');
  });

  it('should handle multiple plugins', () => {
    const remote: PluginInfo[] = [
      { id: 'a', version: '1.0.0', name: 'A' },
      { id: 'b', version: '2.0.0', name: 'B' },
      { id: 'c', version: '1.0.0', name: 'C' },
    ];
    const local: PluginInfo[] = [
      { id: 'a', version: '1.0.0', name: 'A' },
      { id: 'b', version: '1.0.0', name: 'B' },
    ];
    const results = matchPlugins(remote, local);
    expect(results.find((r) => r.id === 'a')?.status).toBe('matched');
    expect(results.find((r) => r.id === 'b')?.status).toBe('version_mismatch');
    expect(results.find((r) => r.id === 'c')?.status).toBe('missing');
  });

  it('should handle empty satellite plugins', () => {
    const results = matchPlugins([], [{ id: 'foo', version: '1.0.0' }]);
    expect(results).toHaveLength(0);
  });

  it('should use id as name fallback', () => {
    const results = matchPlugins([{ id: 'foo-bar', version: '1.0.0' }], []);
    expect(results[0].name).toBe('foo-bar');
  });
});
