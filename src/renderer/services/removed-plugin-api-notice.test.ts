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
    install('automations', 'Automations', 0.8, 'incompatible');
    install('wiki', 'Wiki', 0.7, 'incompatible');
    install('pomodoro', 'Pomodoro', 0.9, 'registered');
    install('future', 'Future', 2.0, 'incompatible');

    await showRemovedPluginApiNotice();
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      'These plugins use plugin API versions removed in Clubhouse 1.0, so they no longer load: Automations (API 0.8), Wiki (API 0.7). Settings > Plugins has the details.',
    ]);

    useToastStore.setState({ toasts: [] });
    await showRemovedPluginApiNotice();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('says nothing when every plugin loads', async () => {
    install('pomodoro', 'Pomodoro', 0.9, 'registered');
    await showRemovedPluginApiNotice();
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
