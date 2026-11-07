/**
 * Settings migrations for the move away from Clubhouse Mode (#2901), run by
 * the startup pass. Each makes explicit something that only followed from
 * Clubhouse Mode, so that its removal changes nothing for the person. The old
 * value is read from clubhouse-mode-settings.json as plain JSON
 * (legacy-migration), and a missing file means there is nothing to move.
 * Nothing is removed here: the old file stays on disk, ignored.
 *
 * The source control one (D61) is done once, recorded in
 * `managed-agents/state.json` only after its write succeeded: after that only
 * the Agents & providers row sets the new store. It runs at app start whether
 * or not the built-in parts installed.
 *
 * The MCP one (D63) is gone: the Clubhouse MCP always runs, so there is no
 * MCP setting left to make explicit. Its old `migrations` records stay in
 * state.json, ignored.
 */
import * as sourceControlSettings from '../source-control-settings';
import { appLog } from '../log-service';
import { createManagedStateStore, type ManagedStateStore } from './state-store';
import { codeOf } from './log-code';
import { readLegacyClubhouseModeSettings } from './legacy-migration';

export const SOURCE_CONTROL_PROVIDER = 'source-control-provider';

async function once(state: ManagedStateStore, id: string, run: () => Promise<boolean>): Promise<boolean> {
  if ((await state.read()).migrations?.[id]) return false;
  const changed = await run();
  await state.update((s) => { s.migrations = { ...(s.migrations ?? {}), [id]: new Date().toISOString() }; });
  return changed;
}

/** Run each one-time migration not done yet. Returns which ones changed a setting. Never throws. */
export async function migrateLegacySettings(state: ManagedStateStore = createManagedStateStore()): Promise<{ sourceControl: boolean }> {
  const result = { sourceControl: false };
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
