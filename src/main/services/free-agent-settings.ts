import { createSettingsStore } from './settings-store';
import { readDisplaySettings, ownDisplayValue, displayInput, agentDisplayInput, type DisplayValue } from './display-settings';
import type { FreeAgentPermissionMode } from '../../shared/types';
import {
  DEFAULT_ACCESS, accessForLegacyToggle, isAccessLevel, legacyLaunchFor, savedAccess, withAccess, isLegacyFreeAgent, type AccessLevel,
} from '../../shared/agent-access';

export type { FreeAgentPermissionMode };

/**
 * App access settings, in free-agent-settings.json. `defaultAccess` is the
 * Default access for new agents (#2761). `defaultMode` and `projectOverrides`
 * are the retired "free agent permission mode": nothing edits them any more,
 * and they are read only to turn an agent saved before #2761 into its level.
 */
export interface FreeAgentSettings {
  defaultMode: FreeAgentPermissionMode;
  projectOverrides?: Record<string, FreeAgentPermissionMode>;
  defaultAccess?: AccessLevel;
}

const store = createSettingsStore<FreeAgentSettings>('free-agent-settings.json', {
  defaultMode: 'skip-all',
}, undefined, { displaySnapshot: true, audit: { key: 'free_agent', keys: ['defaultMode', 'defaultAccess'] } });

export const getSettings = store.get;
export const saveSettings = store.save;

/** The retired free agent permission mode, frozen at its last value. Only legacy reads use it. */
export function getPermissionMode(projectPath?: string): FreeAgentPermissionMode {
  const settings = getSettings();
  if (projectPath && settings.projectOverrides?.[projectPath]) {
    return settings.projectOverrides[projectPath];
  }
  return settings.defaultMode;
}

/** The Default access new agents start at. */
export function getDefaultAccess(): AccessLevel {
  const value = getSettings().defaultAccess;
  return isAccessLevel(value) ? value : DEFAULT_ACCESS;
}

export async function setDefaultAccess(level: AccessLevel): Promise<void> {
  if (!isAccessLevel(level)) throw new Error(`Unknown access level: ${String(level)}`);
  await saveSettings({ ...getSettings(), defaultAccess: level });
}

/** An agent's saved Access, migrating a record saved before #2761 with its project's old mode. */
export function agentAccess(record: { access?: unknown; freeAgentMode?: boolean } | undefined, projectPath?: string): AccessLevel {
  return savedAccess(record, getPermissionMode(projectPath));
}

/**
 * The Access a new agent gets. An explicit level wins. A legacy on/off
 * (an older phone, the plugin API, an MCP tool) maps from the Default access:
 * on keeps a default that is already on, or takes the old mode's level; off
 * keeps a default that is already off, or becomes Ask first. Neither gives
 * the Default access.
 */
export function accessForNewAgent(request: { access?: unknown; freeAgentMode?: boolean }, projectPath?: string): AccessLevel {
  if (isAccessLevel(request.access)) return request.access;
  const base = getDefaultAccess();
  if (request.freeAgentMode === undefined) return base;
  return accessForLegacyToggle(base, request.freeAgentMode, getPermissionMode(projectPath));
}

/** The legacy launch pair for a level, keeping the old mode when Free Agent Mode is off. */
export function launchForAccess(level: AccessLevel, projectPath?: string): { freeAgentMode: boolean; permissionMode: FreeAgentPermissionMode } {
  return legacyLaunchFor(level, getPermissionMode(projectPath));
}

/** The Access a durable agent's quick agents start at: its quick agent defaults' level, else its own. */
export function quickAgentAccess(
  parent: { access?: unknown; freeAgentMode?: boolean; quickAgentDefaults?: { access?: unknown; freeAgentMode?: boolean } },
  projectPath?: string,
): AccessLevel {
  const q = parent.quickAgentDefaults;
  if (q && (isAccessLevel(q.access) || q.freeAgentMode !== undefined)) {
    return withAccess({ access: isAccessLevel(q.access) ? q.access : undefined, freeAgentMode: q.freeAgentMode }, getPermissionMode(projectPath)).access ?? DEFAULT_ACCESS;
  }
  return agentAccess(parent, projectPath);
}

/** A record as the renderer reads it: with its Access filled in, so an agent saved before #2761 shows its real level. */
export function withSavedAccess<T extends { access?: AccessLevel; freeAgentMode?: boolean; quickAgentDefaults?: { access?: AccessLevel; freeAgentMode?: boolean } }>(record: T, projectPath?: string): T {
  const q = record.quickAgentDefaults;
  return {
    ...record,
    access: agentAccess(record, projectPath),
    // Quick agent defaults that set a level (or a legacy on/off) show it too.
    ...(q && (q.access !== undefined || q.freeAgentMode !== undefined) && { quickAgentDefaults: { ...q, access: quickAgentAccess(record, projectPath) } }),
  };
}

/** Selected agent Access, without loading global settings when the result does not depend on them. */
export function readAgentAccessForDisplay(record: { access?: unknown; freeAgentMode?: unknown }, projectPath: string): DisplayValue<AccessLevel> {
  const inputs = [agentDisplayInput('Agent Access')];
  if (record.access !== undefined && !isAccessLevel(record.access)
    || record.freeAgentMode !== undefined && typeof record.freeAgentMode !== 'boolean') return { state: 'unavailable', inputs };
  const selected = record as { access?: unknown; freeAgentMode?: boolean };
  if (record.freeAgentMode !== true || isAccessLevel(record.access) && isLegacyFreeAgent(record.access)) {
    return { state: 'ok', value: savedAccess(selected, undefined), inputs };
  }
  const evidence = readDisplaySettings(store, 'free-agent-settings.json'); inputs.push(displayInput('Host legacy access default', evidence));
  if (evidence.state !== 'ok') return { state: 'unavailable', inputs };
  const overrides = ownDisplayValue(evidence.raw, 'projectOverrides');
  if (overrides !== undefined && (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))) return { state: 'unavailable', inputs };
  const override = overrides ? ownDisplayValue(overrides as Record<string, unknown>, projectPath) : undefined;
  const mode = override ?? ownDisplayValue(evidence.raw, 'defaultMode') ?? 'skip-all';
  if (mode !== 'auto' && mode !== 'skip-all') return { state: 'unavailable', inputs };
  return { state: 'ok', value: savedAccess(selected, mode), inputs };
}
