import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export interface OrchestratorSettings {
  enabled: string[];
}

const DEFAULTS: OrchestratorSettings = {
  enabled: ['claude-code'],
};

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'orchestrator-settings.json');
}

export function getSettings(): OrchestratorSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: OrchestratorSettings): void {
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf-8');
}
