import { GitSidebar } from '../features/git/GitSidebar';
import { GitMainView } from '../features/git/GitMainView';
import { PluginDefinition } from './types';

export const gitPlugin: PluginDefinition = {
  id: 'git',
  label: 'Git',
  icon: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </svg>
  ),
  SidebarPanel: GitSidebar,
  MainPanel: GitMainView,
};
