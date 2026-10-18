import { createSettingsStore } from './settings-store';
import { DEFAULT_GLOBAL_HELPER_CAP, MAX_HELPER_LIMIT } from '../../shared/orchestration-policy';

/** App-wide orchestration settings (#2228). Per-agent policy lives on the durable config. */
export interface OrchestrationSettings {
  /** Live helpers allowed at once across every orchestrator. */
  globalHelperCap: number;
}

function validCap(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_HELPER_LIMIT;
}

const store = createSettingsStore<OrchestrationSettings>(
  'orchestration-settings.json',
  { globalHelperCap: DEFAULT_GLOBAL_HELPER_CAP },
  (raw) => ({ globalHelperCap: validCap(raw.globalHelperCap) ? raw.globalHelperCap : DEFAULT_GLOBAL_HELPER_CAP }),
);

export const getSettings = store.get;

/** Save settings; throws on an invalid cap so a bad value never lands on disk. */
export async function saveSettings(settings: OrchestrationSettings): Promise<void> {
  if (!validCap(settings?.globalHelperCap)) {
    throw new Error(`globalHelperCap must be a whole number from 1 to ${MAX_HELPER_LIMIT}`);
  }
  await store.save({ globalHelperCap: settings.globalHelperCap });
}

export function getGlobalHelperCap(): number {
  return getSettings().globalHelperCap;
}
