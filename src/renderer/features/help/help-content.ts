import gettingStarted from './content/general-getting-started.md';
import commandPalette from './content/general-command-palette.md';
import navigation from './content/general-navigation.md';
import keyboardShortcuts from './content/general-keyboard-shortcuts.md';
import updates from './content/general-updates.md';
import projectsOverview from './content/projects-overview.md';
import projectsGit from './content/projects-git.md';
import projectsSettings from './content/projects-settings.md';
import agentsOverview from './content/agents-overview.md';
import agentsDurable from './content/agents-durable.md';
import agentsQuick from './content/agents-quick.md';
import agentsTerminal from './content/agents-terminal.md';
import agentsOrchestratedHelpers from './content/agents-orchestrated-helpers.md';
import agentsActions from './content/agents-actions.md';
import groupProjects from './content/group-projects.md';
import groupProjectGlossary from './content/group-project-glossary.md';
import agentsHandoffs from './content/agents-handoffs.md';
import agentsDispatcherChrome from './content/agents-dispatcher.chrome.md';
import settingsOrchestrators from './content/settings-orchestrators.md';
import pluginsOverview from './content/plugins-overview.md';
import pluginsPermissions from './content/plugins-permissions.md';
import pluginsCreating from './content/plugins-creating.md';
import settingsThemes from './content/settings-themes.md';
import settingsSound from './content/settings-sound.md';
import settingsNotifications from './content/settings-notifications.md';
import settingsLogging from './content/settings-logging.md';
import troubleshootingCommon from './content/troubleshooting-common.md';
import troubleshootingSafeMode from './content/troubleshooting-safe-mode.md';
import gettingStartedChrome from './content/general-getting-started.chrome.md';
import navigationChrome from './content/general-navigation.chrome.md';
import keyboardShortcutsChrome from './content/general-keyboard-shortcuts.chrome.md';
import projectsOverviewChrome from './content/projects-overview.chrome.md';
import projectsSettingsChrome from './content/projects-settings.chrome.md';
import agentsOverviewChrome from './content/agents-overview.chrome.md';
import agentsDurableChrome from './content/agents-durable.chrome.md';
import agentsQuickChrome from './content/agents-quick.chrome.md';
import agentsTerminalChrome from './content/agents-terminal.chrome.md';
import pluginsOverviewChrome from './content/plugins-overview.chrome.md';
import pluginsPermissionsChrome from './content/plugins-permissions.chrome.md';
import pluginsCreatingChrome from './content/plugins-creating.chrome.md';
import settingsThemesChrome from './content/settings-themes.chrome.md';
import settingsSoundChrome from './content/settings-sound.chrome.md';
import settingsNotificationsChrome from './content/settings-notifications.chrome.md';
import settingsAnnexChrome from './content/settings-annex.chrome.md';
import troubleshootingCommonChrome from './content/troubleshooting-common.chrome.md';
import troubleshootingSafeModeChrome from './content/troubleshooting-safe-mode.chrome.md';
import { isNewChromeEnabled } from '../../chrome/chromeFlag';

export interface HelpTopic {
  id: string;
  title: string;
  content: string;
}

export interface HelpSection {
  id: string;
  title: string;
  topics: HelpTopic[];
}

/** The classic layout's articles. */
export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'general',
    title: 'General',
    topics: [
      { id: 'getting-started', title: 'Getting Started', content: gettingStarted },
      { id: 'command-palette', title: 'Command Palette', content: commandPalette },
      { id: 'navigation', title: 'Navigation & Layout', content: navigation },
      { id: 'keyboard-shortcuts', title: 'Keyboard Shortcuts', content: keyboardShortcuts },
      { id: 'updates', title: 'Updates', content: updates },
    ],
  },
  {
    id: 'projects',
    title: 'Projects',
    topics: [
      { id: 'projects-overview', title: 'Managing Projects', content: projectsOverview },
      { id: 'projects-git', title: 'Git Integration', content: projectsGit },
      { id: 'projects-settings', title: 'Project Settings', content: projectsSettings },
    ],
  },
  {
    id: 'agents',
    title: 'Agents & Orchestrators',
    topics: [
      { id: 'agents-overview', title: 'Agent Overview', content: agentsOverview },
      { id: 'agents-durable', title: 'Durable Agents', content: agentsDurable },
      { id: 'agents-quick', title: 'Quick Agents', content: agentsQuick },
      { id: 'agents-terminal', title: 'CLI & Transcripts', content: agentsTerminal },
      { id: 'agents-orchestrated-helpers', title: 'Orchestrated Helpers', content: agentsOrchestratedHelpers },
      { id: 'agents-actions', title: 'Actions', content: agentsActions },
      { id: 'agents-handoffs', title: 'Handoffs', content: agentsHandoffs },
      { id: 'orchestrators', title: 'Agent providers', content: settingsOrchestrators },
    ],
  },
  {
    id: 'plugins',
    title: 'Plugins',
    topics: [
      { id: 'plugins-overview', title: 'Installing & Using Plugins', content: pluginsOverview },
      { id: 'plugins-permissions', title: 'Plugin Permissions', content: pluginsPermissions },
      { id: 'plugins-creating', title: 'Creating Plugins', content: pluginsCreating },
    ],
  },
  {
    id: 'settings',
    title: 'Settings',
    topics: [
      { id: 'settings-themes', title: 'Display & Themes', content: settingsThemes },
      { id: 'settings-sound', title: 'Sound & Audio', content: settingsSound },
      { id: 'settings-notifications', title: 'Notifications & Badges', content: settingsNotifications },
      // Annex help topics are gated behind the experimental flag (visible only when opted in)
      { id: 'settings-logging', title: 'Logging & Diagnostics', content: settingsLogging },
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    topics: [
      { id: 'troubleshooting-common', title: 'Common Issues', content: troubleshootingCommon },
      { id: 'troubleshooting-safe-mode', title: 'Safe Mode & Recovery', content: troubleshootingSafeMode },
    ],
  },
];

/**
 * The new shell's articles (#2017, decided 2026-10-17): one version per shell.
 * Articles that describe the layout are rewritten for the sidebar and title
 * bar and titles are sentence case. Topic ids
 * match the classic set so links and saved selections carry over.
 */
export const CHROME_HELP_SECTIONS: HelpSection[] = [
  {
    id: 'general',
    title: 'General',
    topics: [
      { id: 'getting-started', title: 'Getting started', content: gettingStartedChrome },
      { id: 'command-palette', title: 'Command palette', content: commandPalette },
      { id: 'navigation', title: 'Navigation and layout', content: navigationChrome },
      { id: 'keyboard-shortcuts', title: 'Keyboard shortcuts', content: keyboardShortcutsChrome },
      { id: 'updates', title: 'Updates', content: updates },
    ],
  },
  {
    id: 'projects',
    title: 'Projects',
    topics: [
      { id: 'projects-overview', title: 'Managing projects', content: projectsOverviewChrome },
      { id: 'projects-git', title: 'Git', content: projectsGit },
      { id: 'projects-settings', title: 'Project settings', content: projectsSettingsChrome },
    ],
  },
  {
    id: 'agents',
    title: 'Agents and orchestrators',
    topics: [
      { id: 'agents-overview', title: 'Agents', content: agentsOverviewChrome },
      { id: 'agents-durable', title: 'Durable agents', content: agentsDurableChrome },
      { id: 'agents-quick', title: 'Quick agents', content: agentsQuickChrome },
      { id: 'agents-terminal', title: 'CLI and transcripts', content: agentsTerminalChrome },
      { id: 'agents-orchestrated-helpers', title: 'Orchestrated helpers', content: agentsOrchestratedHelpers },
      { id: 'agents-actions', title: 'Actions', content: agentsActions },
      { id: 'agents-handoffs', title: 'Handoffs', content: agentsHandoffs },
      { id: 'orchestrators', title: 'Agent providers', content: settingsOrchestrators },
    ],
  },
  {
    id: 'plugins',
    title: 'Plugins',
    topics: [
      { id: 'plugins-overview', title: 'Installing and using plugins', content: pluginsOverviewChrome },
      { id: 'plugins-permissions', title: 'Plugin permissions', content: pluginsPermissionsChrome },
      { id: 'plugins-creating', title: 'Creating plugins', content: pluginsCreatingChrome },
    ],
  },
  {
    id: 'settings',
    title: 'Settings',
    topics: [
      { id: 'settings-themes', title: 'Display and themes', content: settingsThemesChrome },
      { id: 'settings-sound', title: 'Sound', content: settingsSoundChrome },
      { id: 'settings-notifications', title: 'Notifications and badges', content: settingsNotificationsChrome },
      { id: 'settings-logging', title: 'Logging and diagnostics', content: settingsLogging },
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    topics: [
      { id: 'troubleshooting-common', title: 'Common issues', content: troubleshootingCommonChrome },
      { id: 'troubleshooting-safe-mode', title: 'Safe mode and recovery', content: troubleshootingSafeModeChrome },
    ],
  },
];

/** Annex has no classic article, so the new shell adds it to Settings. Annex is stable, so every build lists it (#2811). */
const ANNEX_TOPIC: HelpTopic = { id: 'settings-annex', title: 'Annex', content: settingsAnnexChrome };
/** The Dispatcher is in the new layout only (#3053), so only the new shell lists it, after Orchestrated helpers. */
export const DISPATCHER_TOPIC: HelpTopic = { id: 'agents-dispatcher', title: 'Dispatcher', content: agentsDispatcherChrome };
export const GROUP_PROJECT_TOPICS: HelpTopic[] = [
  { id: 'group-projects', title: 'Group projects', content: groupProjects },
  { id: 'group-project-glossary', title: 'Group project glossary', content: groupProjectGlossary },
];
const CHROME_SECTIONS_WITH_ANNEX: HelpSection[] = CHROME_HELP_SECTIONS.map((s) => {
  if (s.id === 'settings') return { ...s, topics: [...s.topics.slice(0, 3), ANNEX_TOPIC, ...s.topics.slice(3)] };
  if (s.id === 'agents') {
    const at = s.topics.findIndex((t) => t.id === 'agents-orchestrated-helpers') + 1;
    return { ...s, topics: [...s.topics.slice(0, at), DISPATCHER_TOPIC, ...GROUP_PROJECT_TOPICS, ...s.topics.slice(at)] };
  }
  return s;
});

/** The active shell's built-in sections. */
export function getHelpSections(): HelpSection[] {
  return isNewChromeEnabled() ? CHROME_SECTIONS_WITH_ANNEX : HELP_SECTIONS;
}
