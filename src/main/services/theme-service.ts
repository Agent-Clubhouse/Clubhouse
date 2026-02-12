import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { ThemeId } from '../../shared/types';

interface ThemeSettings {
  themeId: ThemeId;
}

const DEFAULTS: ThemeSettings = {
  themeId: 'catppuccin-mocha',
};

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'theme-settings.json');
}

export function getSettings(): ThemeSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: ThemeSettings): void {
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf-8');
}
