import { createSettingsStore } from './settings-store';

export interface SessionSettings {
  /** When true, prompt for a session name when a durable agent stops (default: false) */
  promptForName: boolean;
  /** Per-project overrides keyed by project path */
  projectOverrides?: Record<string, boolean>;
}

const store = createSettingsStore<SessionSettings>('session-settings.json', {
  promptForName: false,
});

export const getSettings = store.get;
export const saveSettings = store.save;

/** Resolve whether the prompt is enabled for a given project. */
export function shouldPromptForName(projectPath?: string): boolean {
  const settings = getSettings();
  if (projectPath && settings.projectOverrides?.[projectPath] !== undefined) {
    return settings.projectOverrides[projectPath];
  }
  return settings.promptForName;
}
