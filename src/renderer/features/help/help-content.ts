import gettingStarted from './content/general-getting-started.md';
import dashboard from './content/general-dashboard.md';
import commandPalette from './content/general-command-palette.md';
import hub from './content/general-hub.md';
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
import personaProjectManager from '../assistant/content/personas/project-manager.md';
import personaQa from '../assistant/content/personas/qa.md';
import personaUiLead from '../assistant/content/personas/ui-lead.md';
import personaQualityAuditor from '../assistant/content/personas/quality-auditor.md';
import personaExecutorPrOnly from '../assistant/content/personas/executor-pr-only.md';
import personaExecutorMerge from '../assistant/content/personas/executor-merge.md';
import personaDocUpdater from '../assistant/content/personas/doc-updater.md';
import cookbookLongRunningJob from '../assistant/content/cookbooks/long-running-job.md';
import cookbookUiWork from '../assistant/content/cookbooks/ui-work.md';
import cookbookGroupProject from '../assistant/content/cookbooks/group-project.md';
import cookbookSquad from '../assistant/content/cookbooks/squad.md';
import cookbookBakeOff from '../assistant/content/cookbooks/bake-off.md';

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

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'general',
    title: 'General',
    topics: [
      { id: 'getting-started', title: 'Getting Started', content: gettingStarted },
      { id: 'dashboard', title: 'Dashboard', content: dashboard },
      { id: 'command-palette', title: 'Command Palette', content: commandPalette },
      { id: 'hub', title: 'Hub & Workspaces', content: hub },
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
      { id: 'persona-project-manager', title: 'Project Manager / Coordinator', content: personaProjectManager },
      { id: 'persona-qa', title: 'QA / Quality Control', content: personaQa },
      { id: 'persona-ui-lead', title: 'UI / Design Lead', content: personaUiLead },
      { id: 'persona-quality-auditor', title: 'Quality Auditor', content: personaQualityAuditor },
      { id: 'persona-executor-pr-only', title: 'Executor (PR Only)', content: personaExecutorPrOnly },
      { id: 'persona-executor-merge', title: 'Executor (Full Merge)', content: personaExecutorMerge },
      { id: 'persona-doc-updater', title: 'Documentation Updater', content: personaDocUpdater },
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
