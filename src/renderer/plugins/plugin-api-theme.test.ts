import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ThemeId, ThemeDefinition } from '../../shared/types';
import type { PluginContext } from '../../shared/plugin-types';

vi.mock('../themes/apply-theme', () => ({
  applyTheme: vi.fn(),
}));

const mockApp = {
  updateTitleBarOverlay: vi.fn(),
  syncPluginThemes: vi.fn(),
};
vi.stubGlobal('window', { clubhouse: { app: mockApp } });
vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() });

import { useThemeStore } from '../stores/themeStore';
import { THEMES, registerTheme, unregisterTheme } from '../themes';
import { createThemeAPI } from './plugin-api-theme';

const packTheme: ThemeDefinition = {
  ...THEMES['dracula'],
  id: 'plugin:pack:sunset',
  name: 'Sunset',
};

function api() {
  const ctx = { subscriptions: [] as { dispose: () => void }[] } as unknown as PluginContext;
  return createThemeAPI(ctx);
}

describe('theme.onDidChange', () => {
  beforeEach(() => {
    mockApp.updateTitleBarOverlay.mockResolvedValue(undefined);
    mockApp.syncPluginThemes.mockResolvedValue(undefined);
    registerTheme(packTheme);
    useThemeStore.setState({ themeId: packTheme.id as ThemeId, theme: packTheme, experimentalGradients: false });
  });

  afterEach(() => {
    unregisterTheme(packTheme.id);
  });

  it('fires with the fallback when the selected pack theme is unregistered, and again when it returns', () => {
    const seen: string[] = [];
    const sub = api().onDidChange((t) => seen.push(t.id));

    unregisterTheme(packTheme.id);
    // The selection is kept; only the applied theme falls back
    expect(useThemeStore.getState().themeId).toBe(packTheme.id);
    expect(seen).toEqual(['catppuccin-mocha']);

    registerTheme(packTheme);
    expect(seen).toEqual(['catppuccin-mocha', packTheme.id]);
    sub.dispose();
  });

  it('re-registering the active theme with new colours updates getCurrent() and fires onDidChange (#2123)', () => {
    const seen: string[] = [];
    const sub = api().onDidChange((t) => seen.push(t.colors.base));
    const updated: ThemeDefinition = { ...packTheme, colors: { ...packTheme.colors, base: '#123456' } };
    registerTheme(updated);
    expect(api().getCurrent().colors.base).toBe('#123456');
    expect(seen).toEqual(['#123456']);
    // Re-registering the identical definition again changes nothing.
    registerTheme(updated);
    expect(seen).toEqual(['#123456']);
    sub.dispose();
  });

  it('does not fire for unrelated store updates', () => {
    const cb = vi.fn();
    const sub = api().onDidChange(cb);
    useThemeStore.setState({ availableThemeIds: [] });
    expect(cb).not.toHaveBeenCalled();
    sub.dispose();
  });
});
