/** Internal read evidence only. Consumers validate/project their own selected fields. */
import { peekStoredSettingsSync, type SettingsStore } from './settings-store';
export type DisplaySettings = { state: 'ok'; raw: Readonly<Record<string, unknown>>; source: 'host-cache' | 'primary'; missing: boolean; observedAt: number }
  | { state: 'unavailable'; source: 'host-cache' | 'primary'; observedAt: number };
export const DISPLAY_SETTINGS_MAX_BYTES = 256 * 1024;

/** No generic get, load, migration, callbacks or defaults. Filenames come from trusted service constants. */
export function readDisplaySettings<T>(store: Pick<SettingsStore<T>, 'peekLoaded'>, filename: string): DisplaySettings {
  const cached = store.peekLoaded?.();
  const raw = cached ? cached.primary : peekStoredSettingsSync(filename, { maxBytes: DISPLAY_SETTINGS_MAX_BYTES });
  const source = cached ? 'host-cache' : 'primary';
  const observedAt = cached?.observedAt ?? Date.now();
  if (raw === 'unreadable') return { state: 'unavailable', source, observedAt };
  return { state: 'ok', raw: raw === 'missing' ? {} : raw, missing: raw === 'missing', source, observedAt };
}

export interface DisplayInput { field: string; source: 'agent' | 'host-cache' | 'primary'; observedAt: number }
export type DisplayValue<T> = { state: 'ok'; value: T; inputs: DisplayInput[] } | { state: 'unavailable'; inputs: DisplayInput[] };
export const ownDisplayValue = (raw: Readonly<Record<string, unknown>>, key: string): unknown => Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined;
export const displayInput = (field: string, evidence: Pick<DisplaySettings, 'source' | 'observedAt'>): DisplayInput => ({ field, source: evidence.source, observedAt: evidence.observedAt });
export const agentDisplayInput = (field: string): DisplayInput => ({ field, source: 'agent', observedAt: Date.now() });
