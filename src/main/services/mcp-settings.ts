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
import type { McpSettings } from '../../shared/types';

const store = createSettingsStore<McpSettings>('mcp-settings.json', {
  enabled: false,
});

export const getSettings = store.get;
export const saveSettings = store.save;

/**
 * Determine whether the Clubhouse MCP bridge is enabled, following the
 * fallback chain: agent override → project override → global → clubhouse mode.
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
 * override is true.
 */
export function isMcpEnabledForAny(): boolean {
  const mcpSettings = getSettings();
  if (mcpSettings.enabled) return true;

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
