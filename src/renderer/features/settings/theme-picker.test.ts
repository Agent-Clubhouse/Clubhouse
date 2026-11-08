import { describe, expect, it } from 'vitest';
import { BUILTIN_THEMES } from '../../themes';
import type { ThemeDefinition } from '../../../shared/types';
import { groupThemes, pluginIdOf, themeSource } from './theme-picker';

const builtins = Object.values(BUILTIN_THEMES);
const plugin = (pluginId: string, id: string, name: string, type: 'dark' | 'light'): ThemeDefinition =>
  ({ ...BUILTIN_THEMES[type === 'dark' ? 'nord' : 'catppuccin-latte'], id: `plugin:${pluginId}:${id}`, name, collection: undefined });
const pluginThemes = [
  plugin('acme-pack', 'dusk', 'Dusk', 'dark'),
  plugin('acme-pack', 'dawn', 'Dawn', 'light'),
  plugin('zeta-pack', 'zinc', 'Zinc', 'dark'),
  plugin('beta-pack', 'birch', 'Birch', 'light'),
  plugin('unnamed-pack', 'plain', 'Plain', 'dark'),
];
const names: Record<string, string> = { 'acme-pack': 'Acme Themes', 'zeta-pack': 'Zeta', 'beta-pack': 'Beta Colors' };
const pluginName = (id: string) => names[id];
const all = [...builtins, ...pluginThemes];

describe('theme picker grouping (#2754)', () => {
  it('reads the plugin id of a plugin theme only', () => {
    expect(pluginIdOf('plugin:acme-pack:dusk')).toBe('acme-pack');
    expect(pluginIdOf('frost')).toBeNull();
    expect(pluginIdOf('plugin:')).toBeNull();
  });

  it('groups the originals, then the seven collections, then plugins by name, with no theme lost', () => {
    const groups = groupThemes(all, { query: '', kind: 'all', pluginName });
    expect(groups.map((g) => g.label)).toEqual([
      'Clubhouse', 'Gradients', 'Fall', 'Winter', 'Spring', 'Summer', 'Ocean', 'Tech Modern', 'Neon',
      'Acme Themes', 'Beta Colors', 'unnamed-pack', 'Zeta',
    ]);
    expect(groups[0].themes).toHaveLength(9);
    expect(groups.flatMap((g) => g.themes)).toHaveLength(53);
    expect(themeSource(pluginThemes[4], pluginName).label).toBe('unnamed-pack');
  });

  it('matches every word against the name, the group and the type', () => {
    const ids = (query: string) => groupThemes(all, { query, kind: 'all', pluginName }).flatMap((g) => g.themes.map((t) => t.id));
    expect(ids('frost')).toEqual(['frost']);
    // A word matches inside names too: "light" also finds Northern Lights. The Light filter is exact.
    expect(ids('winter light')).toEqual(['frost', 'evergreen', 'northern-lights', 'snowfall']);
    expect(groupThemes(all, { query: 'winter', kind: 'light', pluginName }).flatMap((g) => g.themes.map((t) => t.id))).toEqual(['frost', 'evergreen', 'snowfall']);
    expect(ids('ACME')).toEqual(['plugin:acme-pack:dusk', 'plugin:acme-pack:dawn']);
    expect(ids('cyberpunk')).toEqual(['cyberpunk', 'neon-cyberpunk']);
    expect(ids('no such theme')).toEqual([]);
  });

  it('filters by light or dark, and a theme with no type counts as dark', () => {
    const light = groupThemes(all, { query: '', kind: 'light', pluginName }).flatMap((g) => g.themes);
    expect(light.every((t) => t.type === 'light')).toBe(true);
    const typeless = { ...pluginThemes[0], id: 'plugin:x:y', type: undefined } as unknown as ThemeDefinition;
    expect(groupThemes([typeless], { query: '', kind: 'dark', pluginName }).flatMap((g) => g.themes)).toEqual([typeless]);
  });
});
