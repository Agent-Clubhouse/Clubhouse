import { randomUUID } from 'crypto';
import { createSettingsStore } from './settings-store';
import { DEFAULT_GLOBAL_HELPER_CAP, MAX_HELPER_LIMIT } from '../../shared/orchestration-policy';
import { AUTO_LEVEL_FOLLOWS, AUTO_LEVELS, BUILTIN_PRESETS, PRESET_PROVIDERS, isAutoBoundLevel, normalizeSavedPresets, type AutoLevel, type PresetCell, type PresetProvider, type SavedPresets } from '../../shared/helper-routing';

type PresetCellGenerations = Partial<Record<PresetProvider, Partial<Record<AutoLevel, string>>>>;

/** App-wide orchestration settings (#2228). Per-agent policy lives on the durable config. */
export interface OrchestrationSettings {
  /** Live helpers allowed at once across every orchestrator. */
  globalHelperCap: number;
  /** The user's helper presets (#2671): only what differs from the built-ins. */
  helperPresets?: SavedPresets;
  /** Moves on each presets write, so a stale edit can be refused. */
  helperPresetsRevision?: number;
  /** Calibration-only identities. Public settings revisions keep their existing meaning. */
  helperPresetCellGenerations?: PresetCellGenerations;
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

function readCellGenerations(raw: unknown): PresetCellGenerations {
  const result: PresetCellGenerations = {};
  if (!raw || typeof raw !== 'object') return result;
  for (const provider of PRESET_PROVIDERS) {
    const row = (raw as Record<string, unknown>)[provider];
    if (!row || typeof row !== 'object') continue;
    for (const level of AUTO_LEVELS) {
      const value = (row as Record<string, unknown>)[level];
      if (typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) {
        (result[provider] ??= {})[level] = value;
      }
    }
  }
  return result;
}

function configuredCell(presets: SavedPresets, provider: PresetProvider, level: AutoLevel): PresetCell {
  return presets[provider]?.[level] ?? (isAutoBoundLevel(level)
    ? configuredCell(presets, provider, AUTO_LEVEL_FOLLOWS[level])
    : BUILTIN_PRESETS[provider][level]);
}

function nextCellGenerations(current: OrchestrationSettings, presets: SavedPresets): PresetCellGenerations {
  const result: PresetCellGenerations = {};
  for (const provider of PRESET_PROVIDERS) {
    for (const level of AUTO_LEVELS) {
      const before = configuredCell(current.helperPresets ?? {}, provider, level);
      const after = configuredCell(presets, provider, level);
      const previous = current.helperPresetCellGenerations?.[provider]?.[level];
      (result[provider] ??= {})[level] = previous && before.model === after.model && before.effort === after.effort ? previous : randomUUID();
    }
  }
  return result;
}

const store = createSettingsStore<OrchestrationSettings>(
  'orchestration-settings.json',
  { globalHelperCap: DEFAULT_GLOBAL_HELPER_CAP },
  (raw) => ({
    globalHelperCap: validCap(raw.globalHelperCap) ? raw.globalHelperCap : DEFAULT_GLOBAL_HELPER_CAP,
    helperPresets: normalizeSavedPresets(raw.helperPresets),
    helperPresetsRevision: validRevision(raw.helperPresetsRevision),
    helperPresetCellGenerations: readCellGenerations(raw.helperPresetCellGenerations),
    autoHelpers: raw.autoHelpers === true,
    copilotAuto: raw.copilotAuto !== false,
  }),
  // Presets and Auto have rows of their own, with reasons.
  { atomic: true, rollBackFailedSaves: true, audit: { key: 'orchestration', keys: ['globalHelperCap'], ignore: ['helperPresets', 'helperPresetsRevision', 'helperPresetCellGenerations', 'autoHelpers', 'copilotAuto'] } },
);

let pendingWrites = 0;
let publishedSettings: OrchestrationSettings | undefined;
type PendingRestriction = { globalHelperCap?: number; autoHelpers?: false; copilotAuto?: false };
const pendingRestrictions = new Set<PendingRestriction>();

export function getSettings(): OrchestrationSettings {
  if (pendingWrites === 0 || !publishedSettings) return store.get();
  const settings = { ...publishedSettings };
  for (const restriction of pendingRestrictions) {
    if (restriction.autoHelpers === false) settings.autoHelpers = false;
    if (restriction.copilotAuto === false) settings.copilotAuto = false;
    if (restriction.globalHelperCap !== undefined) settings.globalHelperCap = Math.min(settings.globalHelperCap, restriction.globalHelperCap);
  }
  return Object.freeze(settings);
}

/** Routing sees committed mappings and generations, never the store's attempted write cache. */
async function updateSettings(update: (current: OrchestrationSettings) => OrchestrationSettings, restriction?: PendingRestriction): Promise<void> {
  if (pendingWrites === 0) publishedSettings = store.get();
  pendingWrites++;
  if (restriction) pendingRestrictions.add(restriction);
  try {
    publishedSettings = Object.freeze(await store.update(update));
  } finally {
    if (restriction) pendingRestrictions.delete(restriction);
    pendingWrites--;
  }
}

/** Save settings; throws on an invalid cap so a bad value never lands on disk. */
export async function saveSettings(settings: OrchestrationSettings): Promise<void> {
  if (!validCap(settings?.globalHelperCap)) {
    throw new Error(`globalHelperCap must be a whole number from 1 to ${MAX_HELPER_LIMIT}`);
  }
  // Only the cap: presets have their own checked path, savePresets.
  await updateSettings((current) => ({ ...current, globalHelperCap: settings.globalHelperCap }), { globalHelperCap: settings.globalHelperCap });
}

export function getAutoHelpers(): boolean {
  return getSettings().autoHelpers === true;
}

/** Turn Auto on or off for the app, moving the revision. */
export async function saveAutoHelpers(on: boolean): Promise<void> {
  await updateSettings((current) => ({ ...current, autoHelpers: on, helperPresetsRevision: (current.helperPresetsRevision ?? 0) + 1 }),
    on ? undefined : { autoHelpers: false });
}

export function getCopilotAuto(): boolean {
  return getSettings().copilotAuto !== false;
}

export async function saveCopilotAuto(on: boolean): Promise<void> {
  await updateSettings((current) => ({ ...current, copilotAuto: on, helperPresetsRevision: (current.helperPresetsRevision ?? 0) + 1 }),
    on ? undefined : { copilotAuto: false });
}

/** A project's setting changed: an open page should refetch. */
export async function bumpPresetsRevision(): Promise<void> {
  await updateSettings((current) => ({ ...current, helperPresetsRevision: (current.helperPresetsRevision ?? 0) + 1 }));
}

export function getPresets(): SavedPresets {
  return getSettings().helperPresets ?? {};
}

export function getPresetsRevision(): number {
  return getSettings().helperPresetsRevision ?? 0;
}

export function getPresetCellGeneration(provider: PresetProvider, level: AutoLevel): string | undefined {
  return getSettings().helperPresetCellGenerations?.[provider]?.[level];
}

let cellGenerationInitialization: Promise<void> | undefined;

/** Once, outside the start lock. Missing or legacy metadata starts cold, never at a guessed revision. */
export async function ensurePresetCellGenerations(): Promise<void> {
  // The settings cache changes before rename; concurrent starts must await its durable outcome.
  if (cellGenerationInitialization) return cellGenerationInitialization;
  if (PRESET_PROVIDERS.every((provider) => AUTO_LEVELS.every((level) => getPresetCellGeneration(provider, level)))) return;
  const initializing = updateSettings((current) => ({
    ...current, helperPresetCellGenerations: nextCellGenerations(current, current.helperPresets ?? {}),
  }));
  cellGenerationInitialization = initializing;
  try {
    await initializing;
  } finally {
    cellGenerationInitialization = undefined;
  }
}

/** Save presets checked by services/helper-routing.ts, moving the revision. */
export async function savePresets(presets: SavedPresets): Promise<void> {
  await updateSettings((current) => ({
    ...current, helperPresets: presets, helperPresetsRevision: (current.helperPresetsRevision ?? 0) + 1,
    helperPresetCellGenerations: nextCellGenerations(current, presets),
  }));
}

export function getGlobalHelperCap(): number {
  return getSettings().globalHelperCap;
}
