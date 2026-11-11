import { createSettingsStore } from './settings-store';
import { DEFAULT_GLOBAL_HELPER_CAP, MAX_HELPER_LIMIT } from '../../shared/orchestration-policy';
import { normalizeSavedPresets, type SavedPresets } from '../../shared/helper-routing';

/** App-wide orchestration settings (#2228). Per-agent policy lives on the durable config. */
export interface OrchestrationSettings {
  /** Live helpers allowed at once across every orchestrator. */
  globalHelperCap: number;
  /** The user's helper presets (#2671): only what differs from the built-ins. */
  helperPresets?: SavedPresets;
  /** Moves on each presets write, so a stale edit can be refused. */
  helperPresetsRevision?: number;
  /** "Auto provider" for orchestrators that don't set it themselves (#2671). Off unless the user turns it on. */
  autoHelpers?: boolean;
  /** Copilot is allowed as Auto's last resort unless explicitly turned off (#3279). */
  copilotAuto?: boolean;
}

function validRevision(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validCap(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_HELPER_LIMIT;
}

const store = createSettingsStore<OrchestrationSettings>(
  'orchestration-settings.json',
  { globalHelperCap: DEFAULT_GLOBAL_HELPER_CAP },
  (raw) => ({
    globalHelperCap: validCap(raw.globalHelperCap) ? raw.globalHelperCap : DEFAULT_GLOBAL_HELPER_CAP,
    helperPresets: normalizeSavedPresets(raw.helperPresets),
    helperPresetsRevision: validRevision(raw.helperPresetsRevision),
    autoHelpers: raw.autoHelpers === true,
    copilotAuto: raw.copilotAuto !== false,
  }),
  // Presets and Auto have rows of their own, with reasons.
  { audit: { key: 'orchestration', keys: ['globalHelperCap'], ignore: ['helperPresets', 'helperPresetsRevision', 'autoHelpers', 'copilotAuto'] } },
);

export const getSettings = store.get;

/** Save settings; throws on an invalid cap so a bad value never lands on disk. */
export async function saveSettings(settings: OrchestrationSettings): Promise<void> {
  if (!validCap(settings?.globalHelperCap)) {
    throw new Error(`globalHelperCap must be a whole number from 1 to ${MAX_HELPER_LIMIT}`);
  }
  // Only the cap: presets have their own checked path, savePresets.
  await store.save({ ...getSettings(), globalHelperCap: settings.globalHelperCap });
}

export function getAutoHelpers(): boolean {
  return getSettings().autoHelpers === true;
}

/** Turn Auto on or off for the app, moving the revision. */
export async function saveAutoHelpers(on: boolean): Promise<void> {
  await store.save({ ...getSettings(), autoHelpers: on, helperPresetsRevision: getPresetsRevision() + 1 });
}

export function getCopilotAuto(): boolean {
  return getSettings().copilotAuto !== false;
}

export async function saveCopilotAuto(on: boolean): Promise<void> {
  await store.save({ ...getSettings(), copilotAuto: on, helperPresetsRevision: getPresetsRevision() + 1 });
}

/** A project's setting changed: an open page should refetch. */
export async function bumpPresetsRevision(): Promise<void> {
  await store.save({ ...getSettings(), helperPresetsRevision: getPresetsRevision() + 1 });
}

export function getPresets(): SavedPresets {
  return getSettings().helperPresets ?? {};
}

export function getPresetsRevision(): number {
  return getSettings().helperPresetsRevision ?? 0;
}

/** Save presets checked by services/helper-routing.ts, moving the revision. */
export async function savePresets(presets: SavedPresets): Promise<void> {
  await store.save({ ...getSettings(), helperPresets: presets, helperPresetsRevision: getPresetsRevision() + 1 });
}

export function getGlobalHelperCap(): number {
  return getSettings().globalHelperCap;
}
