import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/test-clubhouse-discovery' } }));
vi.mock('fs/promises', () => ({ lstat: vi.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }) }));
vi.mock('./plugin-storage', () => ({ getGlobalPluginDataDir: () => '/tmp/data' }));
vi.mock('./agent-settings-service', () => ({}));
vi.mock('./plugin-manifest-registry', () => ({ registerTrustedManifest: vi.fn() }));
vi.mock('./fs-utils', () => ({ pathExists: vi.fn(async () => false) }));

const flows = vi.hoisted(() => [] as Array<{ name: string; attrs: Record<string, unknown> }>);
vi.mock('../telemetry/facade', () => ({
  tel: {
    flow: (name: string, opts: { attrs?: Array<{ key: string; value: unknown }> }, fn: () => unknown) => {
      flows.push({ name, attrs: Object.fromEntries((opts.attrs ?? []).map((a) => [a.key, a.value])) });
      return fn();
    },
  },
}));

import { uninstallPlugin } from './plugin-discovery';

describe('plugin uninstall telemetry', () => {
  it('records clubhouse.plugin.uninstall with a hashed id', async () => {
    await uninstallPlugin('acme-plugin');
    expect(flows).toEqual([{
      name: 'clubhouse.plugin.uninstall',
      attrs: { 'clubhouse.plugin.ref': 'other', 'clubhouse.plugin.id_hash': 'acme-plugin' },
    }]);
  });
});
