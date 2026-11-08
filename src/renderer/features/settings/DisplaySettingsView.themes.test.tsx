/**
 * The theme picker with the real 44 built-ins plus plugin themes (#2754),
 * and a larger set, so the design isn't tuned to one count.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisplaySettingsView } from './DisplaySettingsView';
import { useThemeStore } from '../../stores/themeStore';
import { usePluginStore } from '../../plugins/plugin-store';
import { BUILTIN_THEMES, registerTheme, unregisterTheme } from '../../themes';
import type { ThemeDefinition, ThemeId } from '../../../shared/types';

const setTheme = vi.fn();
const builtinIds = Object.keys(BUILTIN_THEMES) as ThemeId[];
const registered: string[] = [];

function addPluginTheme(pluginId: string, id: string, name: string, type: 'dark' | 'light'): ThemeId {
  const base = BUILTIN_THEMES[type === 'dark' ? 'nord' : 'catppuccin-latte'];
  const theme: ThemeDefinition = { ...base, id: `plugin:${pluginId}:${id}`, name, collection: undefined };
  registerTheme(theme);
  registered.push(theme.id);
  return theme.id;
}

function show(ids: ThemeId[], current: ThemeId = 'catppuccin-mocha') {
  useThemeStore.setState({ themeId: current, availableThemeIds: ids, setTheme, experimentalGradients: true });
  return render(<DisplaySettingsView />);
}

const cards = () => screen.getAllByRole('button', { pressed: false }).concat(screen.queryAllByRole('button', { pressed: true }))
  .filter((b) => b.dataset.testid?.startsWith('theme-card-'));
const search = () => screen.getByRole('searchbox', { name: 'Search themes' });

describe('theme picker with 44 built-ins and plugin themes (#2754)', () => {
  let pluginIds: ThemeId[];

  beforeEach(() => {
    setTheme.mockReset();
    usePluginStore.setState({
      plugins: {
        'acme-pack': { manifest: { id: 'acme-pack', name: 'Acme Themes' } },
        'beta-pack': { manifest: { id: 'beta-pack', name: 'Beta Colors' } },
      } as never,
    });
    pluginIds = [
      addPluginTheme('acme-pack', 'dusk', 'Dusk', 'dark'),
      addPluginTheme('acme-pack', 'dawn', 'Dawn', 'light'),
      addPluginTheme('acme-pack', 'ember', 'Ember', 'dark'),
      addPluginTheme('beta-pack', 'birch', 'Birch', 'light'),
      addPluginTheme('beta-pack', 'slate', 'Slate', 'dark'),
    ];
  });

  afterEach(() => {
    for (const id of registered.splice(0)) unregisterTheme(id);
    usePluginStore.setState({ plugins: {} });
  });

  it('shows every built-in and plugin theme, grouped by where it comes from', () => {
    show([...builtinIds, ...pluginIds]);
    expect(cards()).toHaveLength(49);
    const headings = within(screen.getByTestId('theme-picker')).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Clubhouse', 'Fall', 'Winter', 'Spring', 'Summer', 'Ocean', 'Tech Modern', 'Neon', 'Acme Themes', 'Beta Colors']);
    const winter = screen.getByRole('region', { name: 'Winter' });
    expect(within(winter).getAllByRole('button').map((b) => b.textContent)).toEqual(['Frost', 'Evergreen', 'Northern Lights', 'Snowfall', 'Polar Night']);
  });

  it('finds a theme by name, collection or plugin, and says what is current', () => {
    show([...builtinIds, ...pluginIds], 'frost');
    expect(screen.getByTestId('current-theme')).toHaveTextContent('Using Frost, from Winter.');
    fireEvent.change(search(), { target: { value: 'acme' } });
    expect(cards().map((c) => c.textContent)).toEqual(['Dusk', 'Dawn', 'Ember']);
    fireEvent.change(search(), { target: { value: 'polar' } });
    expect(cards().map((c) => c.textContent)).toEqual(['Polar Night']);
  });

  it('filters to light or dark themes', () => {
    show([...builtinIds, ...pluginIds]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), { target: { value: 'light' } });
    const shown = cards().map((c) => c.dataset.testid!.replace('theme-card-', ''));
    expect(shown.length).toBeGreaterThan(0);
    for (const id of shown) {
      const theme = (BUILTIN_THEMES as Record<string, ThemeDefinition>)[id];
      if (theme) expect(theme.type).toBe('light');
    }
    expect(shown).toContain('plugin:beta-pack:birch');
    expect(shown).not.toContain('plugin:beta-pack:slate');
  });

  it('keeps the current theme findable when the search hides it, and clears back to everything', () => {
    show([...builtinIds, ...pluginIds], 'nord');
    fireEvent.change(search(), { target: { value: 'frost' } });
    expect(screen.getByTestId('current-theme')).toHaveTextContent("It's hidden by the search or filter.");
    fireEvent.click(screen.getByRole('button', { name: 'Show all themes' }));
    expect(search()).toHaveValue('');
    expect(cards()).toHaveLength(49);
    expect(screen.getByTestId('theme-card-nord')).toHaveAttribute('aria-pressed', 'true');
  });

  it('says when nothing matches, and clears search and filter together', () => {
    show([...builtinIds, ...pluginIds]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), { target: { value: 'light' } });
    fireEvent.change(search(), { target: { value: 'synthwave' } });
    expect(screen.getByTestId('theme-picker-empty')).toHaveTextContent('No themes match "synthwave" among light themes.');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filter' }));
    expect(screen.getByRole('combobox', { name: 'Show' })).toHaveValue('all');
    expect(cards()).toHaveLength(49);
  });

  it('picks with the keyboard: search, then filter, then the cards in order', async () => {
    const user = userEvent.setup();
    show([...builtinIds, ...pluginIds]);
    await user.click(search());
    await user.keyboard('maple');
    await user.tab();
    expect(screen.getByRole('combobox', { name: 'Show' })).toHaveFocus();
    // The current theme (Mocha) is hidden by the search, so its way back comes next.
    await user.tab();
    expect(screen.getByRole('button', { name: 'Show all themes' })).toHaveFocus();
    await user.tab();
    expect(screen.getByTestId('theme-card-maple')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(setTheme).toHaveBeenCalledWith('maple');
  });

  it('keeps the selection it is given when filters change', () => {
    show([...builtinIds, ...pluginIds], 'electric');
    fireEvent.change(screen.getByRole('combobox', { name: 'Show' }), { target: { value: 'dark' } });
    expect(screen.getByTestId('theme-card-electric')).toHaveAttribute('aria-pressed', 'true');
    expect(setTheme).not.toHaveBeenCalled();
  });

  it('handles a larger set the same way (60 themes)', () => {
    const extra: ThemeId[] = [];
    for (let i = 0; i < 11; i++) extra.push(addPluginTheme('beta-pack', `extra-${i}`, `Extra ${i}`, i % 2 ? 'light' : 'dark'));
    show([...builtinIds, ...pluginIds, ...extra]);
    expect(cards()).toHaveLength(60);
    act(() => { fireEvent.change(search(), { target: { value: 'extra 1' } }); });
    expect(cards().map((c) => c.textContent)).toEqual(['Extra 1', 'Extra 10']);
  });
});
