import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { createSettingsStore } from './settings-store';
import type { AgentExecutionMode } from '../orchestrators/types';

export interface OrchestratorSettings {
  enabled: string[];
  /** Per-provider default execution mode preference */
  defaultExecutionMode?: Partial<Record<string, AgentExecutionMode>>;
  /** Set to true after first-run auto-detection has completed */
  autoDetected?: boolean;
}

const SETTINGS_FILENAME = 'orchestrator-settings.json';

const store = createSettingsStore<OrchestratorSettings>(SETTINGS_FILENAME, {
  enabled: ['claude-code'],
});

export const getSettings = store.get;
export const saveSettings = store.save;

/**
 * One-time auto-detection of available orchestrators.
 *
 * On first run (no persisted settings file), probes all registered providers
 * and enables every CLI found on PATH.  This prevents users who only have
 * one CLI installed from spawning broken agents for CLIs they don't have.
 *
 * If a settings file already exists (the user — or a previous run — has
 * persisted preferences), their choices are preserved and only the
 * `autoDetected` flag is stamped so this logic never re-runs.
 */
export async function autoDetectDefaults(
  providers: Array<{ id: string; checkAvailability: () => Promise<{ available: boolean; error?: string }> }>,
): Promise<void> {
  const settings = store.get();
  if (settings.autoDetected) return;

  const filePath = path.join(app.getPath('userData'), SETTINGS_FILENAME);
  if (fs.existsSync(filePath)) {
    // User has saved settings before — preserve them, just stamp the flag
    await store.save({ ...settings, autoDetected: true });
    return;
  }

  // Fresh install — probe every provider
  const results = await Promise.all(
    providers.map(async (p) => {
      try {
        const result = await p.checkAvailability();
        return { id: p.id, available: result.available };
      } catch {
        return { id: p.id, available: false };
      }
    }),
  );

  const available = results.filter((r) => r.available).map((r) => r.id);
  // Fall back to claude-code if nothing was detected
  const enabled = available.length > 0 ? available : ['claude-code'];

  await store.save({ ...settings, enabled, autoDetected: true });
}
