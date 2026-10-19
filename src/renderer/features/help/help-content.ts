import gettingStarted from './content/general-getting-started.md';
import dashboard from './content/general-dashboard.md';
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
import agentsClubhouseMode from './content/agents-clubhouse-mode.md';
import agentsTerminal from './content/agents-terminal.md';
import agentsOrchestratedHelpers from './content/agents-orchestrated-helpers.md';
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
import personaProjectManager from '../personas/project-manager.md';
import personaQa from '../personas/qa.md';
import personaUiLead from '../personas/ui-lead.md';
import personaQualityAuditor from '../personas/quality-auditor.md';
import personaExecutorPrOnly from '../personas/executor-pr-only.md';
import personaExecutorMerge from '../personas/executor-merge.md';
import personaDocUpdater from '../personas/doc-updater.md';
import personaJudge from '../personas/judge.md';
import personaResearcher from '../personas/researcher.md';
import personaOrchestrator from '../personas/orchestrator.md';
import personaWorkhorse from '../personas/workhorse.md';
import { stripPersonaFrontMatter } from '../../../shared/persona-pattern';
import cookbookLongRunningJob from './content/cookbooks/long-running-job.md';
import cookbookUiWork from './content/cookbooks/ui-work.md';
import cookbookGroupProject from './content/cookbooks/group-project.md';
import cookbookSquad from './content/cookbooks/squad.md';
import cookbookBakeOff from './content/cookbooks/bake-off.md';

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
      { id: 'dashboard', title: 'Dashboard', content: dashboard },
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
      { id: 'agents-clubhouse-mode', title: 'Clubhouse Mode', content: agentsClubhouseMode },
      { id: 'agents-terminal', title: 'Terminal & Transcripts', content: agentsTerminal },
      { id: 'agents-orchestrated-helpers', title: 'Orchestrated Helpers', content: agentsOrchestratedHelpers },
      { id: 'orchestrators', title: 'Orchestrators', content: settingsOrchestrators },
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
  {
    id: 'personas',
    title: 'Agent Personas & Team Roles',
    topics: [
      { id: 'persona-project-manager', title: 'Project Manager', content: personaProjectManager },
      { id: 'persona-qa', title: 'PR Reviewer', content: personaQa },
      { id: 'persona-ui-lead', title: 'Design Lead', content: personaUiLead },
      { id: 'persona-quality-auditor', title: 'AI Slop Detector', content: personaQualityAuditor },
      { id: 'persona-executor-pr-only', title: 'Developer', content: personaExecutorPrOnly },
      { id: 'persona-executor-merge', title: 'Developer (merges)', content: personaExecutorMerge },
      { id: 'persona-doc-updater', title: 'Docs Writer', content: personaDocUpdater },
      { id: 'persona-judge', title: 'Solution Judge', content: personaJudge },
      { id: 'persona-researcher', title: 'Researcher', content: personaResearcher },
      // Persona files can carry settings front-matter; help shows only the body.
      { id: 'persona-orchestrator', title: 'Orchestrator', content: stripPersonaFrontMatter(personaOrchestrator) },
      { id: 'persona-workhorse', title: 'Generalist', content: stripPersonaFrontMatter(personaWorkhorse) },
    ],
  },
  {
    id: 'cookbooks',
    title: 'Cookbooks & Project Patterns',
    topics: [
      { id: 'cookbook-long-running-job', title: 'Long-Running Job', content: cookbookLongRunningJob },
      { id: 'cookbook-ui-work', title: 'UI Work', content: cookbookUiWork },
      { id: 'cookbook-group-project', title: 'Group Project (Multi-App)', content: cookbookGroupProject },
      { id: 'cookbook-squad', title: 'Squad', content: cookbookSquad },
      { id: 'cookbook-bake-off', title: 'Bake-Off (A|B Testing)', content: cookbookBakeOff },
    ],
  },
];

const section = (id: string) => HELP_SECTIONS.find((s) => s.id === id)!;
const retitle = (topics: HelpTopic[], titles: Record<string, string>) => topics.map((t) => ({ ...t, title: titles[t.id] ?? t.title }));

// The new shell titles articles in sentence case (#2017), persona names included.
const PERSONA_TITLES: Record<string, string> = {
  'persona-project-manager': 'Project manager',
  'persona-qa': 'PR reviewer',
  'persona-ui-lead': 'Design lead',
  'persona-quality-auditor': 'AI slop detector',
  'persona-doc-updater': 'Docs writer',
  'persona-judge': 'Solution judge',
};
const COOKBOOK_TITLES: Record<string, string> = {
  'cookbook-long-running-job': 'Long-running job',
  'cookbook-ui-work': 'UI work',
  'cookbook-group-project': 'Group project (multi-app)',
  'cookbook-bake-off': 'Bake-off (A/B testing)',
};

/**
 * The new shell's articles (#2017, decided 2026-10-17): one version per shell.
 * Articles that describe the layout are rewritten for the sidebar and title
 * bar, titles are sentence case, and Dashboard is gone with Home. Topic ids
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
      { id: 'agents-clubhouse-mode', title: 'Clubhouse mode', content: agentsClubhouseMode },
      { id: 'agents-terminal', title: 'Terminal and transcripts', content: agentsTerminalChrome },
      { id: 'agents-orchestrated-helpers', title: 'Orchestrated helpers', content: agentsOrchestratedHelpers },
      { id: 'orchestrators', title: 'Orchestrators', content: settingsOrchestrators },
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
  { ...section('personas'), title: 'Agent personas', topics: retitle(section('personas').topics, PERSONA_TITLES) },
  { ...section('cookbooks'), title: 'Cookbooks', topics: retitle(section('cookbooks').topics, COOKBOOK_TITLES) },
];

/** Annex lives in Settings only on builds that show the Annex pages (preview-eligible). */
const ANNEX_TOPIC: HelpTopic = { id: 'settings-annex', title: 'Annex', content: settingsAnnexChrome };

/** The active shell's built-in sections. */
export function getHelpSections(opts: { annex?: boolean } = {}): HelpSection[] {
  if (!isNewChromeEnabled()) return HELP_SECTIONS;
  if (!opts.annex) return CHROME_HELP_SECTIONS;
  return CHROME_HELP_SECTIONS.map((s) => (s.id === 'settings'
    ? { ...s, topics: [...s.topics.slice(0, 3), ANNEX_TOPIC, ...s.topics.slice(3)] }
    : s));
}
