/**
 * Settings and feature-usage events from main-process call sites (spec
 * §4.14). Keys and static ids only: never setting values, names or paths.
 * Renderer-side events (settings pages, command palette, onboarding, help)
 * belong to the chrome refresh (§9.1).
 */
import { ATTR, BUILTIN_THEME_IDS, SETTINGS_KEYS, countBucket } from '../../shared/telemetry/attributes';
import { tel } from './facade';
import type { HelperRouting } from '../../shared/helper-routing';
import { modelFamily } from './spawn-telemetry';

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

function knownCli(cli: string | null): 'claude-code' | 'codex-cli' | 'copilot-cli' | 'other' {
  return cli === 'claude-code' || cli === 'codex-cli' || cli === 'copilot-cli' ? cli : 'other';
}

const EFFORT_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/** A start's decision: closed codes and a model family, never the raw model id. */
export function helperRouted(routing: HelperRouting): void {
  const { requested, resolved, source } = routing;
  tel.event('clubhouse.helper.routed', [
    ATTR.helperRoutingRequestedCli(requested.provider ? knownCli(requested.provider) : 'unset'),
    ATTR.helperRoutingDifficulty(resolved.difficulty ?? 'none'),
    ATTR.helperRoutingMode(routing.mode),
    ATTR.orchestrator(knownCli(resolved.provider)),
    ATTR.modelFamily(modelFamily(resolved.model ?? undefined)),
    ATTR.helperRoutingEffort(!resolved.effort ? 'none' : EFFORT_LEVELS.has(resolved.effort) ? resolved.effort as 'low' : 'other'),
    ATTR.helperRoutingPreset(source.model === 'custom_mapping' ? 'custom' : source.model === 'builtin_mapping' ? 'builtin' : 'none'),
    ATTR.helperRoutingConfigSource(source.model),
    ATTR.helperRoutingReason(routing.reason),
    ATTR.helperRoutingFallback(routing.fallback),
    ATTR.helperRoutingPolicyVersion(routing.policyVersion),
  ]);
}

/** Presets were changed or reset. Never the values. */
export function helperPresetsChanged(
  action: 'set' | 'reset_cell' | 'reset_provider' | 'reset_all',
  surface: 'ui' | 'mcp' | 'mobile' | 'dispatcher' | 'persona' | 'system',
  ok: boolean,
): void {
  tel.event('clubhouse.helper_routing.changed', [
    ATTR.helperPresetsAction(action), ATTR.helperPresetsSurface(surface), ATTR.outcome(ok ? 'ok' : 'error'),
  ]);
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
