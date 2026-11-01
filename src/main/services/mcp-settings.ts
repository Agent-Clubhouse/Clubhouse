/**
 * MCP Settings — main-process settings service for the Clubhouse MCP bridge feature.
 *
 * Mirrors the clubhouse-mode-settings pattern:
 * - Global enabled toggle
 * - Per-project overrides
 * - Fallback chain: agentOverride → projectOverride → global → clubhouseMode
 */

import { createSettingsStore } from './settings-store';
import { isClubhouseModeEnabled, getSettings as getClubhouseModeSettings } from './clubhouse-mode-settings';
import { MCP_SETTINGS } from '../../shared/settings-definitions';
import { isDispatcherEnabled } from './dispatcher/dispatcher-settings';
import type { McpSettings } from '../../shared/types';

/**
 * The one store for this file. The settings IPC (ipc/settings-handlers) shares
 * it, so isMcpEnabled sees a change from the Settings page at once.
 */
export const mcpSettingsStore = createSettingsStore<McpSettings>(MCP_SETTINGS.filename, MCP_SETTINGS.defaults);

export const getSettings = mcpSettingsStore.get;
export const saveSettings = mcpSettingsStore.save;

const enablementListeners = new Set<() => void>();

/**
 * Listen for changes that can move isMcpEnabled at app or project level: the
 * MCP settings and Clubhouse Mode, the fallback. An agent's own `mcpOverride`
 * arrives through onAgentConfigChanged. Returns an unsubscribe function.
 */
export function onMcpEnablementChanged(listener: () => void): () => void {
  enablementListeners.add(listener);
  return () => { enablementListeners.delete(listener); };
}

export function notifyMcpEnablementChanged(): void {
  for (const listener of [...enablementListeners]) {
    try {
      listener();
    } catch {
      // telemetry-exempt: one listener failing must not stop the others
    }
  }
}

/**
 * Determine whether the Clubhouse MCP bridge is enabled, following the
 * fallback chain: agent override → project override → global → clubhouse mode.
 * The first one that is set decides: an agent turned off never gets the
 * bridge even when its project or the global toggle is on, and an agent
 * turned on gets it even when both are off.
 */
export function isMcpEnabled(projectPath?: string, agentOverride?: boolean): boolean {
  // Agent-level override takes highest priority
  if (agentOverride !== undefined) return agentOverride;

  const settings = getSettings();

  // Project-level override
  if (projectPath && settings.projectOverrides?.[projectPath] !== undefined) {
    return settings.projectOverrides[projectPath];
  }

  // Global MCP setting
  if (settings.enabled) return true;

  // Final fallback: inherit from clubhouse mode
  return isClubhouseModeEnabled(projectPath);
}

/**
 * Check whether MCP is enabled for ANY project. Used at app startup to decide
 * whether the bridge server and IPC handlers should be initialized — before a
 * specific project path is known.
 *
 * Returns true if the global MCP toggle is on, any MCP project override is
 * true, the global Clubhouse Mode toggle is on, or any Clubhouse Mode project
 * override is true. The Dispatcher (#2535) needs MCP for its tools, so it
 * turns it on while it is enabled.
 */
export function isMcpEnabledForAny(): boolean {
  const mcpSettings = getSettings();
  if (mcpSettings.enabled) return true;
  if (isDispatcherEnabled()) return true;

  if (mcpSettings.projectOverrides) {
    for (const enabled of Object.values(mcpSettings.projectOverrides)) {
      if (enabled) return true;
    }
  }

  const cmSettings = getClubhouseModeSettings();
  if (cmSettings.enabled) return true;

  if (cmSettings.projectOverrides) {
    for (const enabled of Object.values(cmSettings.projectOverrides)) {
      if (enabled) return true;
    }
  }

  return false;
}
