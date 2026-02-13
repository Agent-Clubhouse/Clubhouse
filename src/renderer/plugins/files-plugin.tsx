import { FileTree } from '../features/files/FileTree';
import { FileViewer } from '../features/files/FileViewer';
import { PluginDefinition } from './types';

export const filesPlugin: PluginDefinition = {
  id: 'files',
  label: 'Files',
  icon: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  ),
  SidebarPanel: FileTree,
  MainPanel: FileViewer,
};
