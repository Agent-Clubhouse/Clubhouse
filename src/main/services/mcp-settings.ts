/**
 * MCP Settings — main-process settings service for the Clubhouse MCP bridge feature.
 *
 * Mirrors the clubhouse-mode-settings pattern:
 * - Global enabled toggle
 * - Per-project overrides
 * - Fallback chain: agentOverride → projectOverride → global → clubhouseMode
 */

import { createSettingsStore } from './settings-store';
import { isClubhouseModeEnabled } from './clubhouse-mode-settings';
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
