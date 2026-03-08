import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export interface SettingsStore<T> {
  get(): T;
  save(settings: T): void;
  /** Sequential read-modify-write: reads the current value, applies `fn`, saves, and returns the updated value. */
  update(fn: (current: T) => T): T;
}

export function createSettingsStore<T>(
  filename: string,
  defaults: T,
  migrate?: (raw: Record<string, unknown>) => T,
): SettingsStore<T> {
  const filePath = path.join(app.getPath('userData'), filename);
  const store: SettingsStore<T> = {
    get() {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = { ...defaults, ...JSON.parse(raw) };
        return migrate ? migrate(parsed) : parsed;
      } catch (err) {
        // Use console.warn here — cannot use appLog because log-settings itself
        // depends on this store, and calling appLog would create infinite recursion.
        if (fs.existsSync(filePath)) {
          console.warn(`[settings-store] Failed to parse ${filename}, using defaults:`, err instanceof Error ? err.message : err);
        }
        return { ...defaults };
      }
    },
    save(settings: T) {
      fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
    },
    update(fn: (current: T) => T): T {
      const current = store.get();
      const updated = fn(current);
      store.save(updated);
      return updated;
    },
  };
  return store;
}
