import { backupUnreadableSettings, createSettingsStore, latestRecoveryCopy, peekStoredSettingsSync } from './settings-store';
import { isPreviewEligible } from './preview-eligible';
import { PREVIEW_ONLY_EXPERIMENTAL_FLAGS, STRUCTURED_MODE_REMOVED_NOTICE_KEY, type ExperimentalSettings } from '../../shared/types';

/**
 * Drop the removed `structuredMode` flag. Agents that used structured mode now
 * run in the terminal; if the flag was on, leave a marker so the renderer can
 * tell the user once. Saving the migrated settings removes the old key from disk.
 */
export function migrateExperimentalSettings(raw: Record<string, unknown>): ExperimentalSettings {
  const settings = { ...raw };
  if ('structuredMode' in settings) {
    if (settings.structuredMode === true) settings[STRUCTURED_MODE_REMOVED_NOTICE_KEY] = true;
    delete settings.structuredMode;
  }
  return settings as ExperimentalSettings;
}

const FILE = 'experimental-settings.json';
const store = createSettingsStore<ExperimentalSettings>(FILE, {}, migrateExperimentalSettings, { audit: { key: 'experimental' } });

function pickFlags(settings: ExperimentalSettings, keep: (key: string) => boolean): ExperimentalSettings {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => keep(key)));
}

const isPreviewOnly = (key: string): boolean => PREVIEW_ONLY_EXPERIMENTAL_FLAGS.includes(key);

/** What is saved, whatever this build honours. */
export const getStoredSettings = store.get;

/** The flags in force: in a build that isn't preview-eligible, the preview-only ones read as off. An unverified main-owned flag isn't a flag at all. */
export function getSettings(): ExperimentalSettings {
  const saved = store.get();
  const eligible = isPreviewEligible();
  return pickFlags(saved, (key) => (eligible || !isPreviewOnly(key)) && !(MAIN_OWNED_FLAGS.includes(key) && typeof saved[key] !== 'boolean'));
}

/**
 * Saved flags only main sets. The renderer gets them with the rest, and whatever
 * it sends back for them, including nothing, leaves the saved value alone.
 */
const MAIN_OWNED_FLAGS: readonly string[] = ['telemetry'];

/**
 * A main-owned flag whose value was lost: the file couldn't be read and is being
 * overwritten. Its key stays, so the next load still knows the value can't be
 * verified, however any other save went. `null` because it's falsy everywhere:
 * older builds read their flags with `=== true` and `!!`, and keep the key.
 */
const unverifiedFlags = (): ExperimentalSettings =>
  Object.fromEntries(MAIN_OWNED_FLAGS.map((key): [string, null] => [key, null])) as unknown as ExperimentalSettings;

/** What one flag holds on disk right now, not what this run has in memory. A value of the wrong type is unreadable. */
export function peekStoredFlag(key: string): 'true' | 'false' | 'missing' | 'unreadable' {
  const stored = peekStoredSettingsSync(FILE);
  if (stored === 'missing' || stored === 'unreadable') return stored;
  if (!(key in stored)) return 'missing';
  return stored[key] === true ? 'true' : stored[key] === false ? 'false' : 'unreadable';
}

/**
 * Keep a copy of a file that can't be read, because the next save replaces it.
 * Throws if it can't, and the save must then not happen.
 */
export function preserveUnreadableFile(): void {
  if (peekStoredSettingsSync(FILE) === 'unreadable') backupUnreadableSettings(FILE);
}

/** Where a copy of the unreadable file was kept, if one was. */
export function recoveryCopyPath(): string | undefined {
  return latestRecoveryCopy(FILE);
}

/**
 * Set one saved flag and leave the rest as they are, whatever this build honours.
 * Rejects if it can't be saved, with this run back on the value it had: the store
 * takes a new value into memory before writing it.
 */
export async function setStoredFlag(key: string, value: boolean): Promise<void> {
  const saved = store.get();
  if (saved[key] === value && peekStoredSettingsSync(FILE) !== 'unreadable') return;
  let copyKept = false;
  try {
    await store.update((current) => {
      preserveUnreadableFile();
      copyKept = true;
      return { ...current, [key]: value };
    });
  } catch (err) {
    // No copy means no write was tried, and the file mustn't be replaced now.
    if (copyKept) {
      await store.update((current) => {
        const { [key]: _attempted, ...rest } = current;
        const restored = key in saved ? { ...rest, [key]: saved[key] } : rest;
        return peekStoredSettingsSync(FILE) === 'unreadable' ? { ...restored, ...unverifiedFlags() } : restored;
      }).catch((): void => undefined);
    }
    throw err;
  }
}

/**
 * Save the flags. Callers write back what getSettings gave them, so in a build
 * that isn't preview-eligible the saved preview-only flags are kept as they are,
 * and turning Preview on later finds them again. Main-owned flags are kept as
 * saved in every build.
 */
export async function saveSettings(settings: ExperimentalSettings): Promise<void> {
  const eligible = isPreviewEligible();
  const keepSaved = (key: string): boolean => MAIN_OWNED_FLAGS.includes(key) || (!eligible && isPreviewOnly(key));
  // Inside the update, so it runs after any save still being written: a file
  // part way through a write mustn't read as unreadable.
  await store.update((saved) => {
    const unreadable = peekStoredSettingsSync(FILE) === 'unreadable';
    if (unreadable) preserveUnreadableFile();
    return {
      ...pickFlags(settings, (key) => !keepSaved(key)),
      ...pickFlags(saved, keepSaved),
      ...(unreadable ? unverifiedFlags() : {}),
    };
  });
}
