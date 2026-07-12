import { describe, it, expect } from 'vitest';
import {
  PLUGIN_PROTOCOL_SCHEME,
  PLUGIN_PROTOCOL_HOST,
  buildPluginModuleUrl,
  parsePluginModuleUrl,
} from './plugin-protocol-url';

describe('plugin-protocol-url', () => {
  describe('buildPluginModuleUrl', () => {
    it('builds a clubhouse-plugin:// URL with the version in the path', () => {
      const url = buildPluginModuleUrl('/Users/me/.clubhouse/plugins/automations/dist/main.js', 1780813375562);
      expect(url).toBe(
        'clubhouse-plugin://plugin/v1780813375562/Users/me/.clubhouse/plugins/automations/dist/main.js',
      );
    });

    it('round-trips through parse', () => {
      const abs = '/Users/me/.clubhouse/plugins/automations/dist/main.js';
      const parsed = parsePluginModuleUrl(buildPluginModuleUrl(abs, 42));
      expect(parsed).toEqual({ version: '42', filePath: abs });
    });

    it('percent-encodes path segments with spaces, and parse decodes them', () => {
      const abs = '/Users/me/my plugins/cool plugin/dist/main.js';
      const url = buildPluginModuleUrl(abs, 1);
      expect(url).toContain('my%20plugins');
      expect(parsePluginModuleUrl(url)).toEqual({ version: '1', filePath: abs });
    });

    it('normalizes Windows backslashes and round-trips the drive-letter path', () => {
      const url = buildPluginModuleUrl('C:\\Users\\me\\.clubhouse\\plugins\\p\\dist\\main.js', 7);
      expect(url).toBe('clubhouse-plugin://plugin/v7/C:/Users/me/.clubhouse/plugins/p/dist/main.js');
      expect(parsePluginModuleUrl(url)).toEqual({
        version: '7',
        filePath: 'C:/Users/me/.clubhouse/plugins/p/dist/main.js',
      });
    });
  });

  describe('relative-import resolution (the whole point)', () => {
    it('resolves a sibling import to the same version prefix', () => {
      const entry = buildPluginModuleUrl('/p/dist/main.js', 99);
      // What Chromium's standard-scheme URL resolver produces for `import './util.js'`:
      const sibling = new URL('./util.js', entry).href;
      expect(sibling).toBe('clubhouse-plugin://plugin/v99/p/dist/util.js');
      // And it parses back to the real sibling path with the SAME version → cache-bust propagates.
      expect(parsePluginModuleUrl(sibling)).toEqual({ version: '99', filePath: '/p/dist/util.js' });
    });

    it('resolves a nested sibling (../lib/x.js) within the version prefix', () => {
      const entry = buildPluginModuleUrl('/p/dist/main.js', 5);
      const nested = new URL('../lib/x.js', entry).href;
      expect(parsePluginModuleUrl(nested)).toEqual({ version: '5', filePath: '/p/lib/x.js' });
    });
  });

  describe('parsePluginModuleUrl — rejects malformed input', () => {
    it('returns null for a different scheme', () => {
      expect(parsePluginModuleUrl('file:///p/dist/main.js')).toBeNull();
      expect(parsePluginModuleUrl('clubhouse://open-file?path=/x')).toBeNull();
    });

    it('returns null for the wrong host', () => {
      expect(parsePluginModuleUrl('clubhouse-plugin://evil/v1/p/main.js')).toBeNull();
    });

    it('returns null when the version prefix is missing', () => {
      expect(parsePluginModuleUrl('clubhouse-plugin://plugin/p/dist/main.js')).toBeNull();
    });

    it('returns null for a non-URL string', () => {
      expect(parsePluginModuleUrl('not a url')).toBeNull();
    });

    it('exposes stable scheme/host constants', () => {
      expect(PLUGIN_PROTOCOL_SCHEME).toBe('clubhouse-plugin');
      expect(PLUGIN_PROTOCOL_HOST).toBe('plugin');
    });
  });
});
