import { describe, it, expect, beforeEach } from 'vitest';
import {
  syncPluginThemes,
  getPluginThemes,
  onPluginThemesChange,
  _reset,
} from './plugin-theme-store';

describe('plugin-theme-store', () => {
  beforeEach(() => {
    _reset();
  });

  it('starts empty', () => {
    expect(getPluginThemes()).toEqual([]);
  });

  it('stores synced themes', () => {
    const themes = [
      { id: 'plugin:foo:ocean', name: 'Ocean', type: 'dark' as const },
      { id: 'plugin:foo:sunrise', name: 'Sunrise', type: 'light' as const },
    ];
    syncPluginThemes(themes);
    expect(getPluginThemes()).toEqual(themes);
  });

  it('replaces themes on subsequent syncs', () => {
    syncPluginThemes([{ id: 'plugin:a:one', name: 'One', type: 'dark' }]);
    syncPluginThemes([{ id: 'plugin:b:two', name: 'Two', type: 'light' }]);
    expect(getPluginThemes()).toHaveLength(1);
    expect(getPluginThemes()[0].id).toBe('plugin:b:two');
  });

  it('notifies listeners on sync', () => {
    const callback = vi.fn();
    onPluginThemesChange(callback);
    syncPluginThemes([{ id: 'plugin:x:theme', name: 'Theme', type: 'dark' }]);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('dispose removes the listener', () => {
    const callback = vi.fn();
    const { dispose } = onPluginThemesChange(callback);
    dispose();
    syncPluginThemes([{ id: 'plugin:x:theme', name: 'Theme', type: 'dark' }]);
    expect(callback).not.toHaveBeenCalled();
  });

  it('_reset clears themes and listeners', () => {
    const callback = vi.fn();
    onPluginThemesChange(callback);
    syncPluginThemes([{ id: 'plugin:x:theme', name: 'Theme', type: 'dark' }]);
    _reset();
    expect(getPluginThemes()).toEqual([]);
    // Listener should have been cleared by _reset
    syncPluginThemes([{ id: 'plugin:y:other', name: 'Other', type: 'light' }]);
    expect(callback).toHaveBeenCalledTimes(1); // only the first sync, not the second
  });
});
