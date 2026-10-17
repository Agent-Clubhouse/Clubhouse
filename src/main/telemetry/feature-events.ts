/**
 * Settings and feature-usage events from main-process call sites (spec
 * §4.14). Keys and static ids only: never setting values, names or paths.
 * Renderer-side events (settings pages, command palette, onboarding, help)
 * belong to the chrome refresh (§9.1).
 */
import { ATTR, BUILTIN_THEME_IDS, SETTINGS_KEYS, countBucket } from '../../shared/telemetry/attributes';
import { tel } from './facade';

export type SettingsKey = (typeof SETTINGS_KEYS)[number];

const settingsKeys = new Set<string>(SETTINGS_KEYS);

/**
 * Managed-settings keys never reported: TELEMETRY_SETTINGS has no generic
 * save IPC, and its own actions are measured as clubhouse.telemetry.*.
 */
export const SETTINGS_KEYS_EXCLUDED = ['telemetry'] as const;

export function isSettingsKey(key: string): key is SettingsKey {
  return settingsKeys.has(key);
}

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

/** An agent's MCP tools/list (spec §12 H8): the count bucket and whether it was empty, never tool names. */
export function recordToolsList(toolCount: number): void {
  tel.event('clubhouse.mcp.tools_list', [ATTR.mcpToolsCount(countBucket(toolCount)), ATTR.mcpToolsEmpty(toolCount === 0)]);
}
