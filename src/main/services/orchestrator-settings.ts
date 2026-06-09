import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { createSettingsStore } from './settings-store';
import type { AgentExecutionMode } from '../orchestrators/types';

export interface OrchestratorSettings {
  enabled: string[];
  /** Per-provider default execution mode preference */
  defaultExecutionMode?: Partial<Record<string, AgentExecutionMode>>;
  /**
   * Per-provider opt-in/out of the hook server (permission requests, tool
   * observability).  App-level only.  An absent entry resolves to the default
   * via {@link resolveHookServerEnabled}: on for Claude Code, off for every
   * other orchestrator (until their hook integration is better tested).
   */
  hookServerEnabled?: Partial<Record<string, boolean>>;
  /** Set to true after first-run auto-detection has completed */
  autoDetected?: boolean;
}

/** The only orchestrator whose hook server defaults to ON when unset. */
export const DEFAULT_HOOK_SERVER_ORCHESTRATOR = 'claude-code';

const SETTINGS_FILENAME = 'orchestrator-settings.json';

const store = createSettingsStore<OrchestratorSettings>(SETTINGS_FILENAME, {
  enabled: ['claude-code'],
});

export const getSettings = store.get;
export const saveSettings = store.save;
/** Read-modify-write merge so partial saves never clobber sibling fields. */
export const updateSettings = store.update;

/**
 * Resolve whether the hook server is enabled for an orchestrator, applying the
 * default when no explicit preference is stored: ON for Claude Code, OFF for
 * everything else.
 */
export function resolveHookServerEnabled(
  settings: OrchestratorSettings,
  orchestratorId: string,
): boolean {
  const explicit = settings.hookServerEnabled?.[orchestratorId];
  if (explicit !== undefined) return explicit;
  return orchestratorId === DEFAULT_HOOK_SERVER_ORCHESTRATOR;
}

/** Convenience: resolve the hook server preference from the persisted store. */
export function isHookServerEnabled(orchestratorId: string): boolean {
  return resolveHookServerEnabled(store.get(), orchestratorId);
}

/**
 * Persist the per-orchestrator hook server preference (merging into existing
 * settings) and return the updated settings object.
 */
export function setHookServerEnabled(
  orchestratorId: string,
  enabled: boolean,
): Promise<OrchestratorSettings> {
  return store.update((current) => ({
    ...current,
    hookServerEnabled: {
      ...current.hookServerEnabled,
      [orchestratorId]: enabled,
    },
  }));
}

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
