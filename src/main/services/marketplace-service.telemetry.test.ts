import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rec = vi.hoisted(() => ({
  flows: [] as Array<{ name: string; attrs: Record<string, unknown>; classification?: unknown }>,
}));

vi.mock('../telemetry/facade', () => ({
  tel: {
    flow: async (name: string, opts: { attrs?: Array<{ key: string; value: unknown }> }, fn: (s: { set: (...a: Array<{ key: string; value: unknown }>) => void }) => unknown, extras?: { classify?: (r: unknown) => unknown }) => {
      const f = { name, attrs: Object.fromEntries((opts.attrs ?? []).map((a) => [a.key, a.value])) as Record<string, unknown>, classification: undefined as unknown };
      rec.flows.push(f);
      try {
        const r = await fn({ set: (...a) => a.forEach((x) => { f.attrs[x.key] = x.value; }) });
        f.classification = extras?.classify ? extras.classify(r) : 'ok';
        return r;
      } catch (err) {
        f.classification = 'threw';
        throw err;
      }
    },
  },
}));

import { _resetCache, fetchRegistry, installPlugin } from './marketplace-service';

const fetchMock = vi.fn();

beforeEach(() => {
  rec.flows = [];
  _resetCache();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

const response = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: 'x',
  json: async () => body,
  arrayBuffer: async () => new ArrayBuffer(2048),
});

describe('marketplace telemetry', () => {
  it('records the registry fetch with status and cache hit, then a cache hit', async () => {
    fetchMock.mockResolvedValue(response(200, { version: 1, updated: '', plugins: [] }));
    await fetchRegistry();
    await fetchRegistry();
    expect(rec.flows.map((f) => f.attrs)).toEqual([
      { 'clubhouse.registry.kind': 'official', 'clubhouse.cache.hit': false, 'http.response.status_code': 200 },
      { 'clubhouse.registry.kind': 'official', 'clubhouse.cache.hit': true },
    ]);
  });

  it('classifies an HTTP failure from the registry', async () => {
    fetchMock.mockResolvedValue(response(503));
    await expect(fetchRegistry()).rejects.toThrow('503');
    expect(rec.flows[0].attrs['http.response.status_code']).toBe(503);
  });

  it('records the install failure stage and hashes the plugin id', async () => {
    fetchMock.mockResolvedValueOnce(response(404));
    await installPlugin({ pluginId: 'acme-secret-plugin', version: '1.0.0', assetUrl: 'https://acme.example/p.zip', sha256: 'x' });
    fetchMock.mockResolvedValueOnce(response(200));
    await installPlugin({ pluginId: 'acme-secret-plugin', version: '1.0.0', assetUrl: 'https://acme.example/p.zip', sha256: 'bad' });
    await installPlugin({ pluginId: '../escape', version: '1.0.0', assetUrl: 'https://acme.example/p.zip', sha256: 'x' });
    expect(rec.flows.map((f) => [f.attrs['clubhouse.install.failure_stage'], f.classification])).toEqual([
      ['download_http', { error: 'install_failed' }],
      ['integrity', { error: 'install_failed' }],
      ['invalid_id', { error: 'install_failed' }],
    ]);
    expect(rec.flows[1].attrs['clubhouse.size_bucket']).toBe('<100KB');
    expect(rec.flows[0].attrs['clubhouse.plugin.ref']).toBe('other');
    expect(rec.flows[0].attrs['clubhouse.plugin.id_hash']).toBe('acme-secret-plugin');
    expect(JSON.stringify(rec.flows)).not.toContain('acme.example');
  });
});
