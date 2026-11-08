import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../plugins/plugin-loader', () => ({ pluginSystemReady: Promise.resolve() }));

import { usePluginStore } from '../plugins/plugin-store';
import { useToastStore } from '../stores/toastStore';
import { showRetiredPluginNotices } from './retired-plugin-notice';

function install(id: string) {
  usePluginStore.getState().registerPlugin(
    { id, name: id, version: '1.0.0', engine: { api: 0 }, scope: 'app' },
    'marketplace', `/plugins/${id}`, 'incompatible', 'retired',
  );
}

describe('showRetiredPluginNotices (#2756)', () => {
  beforeEach(() => {
    localStorage.clear();
    usePluginStore.setState({ plugins: {} });
    useToastStore.setState({ toasts: [] });
  });

  it('tells a person once per installed retired plugin', async () => {
    install('lounge');
    install('pomodoro');
    await showRetiredPluginNotices();
    const toasts = useToastStore.getState().toasts.map((t) => t.message);
    expect(toasts).toEqual(['Lounge was retired and no longer loads. Its data is kept, and you can export it from its page in Settings > Plugins.']);

    useToastStore.setState({ toasts: [] });
    await showRetiredPluginNotices();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('says nothing when none is installed', async () => {
    await showRetiredPluginNotices();
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
