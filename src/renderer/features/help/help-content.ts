import gettingStarted from './content/general-getting-started.md';
import navigation from './content/general-navigation.md';
import projectsOverview from './content/projects-overview.md';
import projectsGit from './content/projects-git.md';
import agentsOverview from './content/agents-overview.md';
import agentsOrchestrators from './content/agents-orchestrators.md';
import agentsPlugins from './content/agents-plugins.md';

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
      { id: 'navigation', title: 'Navigation', content: navigation },
    ],
  },
  {
    id: 'projects',
    title: 'Projects',
    topics: [
      { id: 'projects-overview', title: 'Overview', content: projectsOverview },
      { id: 'projects-git', title: 'Git Integration', content: projectsGit },
    ],
  },
  {
    id: 'agents',
    title: 'Agents & Plugins',
    topics: [
      { id: 'agents-overview', title: 'Agents', content: agentsOverview },
      { id: 'agents-orchestrators', title: 'Orchestrators', content: agentsOrchestrators },
      { id: 'agents-plugins', title: 'Plugins', content: agentsPlugins },
    ],
  },
];
