import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../plugins/plugin-loader', () => ({ pluginSystemReady: Promise.resolve() }));

import { usePluginStore } from '../plugins/plugin-store';
import { useToastStore } from '../stores/toastStore';
import { showRemovedPluginApiNotice } from './removed-plugin-api-notice';

function install(id: string, name: string, api: number, status: 'incompatible' | 'registered') {
  usePluginStore.getState().registerPlugin(
    { id, name, version: '1.0.0', engine: { api }, scope: 'app' },
    'marketplace', `/plugins/${id}`, status, status === 'incompatible' ? 'refused' : undefined,
  );
}

describe('showRemovedPluginApiNotice (#2757)', () => {
  beforeEach(() => {
    localStorage.clear();
    usePluginStore.setState({ plugins: {} });
    useToastStore.setState({ toasts: [] });
  });

  it('names each refused plugin and its removed version, once', async () => {
    install('old-a', 'Old A', 0.6, 'incompatible');
    install('old-b', 'Old B', 0.5, 'incompatible');
    install('automations', 'Automations', 0.8, 'registered'); // 0.8 still loads
    install('pomodoro', 'Pomodoro', 0.9, 'registered');
    install('future', 'Future', 2.0, 'incompatible');
    install('lounge', 'Lounge', 0.6, 'incompatible'); // retired: its own notice, even on a removed API

    await showRemovedPluginApiNotice();
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      'These plugins use plugin API versions removed in Clubhouse 1.0, so they no longer load: Old A (API 0.6), Old B (API 0.5). Settings > Plugins has the details.',
    ]);

    useToastStore.setState({ toasts: [] });
    await showRemovedPluginApiNotice();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('speaks of one plugin in the singular', async () => {
    install('old-a', 'Old A', 0.5, 'incompatible');
    await showRemovedPluginApiNotice();
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      'This plugin uses a plugin API version removed in Clubhouse 1.0, so it no longer loads: Old A (API 0.5). Settings > Plugins has the details.',
    ]);
  });

  it('says nothing when every plugin loads', async () => {
    install('pomodoro', 'Pomodoro', 0.9, 'registered');
    await showRemovedPluginApiNotice();
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
