import { backupUnreadableSettings, createSettingsStore, latestRecoveryCopy, peekStoredSettingsSync } from './settings-store';
import { isPreviewEligible } from './preview-eligible';
import { PREVIEW_ONLY_EXPERIMENTAL_FLAGS, STRUCTURED_MODE_REMOVED_NOTICE_KEY, type ExperimentalSettings } from '../../shared/types';
import { RICH_CHAT_CONTENT_FLAG } from '../../shared/chat';
import { NEW_CHROME_FLAG } from '../../shared/chrome-flag';
import { isGraduatedFlagOn } from '../../shared/graduated-flags';

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

const FILENAME = 'experimental-settings.json';

// A failed save must not stay in memory: a toggle that reverted would show it again on remount, and the next save would write it.
const store = createSettingsStore<ExperimentalSettings>(FILENAME, {}, migrateExperimentalSettings, { audit: { key: 'experimental' }, rollBackFailedSaves: true });

function pickFlags(settings: ExperimentalSettings, keep: (key: string) => boolean): ExperimentalSettings {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => keep(key)));
}

const isPreviewOnly = (key: string): boolean => PREVIEW_ONLY_EXPERIMENTAL_FLAGS.includes(key);

/**
 * Whether there is a file and it can't be read. The store falls back to `{}`
 * then, which on its own looks the same as nothing saved: a graduated flag would
 * read as on when the person's saved false may be in that file.
 */
export function savedSettingsUnreadable(): boolean {
  return savesInFlight > 0 ? unreadableBeforeSaves : fileUnreadableNow();
}

const fileUnreadableNow = (): boolean => peekStoredSettingsSync(FILENAME) === 'unreadable';

/**
 * Saves queued or being written by this process. A write truncates the file
 * first, so until it finishes a read can see part of it, which isn't a broken
 * file. Meanwhile the answer stays what it was before they started.
 */
let savesInFlight = 0;
let unreadableBeforeSaves = false;

async function updateFlags(fn: (current: ExperimentalSettings) => ExperimentalSettings): Promise<void> {
  if (savesInFlight === 0) unreadableBeforeSaves = fileUnreadableNow();
  savesInFlight++;
  try {
    await store.update(fn);
  } finally {
    savesInFlight--;
  }
}

/** Off while the file can't be read: a saved false in it is an opt-out, so it isn't guessed away. */
const OFF_WHEN_UNREADABLE = ['chat', RICH_CHAT_CONTENT_FLAG, NEW_CHROME_FLAG];

/** What those read as, for the renderer and for a write over the file: a choice in it isn't guessed away. */
const offWhenUnreadable = (): ExperimentalSettings => Object.fromEntries(OFF_WHEN_UNREADABLE.map((key) => [key, false]));

/** Chat or rich content: on unless saved off, and off while the file can't be read. */
export function isGraduatedFeatureOn(key: string): boolean {
  return !savedSettingsUnreadable() && isGraduatedFlagOn(getSettings(), key);
}

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
  const stored = peekStoredSettingsSync(FILENAME);
  if (stored === 'missing' || stored === 'unreadable') return stored;
  if (!(key in stored)) return 'missing';
  return stored[key] === true ? 'true' : stored[key] === false ? 'false' : 'unreadable';
}

/**
 * Keep a copy of a file that can't be read, because the next save replaces it.
 * Throws if it can't, and the save must then not happen.
 */
export function preserveUnreadableFile(): void {
  if (fileUnreadableNow()) backupUnreadableSettings(FILENAME);
}

/** Where a copy of the unreadable file was kept, if one was. */
export function recoveryCopyPath(): string | undefined {
  return latestRecoveryCopy(FILENAME);
}

/**
 * Set one saved flag and leave the rest as they are, whatever this build honours.
 * Rejects if it can't be saved, with the file as it was and this run back on the
 * value it had.
 */
export async function setStoredFlag(key: string, value: boolean): Promise<void> {
  if (store.get()[key] === value && !savedSettingsUnreadable()) return;
  await updateFlags((current) => {
    const unreadable = fileUnreadableNow();
    if (unreadable) preserveUnreadableFile();
    return { ...current, ...(unreadable ? offWhenUnreadable() : {}), [key]: value };
  });
}

/** The flags as the renderer reads them, so it agrees with isGraduatedFeatureOn. */
export function getSettingsForRenderer(): ExperimentalSettings {
  const settings = getSettings();
  if (!savedSettingsUnreadable()) return settings;
  return { ...settings, ...offWhenUnreadable() };
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
  await updateFlags((saved) => {
    const unreadable = fileUnreadableNow();
    if (unreadable) preserveUnreadableFile();
    return {
      ...(unreadable ? offWhenUnreadable() : {}),
      ...pickFlags(settings, (key) => !keepSaved(key)),
      ...pickFlags(saved, keepSaved),
      ...(unreadable ? unverifiedFlags() : {}),
    };
  });
}
