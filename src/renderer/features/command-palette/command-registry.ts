import { SettingsSubPage } from '../../../shared/types';

export interface CommandItem {
  id: string;
  label: string;
  category: string;
  keywords?: string[];
  shortcut?: string;
  detail?: string;
  execute: () => void;
}

export const SETTINGS_PAGES: { label: string; page: SettingsSubPage }[] = [
  { label: 'About', page: 'about' },
  { label: 'Getting Started', page: 'getting-started' },
  { label: 'Agents', page: 'orchestrators' },
  { label: 'Display & UI', page: 'display' },
  { label: 'Notifications', page: 'notifications' },
  { label: 'Logging', page: 'logging' },
  { label: 'Plugins', page: 'plugins' },
  { label: 'Updates', page: 'updates' },
  { label: "What's New", page: 'whats-new' },
  { label: 'Keyboard Shortcuts', page: 'keyboard-shortcuts' },
  { label: 'Annex', page: 'annex' },
];
