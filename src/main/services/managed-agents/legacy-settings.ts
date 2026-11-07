/**
 * Settings migrations for the move away from Clubhouse Mode (#2901), run by
 * the startup pass. Each makes explicit something that only followed from
 * Clubhouse Mode, so that its removal changes nothing for the person. The old
 * value is read from clubhouse-mode-settings.json as plain JSON
 * (legacy-migration), and a missing file means there is nothing to move.
 * Nothing is removed here: the old file stays on disk, ignored.
 *
 * The MCP one runs at every start, since Clubhouse Mode can be turned on for
 * a project after the first run. It never changes what a project resolves
 * to, so running it again is safe. The source control one is done once,
 * recorded in `managed-agents/state.json` only after its write succeeded:
 * after that only the Agents & providers row sets the new store.
 *
 * Both run at app start whether or not the built-in parts installed.
 */
import * as mcpSettings from '../mcp-settings';
import * as sourceControlSettings from '../source-control-settings';
import type { McpSettings } from '../../../shared/types';
import { appLog } from '../log-service';
import { createManagedStateStore, managedStateDir, readManagedMigrationsSync, type ManagedStateStore } from './state-store';
import { codeOf } from './log-code';
import { readLegacyClubhouseModeSettings } from './legacy-migration';

export const MCP_FROM_CLUBHOUSE_MODE = 'mcp-from-clubhouse-mode';
export const SOURCE_CONTROL_PROVIDER = 'source-control-provider';
/** Set once the app-level MCP switch has been made explicit; after that a person's own off choice stands. */
export const MCP_APP_LEVEL_EXPLICIT = 'mcp-app-level-explicit';

/**
 * The MCP settings with every scope where Clubhouse Mode turns MCP on today
 * set explicitly (D63), so each project resolves exactly as it does now with
 * the Clubhouse Mode fallback gone. Null when nothing needs to change.
 *
 * isMcpEnabled used to ask the MCP project override, then the MCP app switch,
 * then Clubhouse Mode (its project override, then its app switch). With the
 * MCP app switch on, Clubhouse Mode never decided, so nothing changes.
 */
export function mcpSettingsWithoutClubhouseMode(
  mcp: McpSettings,
  mode: { enabled: boolean; projectOverrides?: Record<string, boolean> },
  opts: { appLevelDone?: boolean } = {},
): McpSettings | null {
  if (mcp.enabled) return null;
  // The app-level switch is made explicit once. After that, MCP off is the person's choice and stays off.
  if (mode.enabled && opts.appLevelDone) return null;
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

/** The save primeLegacyMcpSettings started, for migrateLegacySettings to finish. */
let primed: Promise<void> | null = null;

/**
 * The MCP migration up to its save, synchronously: the store holds the new
 * value in memory as soon as the save starts. With the Clubhouse Mode fallback
 * gone, isMcpEnabled reads only the MCP settings, so index.ts runs this before
 * the IPC handlers, the bridge and any spawn read them. migrateLegacySettings
 * then waits for the write and keeps the records. Skipped when state.json
 * can't be read; migrateLegacySettings then does it all. Never throws.
 */
export function primeLegacyMcpSettings(dir: string = managedStateDir()): void {
  if (primed) return;
  try {
    const migrations = readManagedMigrationsSync(dir);
    if (!migrations) return;
    const next = mcpSettingsWithoutClubhouseMode(mcpSettings.getSettings(), readLegacyClubhouseModeSettings(), { appLevelDone: !!migrations[MCP_APP_LEVEL_EXPLICIT] });
    if (next) {
      primed = mcpSettings.saveSettings(next);
      // telemetry-exempt: migrateLegacySettings awaits it and logs a failure; this only keeps it from reading as unhandled meanwhile.
      primed.catch(() => {});
    }
  } catch (err) {
    // telemetry-exempt: logged; migrateLegacySettings tries again in the background.
    appLog('core:managed', 'warn', 'Could not make the MCP settings explicit before startup', { meta: { code: codeOf(err) } });
  }
}

/** Run the MCP migration, and each one-time migration not done yet. Returns which ones changed a setting. Never throws. */
export async function migrateLegacySettings(state: ManagedStateStore = createManagedStateStore()): Promise<{ mcp: boolean; sourceControl: boolean }> {
  const result = { mcp: false, sourceControl: false };
  try {
    // Every start, not once: Clubhouse Mode turned on for a project since the last start is made explicit too.
    const mode = readLegacyClubhouseModeSettings();
    const appLevelDone = !!(await state.read()).migrations?.[MCP_APP_LEVEL_EXPLICIT];
    // A failed primed write throws here, so nothing below records a change that wasn't saved.
    const primedSave = primed;
    primed = null;
    if (primedSave) await primedSave;
    const next = mcpSettingsWithoutClubhouseMode(mcpSettings.getSettings(), mode, { appLevelDone });
    if (next) await mcpSettings.saveSettings(next);
    if (primedSave || next) {
      mcpSettings.notifyMcpEnablementChanged();
      mcpSettings.startMcpBridgeIfEnabled();
      result.mcp = true;
      // Informational only: when it last changed something. Never read to skip it.
      await state.update((s) => { s.migrations = { ...(s.migrations ?? {}), [MCP_FROM_CLUBHOUSE_MODE]: new Date().toISOString() }; });
    }
    // Once Clubhouse Mode's app-level meaning has been made explicit (now or by an earlier start), stop re-applying it.
    if (mode.enabled && !appLevelDone) {
      await state.update((s) => { s.migrations = { ...(s.migrations ?? {}), [MCP_APP_LEVEL_EXPLICIT]: new Date().toISOString() }; });
    }
  } catch (err) {
    // telemetry-exempt: logged; the next start tries again.
    appLog('core:managed', 'warn', 'Could not make the MCP settings explicit', { meta: { code: codeOf(err) } });
  }
  try {
    result.sourceControl = await once(state, SOURCE_CONTROL_PROVIDER, async () => {
      const old = readLegacyClubhouseModeSettings().sourceControlProvider;
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

/** Tests only. */
export function _resetLegacySettingsForTesting(): void {
  primed = null;
}
