/**
 * Grouping, search and the light/dark filter for the theme picker (#2754).
 * Pure, so the picker's rules are tested without rendering.
 */
import type { ThemeDefinition } from '../../../shared/types';

export type ThemeKindFilter = 'all' | 'dark' | 'light';

export interface ThemeGroup {
  key: string;
  label: string;
  themes: ThemeDefinition[];
}

/** The label for the original built-ins, which have no collection. */
export const ORIGINAL_THEMES_LABEL = 'Clubhouse';

const PLUGIN_PREFIX = 'plugin:';

/** The plugin id of a plugin theme (`plugin:<pluginId>:<themeId>`), else null. */
export function pluginIdOf(themeId: string): string | null {
  if (!themeId.startsWith(PLUGIN_PREFIX)) return null;
  const rest = themeId.slice(PLUGIN_PREFIX.length);
  const end = rest.indexOf(':');
  return end > 0 ? rest.slice(0, end) : null;
}

/** Where a theme comes from: the originals, a built-in collection, or a plugin, by its name when known. */
export function themeSource(theme: ThemeDefinition, pluginName: (pluginId: string) => string | undefined): { key: string; label: string } {
  const pluginId = pluginIdOf(theme.id);
  if (pluginId) return { key: `plugin:${pluginId}`, label: pluginName(pluginId) ?? pluginId };
  if (theme.collection) return { key: `collection:${theme.collection}`, label: theme.collection };
  return { key: 'original', label: ORIGINAL_THEMES_LABEL };
}

/**
 * The themes that match, in groups. Every word of the query must appear in
 * the theme's name, its group's label, or its type (`light`, `dark`). Groups
 * keep the order themes first appear in, which puts the originals and the
 * built-in collections first, and plugin groups follow, by name.
 */
export function groupThemes(
  themes: readonly ThemeDefinition[],
  options: { query: string; kind: ThemeKindFilter; pluginName: (pluginId: string) => string | undefined },
): ThemeGroup[] {
  const words = options.query.toLowerCase().split(/\s+/).filter(Boolean);
  const builtIn: ThemeGroup[] = [];
  const plugins: ThemeGroup[] = [];
  const byKey = new Map<string, ThemeGroup>();
  for (const theme of themes) {
    if (options.kind !== 'all' && (theme.type ?? 'dark') !== options.kind) continue;
    const source = themeSource(theme, options.pluginName);
    const haystack = `${theme.name} ${source.label} ${theme.type ?? 'dark'}`.toLowerCase();
    if (!words.every((w) => haystack.includes(w))) continue;
    let group = byKey.get(source.key);
    if (!group) {
      group = { key: source.key, label: source.label, themes: [] };
      byKey.set(source.key, group);
      (source.key.startsWith('plugin:') ? plugins : builtIn).push(group);
    }
    group.themes.push(theme);
  }
  plugins.sort((a, b) => a.label.localeCompare(b.label));
  return [...builtIn, ...plugins];
}
