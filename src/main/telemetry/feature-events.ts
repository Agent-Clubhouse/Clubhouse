/**
 * Settings and feature-usage events from main-process call sites (spec
 * §4.14). Keys and static ids only: never setting values, names or paths.
 * Renderer-side events (settings pages, command palette, onboarding, help)
 * belong to the chrome refresh (§9.1).
 */
import { ATTR, BUILTIN_THEME_IDS, type SETTINGS_KEYS } from '../../shared/telemetry/attributes';
import { tel } from './facade';

export type SettingsKey = (typeof SETTINGS_KEYS)[number];

export function settingsChanged(key: SettingsKey): void {
  tel.event('clubhouse.settings.changed', [ATTR.settingsKey(key)]);
}

const builtinThemes = new Set<string>(BUILTIN_THEME_IDS);

/** Plugin-contributed theme ids are never sent; they report `plugin` / `other`. */
export function themeChanged(themeId: string): void {
  const builtin = builtinThemes.has(themeId);
  tel.event('clubhouse.theme.changed', [
    ATTR.themeKind(builtin ? 'builtin' : 'plugin'),
    ATTR.themeBuiltinId(builtin ? (themeId as (typeof BUILTIN_THEME_IDS)[number]) : 'other'),
  ]);
  tel.event('clubhouse.settings.changed', [ATTR.settingsKey('theme')]);
}

export function popoutOpened(type: 'agent' | 'canvas'): void {
  tel.event('clubhouse.popout.opened', [ATTR.popoutType(type)]);
}

export function blueprintTransfer(direction: 'exported' | 'imported', ok: boolean): void {
  tel.event(direction === 'exported' ? 'clubhouse.blueprint.exported' : 'clubhouse.blueprint.imported', [ATTR.outcome(ok ? 'ok' : 'error')]);
}
