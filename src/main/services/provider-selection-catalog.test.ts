import { describe, expect, it } from 'vitest';
import type { ModelList } from '../orchestrators/types';
import { MODEL_LIST_TTL_MS } from '../orchestrators/base-provider';
import { resolveProviderSelectionCatalog } from './provider-selection-catalog';

const now = 1_000_000;
const catalog = (extra: Partial<ModelList> = {}): ModelList => ({ source: 'live', via: 'handshake', fetchedAt: now,
  models: [{ id: 'fixture', resolvedId: 'fixture-resolved', label: 'Fixture', isDefault: true, efforts: ['low', 'high'] }, { id: 'no-effort', label: 'No effort', efforts: [] }], ...extra });
describe('current per-agent catalog contract', () => {
  it('checks selected ids, provider-reported aliases, default effort and no-effort models', () => {
    expect(resolveProviderSelectionCatalog(catalog(), 'fixture-resolved', 'high', true, now).blocked).toBeNull();
    expect(resolveProviderSelectionCatalog(catalog(), undefined, 'high', false, now).blocked).toBeNull();
    expect(resolveProviderSelectionCatalog(catalog(), 'unknown', null, true, now).blocked).toBe('model_not_offered');
    expect(resolveProviderSelectionCatalog(catalog(), 'no-effort', 'high', true, now).blocked).toBe('effort_not_offered');
    expect(resolveProviderSelectionCatalog(catalog(), 'fixture', 'arbitrary', true, now).blocked).toBe('effort_not_offered');
  });
  it('normalizes a stored default alias without admitting an explicit model or unsupported new effort', () => {
    expect(resolveProviderSelectionCatalog(catalog(), 'default', 'high', false, now).blocked).toBeNull();
    expect(resolveProviderSelectionCatalog(catalog(), 'default', null, true, now).blocked).toBe('model_not_offered');
    expect(resolveProviderSelectionCatalog(catalog(), 'default', 'unsupported', false, now).blocked).toBe('effort_not_offered');
    expect(resolveProviderSelectionCatalog(catalog({ source: 'fallback' }), 'default', 'high', false, now).blocked).toBe('model_catalog_fallback');
  });
  it('refuses stale, future, fallback and missing evidence for concrete selections', () => {
    for (const list of [catalog({ fetchedAt: now - MODEL_LIST_TTL_MS - 1 }), catalog({ fetchedAt: now + 1 }), catalog({ fetchedAt: NaN })]) {
      expect(resolveProviderSelectionCatalog(list, 'fixture', null, true, now).blocked).toBe('model_catalog_stale');
    }
    expect(resolveProviderSelectionCatalog(catalog({ source: 'fallback' }), 'fixture', null, true, now).blocked).toBe('model_catalog_fallback');
    expect(resolveProviderSelectionCatalog(catalog({ liveError: 'not available' }), 'fixture', null, true, now).blocked).toBe('model_catalog_fallback');
    expect(resolveProviderSelectionCatalog(null, 'fixture', null, true, now).blocked).toBe('model_catalog_unavailable');
    // Clearing a setting is explicit intent, and does not invent a concrete default.
    expect(resolveProviderSelectionCatalog(null, undefined, null, false, now).blocked).toBeNull();
  });
  it('binds semantic catalog changes without making every cache refresh stale', () => {
    const a = resolveProviderSelectionCatalog(catalog(), 'fixture', 'high', true, now);
    expect(resolveProviderSelectionCatalog(catalog({ fetchedAt: now - 1 }), 'fixture', 'high', true, now).fingerprint).toBe(a.fingerprint);
    const next = catalog(); next.models[0].efforts = ['low'];
    expect(resolveProviderSelectionCatalog(next, 'fixture', 'high', true, now).fingerprint).not.toBe(a.fingerprint);
  });
});
