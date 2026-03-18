import { describe, it, expect, beforeEach } from 'vitest';
import { createWindowAPI } from './plugin-api-window';
import { usePluginStore } from './plugin-store';
import { createMockContext } from './testing';
import type { PluginManifest } from '../../shared/plugin-types';

function resetStore() {
  usePluginStore.setState({ pluginTitles: {} });
}

describe('createWindowAPI', () => {
  beforeEach(resetStore);

  const manifest: PluginManifest = {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    engine: { api: 0.8 },
    scope: 'project',
    contributes: {
      tab: { label: 'My Tab', title: 'Custom Title' },
    },
  };

  it('getTitle returns manifest title as default', () => {
    const ctx = createMockContext({ pluginId: 'test-plugin' });
    const api = createWindowAPI(ctx, manifest);
    expect(api.getTitle()).toBe('Custom Title');
  });

  it('getTitle falls back to tab.label when no title', () => {
    const noTitleManifest: PluginManifest = {
      ...manifest,
      contributes: { tab: { label: 'My Tab' } },
    };
    const ctx = createMockContext({ pluginId: 'test-plugin' });
    const api = createWindowAPI(ctx, noTitleManifest);
    expect(api.getTitle()).toBe('My Tab');
  });

  it('getTitle falls back to manifest.name when no contributes', () => {
    const bareManifest: PluginManifest = {
      id: 'bare',
      name: 'Bare Plugin',
      version: '1.0.0',
      engine: { api: 0.8 },
      scope: 'project',
    };
    const ctx = createMockContext({ pluginId: 'bare' });
    const api = createWindowAPI(ctx, bareManifest);
    expect(api.getTitle()).toBe('Bare Plugin');
  });

  it('getTitle uses railItem.title for app-scoped plugin', () => {
    const appManifest: PluginManifest = {
      id: 'app-plugin',
      name: 'App Plugin',
      version: '1.0.0',
      engine: { api: 0.8 },
      scope: 'app',
      contributes: {
        railItem: { label: 'Rail Label', title: 'Rail Title' },
      },
    };
    const ctx = createMockContext({ pluginId: 'app-plugin', scope: 'app' });
    const api = createWindowAPI(ctx, appManifest);
    expect(api.getTitle()).toBe('Rail Title');
  });

  it('setTitle updates the store and getTitle returns it', () => {
    const ctx = createMockContext({ pluginId: 'test-plugin' });
    const api = createWindowAPI(ctx, manifest);
    api.setTitle('Hub: My Hub');
    expect(api.getTitle()).toBe('Hub: My Hub');
    expect(usePluginStore.getState().pluginTitles['test-plugin']).toBe('Hub: My Hub');
  });

  it('resetTitle clears dynamic title, reverts to default', () => {
    const ctx = createMockContext({ pluginId: 'test-plugin' });
    const api = createWindowAPI(ctx, manifest);
    api.setTitle('Dynamic Title');
    expect(api.getTitle()).toBe('Dynamic Title');
    api.resetTitle();
    expect(api.getTitle()).toBe('Custom Title');
    expect(usePluginStore.getState().pluginTitles['test-plugin']).toBeUndefined();
  });

  it('different plugins have independent titles', () => {
    const ctx1 = createMockContext({ pluginId: 'plugin-a' });
    const ctx2 = createMockContext({ pluginId: 'plugin-b' });
    const api1 = createWindowAPI(ctx1, { ...manifest, id: 'plugin-a' });
    const api2 = createWindowAPI(ctx2, { ...manifest, id: 'plugin-b' });

    api1.setTitle('Title A');
    api2.setTitle('Title B');
    expect(api1.getTitle()).toBe('Title A');
    expect(api2.getTitle()).toBe('Title B');

    api1.resetTitle();
    expect(api1.getTitle()).toBe('Custom Title');
    expect(api2.getTitle()).toBe('Title B');
  });
});
