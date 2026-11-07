/**
 * Settings migrations for the move away from Clubhouse Mode (#2901), run by
 * the startup pass. Each makes explicit
 * something that today only follows from Clubhouse Mode, so that removing
 * Clubhouse Mode later changes nothing for the person. Nothing is removed
 * here: the old fallbacks stay until the legacy runtime goes.
 *
 * The MCP one runs at every start, since Clubhouse Mode can be turned on for
 * a project after the first run. It never changes what a project resolves
 * to, so running it again is safe. The source control one is done once,
 * recorded in `managed-agents/state.json` only after its write succeeded:
 * saving the Clubhouse Mode settings keeps the new store in step after that.
 */
import * as clubhouseModeSettings from '../clubhouse-mode-settings';
import * as mcpSettings from '../mcp-settings';
import * as sourceControlSettings from '../source-control-settings';
import type { McpSettings } from '../../../shared/types';
import { appLog } from '../log-service';
import { createManagedStateStore, type ManagedStateStore } from './state-store';
import { codeOf } from './log-code';

export const MCP_FROM_CLUBHOUSE_MODE = 'mcp-from-clubhouse-mode';
export const SOURCE_CONTROL_PROVIDER = 'source-control-provider';

/**
 * The MCP settings with every scope where Clubhouse Mode turns MCP on today
 * set explicitly (D63), so each project resolves exactly as it does now with
 * the Clubhouse Mode fallback gone. Null when nothing needs to change.
 *
 * isMcpEnabled asks the MCP project override, then the MCP app switch, then
 * Clubhouse Mode (its project override, then its app switch). With the MCP
 * app switch on, Clubhouse Mode never decides, so nothing changes.
 */
export function mcpSettingsWithoutClubhouseMode(mcp: McpSettings, mode: { enabled: boolean; projectOverrides?: Record<string, boolean> }): McpSettings | null {
  if (mcp.enabled) return null;
  const overrides = { ...(mcp.projectOverrides ?? {}) };
  let enabled = false;
  let changed = false;
  if (mode.enabled) {
    // App level on: MCP on at app level, and a project Clubhouse Mode turns off stays off for MCP.
    enabled = true;
    changed = true;
    for (const [project, on] of Object.entries(mode.projectOverrides ?? {})) {
      if (!on && overrides[project] === undefined) overrides[project] = false;
    }
  } else {
    for (const [project, on] of Object.entries(mode.projectOverrides ?? {})) {
      if (on && overrides[project] === undefined) {
        overrides[project] = true;
        changed = true;
      }
    }
  }
  if (!changed) return null;
  return { ...mcp, enabled, ...(Object.keys(overrides).length > 0 && { projectOverrides: overrides }) };
}

async function once(state: ManagedStateStore, id: string, run: () => Promise<boolean>): Promise<boolean> {
  if ((await state.read()).migrations?.[id]) return false;
  const changed = await run();
  await state.update((s) => { s.migrations = { ...(s.migrations ?? {}), [id]: new Date().toISOString() }; });
  return changed;
}

/** Run the MCP migration, and each one-time migration not done yet. Returns which ones changed a setting. Never throws. */
export async function migrateLegacySettings(state: ManagedStateStore = createManagedStateStore()): Promise<{ mcp: boolean; sourceControl: boolean }> {
  const result = { mcp: false, sourceControl: false };
  try {
    // Every start, not once: Clubhouse Mode turned on for a project since the last start is made explicit too.
    const next = mcpSettingsWithoutClubhouseMode(mcpSettings.getSettings(), clubhouseModeSettings.getSettings());
    if (next) {
      await mcpSettings.saveSettings(next);
      mcpSettings.notifyMcpEnablementChanged();
      result.mcp = true;
      // Informational only: when it last changed something. Never read to skip it.
      await state.update((s) => { s.migrations = { ...(s.migrations ?? {}), [MCP_FROM_CLUBHOUSE_MODE]: new Date().toISOString() }; });
    }
  } catch (err) {
    // telemetry-exempt: logged; the Clubhouse Mode fallback still turns MCP on, and the next start tries again.
    appLog('core:managed', 'warn', 'Could not make the MCP settings explicit', { meta: { code: codeOf(err) } });
  }
  try {
    result.sourceControl = await once(state, SOURCE_CONTROL_PROVIDER, async () => {
      const old = clubhouseModeSettings.getSettings().sourceControlProvider;
      if (!old || sourceControlSettings.getAppSourceControlProvider()) return false;
      await sourceControlSettings.setAppSourceControlProvider(old);
      return true;
    });
  } catch (err) {
    // telemetry-exempt: logged; resolveSourceControlProvider still falls back to the old place, and the next start tries again.
    appLog('core:managed', 'warn', 'Could not move the source control provider setting', { meta: { code: codeOf(err) } });
  }
  return result;
}
