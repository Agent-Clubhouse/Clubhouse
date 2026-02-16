import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export interface SettingsStore<T> {
  get(): T;
  save(settings: T): void;
}

export function createSettingsStore<T>(
  filename: string,
  defaults: T,
): SettingsStore<T> {
  const filePath = path.join(app.getPath('userData'), filename);
  return {
    get() {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return { ...defaults, ...JSON.parse(raw) };
      } catch {
        return { ...defaults };
      }
    },
    save(settings: T) {
      fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
    },
  };
}
