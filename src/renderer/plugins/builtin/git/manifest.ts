import type { PluginManifest } from '../../../../shared/plugin-types';

const GIT_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`;

export const manifest: PluginManifest = {
  id: 'git',
  name: 'Git',
  version: '1.0.0',
  description: 'Git status, staging, commits, branches, and history.',
  author: 'Clubhouse',
  engine: { api: 0.8 },
  scope: 'project',
  permissions: ['git', 'files', 'commands', 'notifications', 'storage', 'canvas', 'projects'],
  contributes: {
    tab: { label: 'Git', title: 'Git', icon: GIT_ICON, layout: 'sidebar-content' },
    commands: [{ id: 'refresh', title: 'Refresh Git Status', defaultBinding: 'Meta+Shift+G' }],
    canvasWidgets: [
      {
        id: 'git-status',
        label: 'Git Diff',
        icon: GIT_ICON,
        defaultSize: { width: 700, height: 500 },
        metadataKeys: ['projectId', 'worktreePath'],
      },
    ],
    help: {
      topics: [
        {
          id: 'git-overview',
          title: 'Git Integration',
          content: [
            '## Git Integration',
            '',
            'The Git tab provides a full git interface for your project.',
            '',
            '### Working changes',
            'View staged, unstaged, and untracked files. Right-click for stage/unstage/discard actions.',
            '',
            '### Commit',
            'Stage files and write a commit message to commit directly from the sidebar.',
            '',
            '### Branches',
            'Switch between branches or create new ones.',
            '',
            '### History',
            'Browse commit log with file-level diffs for each commit.',
            '',
            '### Keyboard shortcuts',
            '- **Cmd+Shift+G** — Refresh git status',
          ].join('\n'),
        },
      ],
    },
  },
};
