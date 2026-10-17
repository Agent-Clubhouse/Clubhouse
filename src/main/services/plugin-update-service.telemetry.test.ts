import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock-home') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('fs/promises', () => ({ readFile: vi.fn(), readdir: vi.fn() }));
vi.mock('./fs-utils', () => ({ pathExists: vi.fn() }));
vi.mock('./marketplace-service', () => ({ fetchAllRegistries: vi.fn(), installPlugin: vi.fn() }));
vi.mock('./custom-marketplace-service', () => ({ listCustomMarketplaces: vi.fn(() => []) }));
vi.mock('./auto-update-service', () => ({
  isNewerVersion: (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) > 0,
}));
vi.mock('./log-service', () => ({ appLog: vi.fn() }));

type Flow = { name: string; attrs: Record<string, unknown>; classification?: unknown };
const rec = vi.hoisted(() => ({ flows: [] as Flow[] }));
vi.mock('../telemetry/facade', () => ({
  tel: {
    flow: async (name: string, opts: { attrs?: Array<{ key: string; value: unknown }> }, fn: (s: { set: (...a: Array<{ key: string; value: unknown }>) => void }) => unknown, extras?: { classify?: (r: unknown) => unknown }) => {
      const f: Flow = { name, attrs: Object.fromEntries((opts.attrs ?? []).map((a) => [a.key, a.value])) };
      rec.flows.push(f);
      const r = await fn({ set: (...a) => a.forEach((x) => { f.attrs[x.key] = x.value; }) });
      f.classification = extras?.classify ? extras.classify(r) : 'ok';
      return r;
    },
  },
}));

import * as fsp from 'fs/promises';
import { pathExists } from './fs-utils';
import { fetchAllRegistries, installPlugin } from './marketplace-service';
import { checkForPluginUpdates, classifyUpdateCheckError, updatePlugin, _resetState } from './plugin-update-service';

const plugin = {
  id: 'my-plugin', name: 'My Plugin', description: '', author: '', official: false, repo: '', path: '', tags: [], latest: '2.0.0',
  releases: {
    '2.0.0': { api: 0.5, asset: 'https://example.com/p.zip', sha256: 'def', permissions: [], size: 2048 },
  },
};

function installed(version: string) {
  vi.mocked(pathExists).mockResolvedValue(true);
  vi.mocked(fsp.readdir).mockResolvedValue([{ name: 'my-plugin', isDirectory: () => true }] as never);
  vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ id: 'my-plugin', version }));
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetState();
  rec.flows = [];
});

describe('plugin update telemetry', () => {
  it('records the trigger and update counts', async () => {
    vi.mocked(fetchAllRegistries).mockResolvedValue({ allPlugins: [plugin] } as never);
    installed('1.0.0');
    await checkForPluginUpdates('periodic');
    expect(rec.flows[0]).toMatchObject({
      name: 'clubhouse.plugin.update_check',
      attrs: { 'clubhouse.update.trigger': 'periodic', 'clubhouse.updates.available.count': 1, 'clubhouse.updates.incompatible.count': 0 },
      classification: 'ok',
    });
  });

  it('classifies a failed check from the returned error, fetch vs anything else', async () => {
    vi.mocked(fetchAllRegistries).mockRejectedValueOnce(new TypeError('fetch failed'));
    await checkForPluginUpdates();
    vi.mocked(fetchAllRegistries).mockRejectedValueOnce(new Error('cannot read custom marketplaces'));
    await checkForPluginUpdates();
    expect(rec.flows.map((f) => f.classification)).toEqual([{ error: 'network' }, { error: 'unknown' }]);
    expect(rec.flows[0].attrs['clubhouse.update.trigger']).toBe('manual');
  });

  it('maps update failures to closed error types', async () => {
    await updatePlugin('../escape');
    await updatePlugin('my-plugin');
    vi.mocked(fetchAllRegistries).mockResolvedValue({ allPlugins: [plugin] } as never);
    installed('1.0.0');
    await checkForPluginUpdates();
    vi.mocked(installPlugin).mockResolvedValueOnce({ success: false, error: 'Integrity check failed' });
    await updatePlugin('my-plugin');
    vi.mocked(installPlugin).mockResolvedValueOnce({ success: true });
    await updatePlugin('my-plugin');
    const updates = rec.flows.filter((f) => f.name === 'clubhouse.plugin.update');
    expect(updates.map((f) => f.classification)).toEqual([
      { error: 'invalid_id' },
      { error: 'no_update_available' },
      { error: 'install_failed' },
      'ok',
    ]);
    expect(updates[0].attrs).toMatchObject({ 'clubhouse.plugin.ref': 'other', 'clubhouse.plugin.origin': 'marketplace' });
  });

  it('classifyUpdateCheckError keeps fetch classifications', () => {
    expect(classifyUpdateCheckError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(classifyUpdateCheckError(new Error('Failed to fetch registry: 502 Bad Gateway'))).toBe('http_5xx');
    expect(classifyUpdateCheckError(new RangeError('bad version'))).toBe('unknown');
  });
});
