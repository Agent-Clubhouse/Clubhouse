/**
 * In-memory free-agent-settings for tests that mock `fs` (the real store
 * reads its file). `vi.mock('./free-agent-settings')` with no factory uses it.
 * Same logic as the real module; settings start at the real defaults.
 */
import {
  DEFAULT_ACCESS, accessForLegacyToggle, isAccessLevel, legacyLaunchFor, savedAccess, withAccess, type AccessLevel,
} from '../../../shared/agent-access';
import type { FreeAgentSettings } from '../free-agent-settings';
import type { FreeAgentPermissionMode } from '../../../shared/types';

let settings: FreeAgentSettings = { defaultMode: 'skip-all' };

export const getSettings = (): FreeAgentSettings => settings;
export const saveSettings = async (next: FreeAgentSettings): Promise<void> => { settings = next; };

export function getPermissionMode(projectPath?: string): FreeAgentPermissionMode {
  return (projectPath && settings.projectOverrides?.[projectPath]) || settings.defaultMode;
}

export function getDefaultAccess(): AccessLevel {
  return isAccessLevel(settings.defaultAccess) ? settings.defaultAccess : DEFAULT_ACCESS;
}

export async function setDefaultAccess(level: AccessLevel): Promise<void> {
  settings = { ...settings, defaultAccess: level };
}

export function agentAccess(record: { access?: unknown; freeAgentMode?: boolean } | undefined, projectPath?: string): AccessLevel {
  return savedAccess(record, getPermissionMode(projectPath));
}

export function accessForNewAgent(request: { access?: unknown; freeAgentMode?: boolean }, projectPath?: string): AccessLevel {
  if (isAccessLevel(request.access)) return request.access;
  const base = getDefaultAccess();
  if (request.freeAgentMode === undefined) return base;
  return accessForLegacyToggle(base, request.freeAgentMode, getPermissionMode(projectPath));
}

export function launchForAccess(level: AccessLevel, projectPath?: string) {
  return legacyLaunchFor(level, getPermissionMode(projectPath));
}

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

export function withSavedAccess<T extends { access?: AccessLevel; freeAgentMode?: boolean; quickAgentDefaults?: { access?: AccessLevel; freeAgentMode?: boolean } }>(record: T, projectPath?: string): T {
  const q = record.quickAgentDefaults;
  return {
    ...record,
    access: agentAccess(record, projectPath),
    // Quick agent defaults that set a level (or a legacy on/off) show it too.
    ...(q && (q.access !== undefined || q.freeAgentMode !== undefined) && { quickAgentDefaults: { ...q, access: quickAgentAccess(record, projectPath) } }),
  };
}

/** Test-only: reset to the defaults. */
export function __reset(): void {
  settings = { defaultMode: 'skip-all' };
}
