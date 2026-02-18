import type { PluginManifest } from '../../../../shared/plugin-types';

const BOOK_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;

export const manifest: PluginManifest = {
  id: 'wiki',
  name: 'Wiki',
  version: '1.0.0',
  description: 'Browse and edit markdown wikis stored in external directories.',
  author: 'Clubhouse',
  engine: { api: 0.5 },
  scope: 'project',
  permissions: ['files', 'files.external', 'commands', 'notifications', 'agents', 'navigation', 'storage', 'widgets'],
  externalRoots: [{ settingKey: 'wikiPath', root: 'wiki' }],
  contributes: {
    tab: { label: 'Wiki', icon: BOOK_ICON, layout: 'sidebar-content' },
    commands: [{ id: 'refresh', title: 'Refresh Wiki Tree' }],
    settings: [
      {
        key: 'wikiPath',
        type: 'directory',
        label: 'Wiki path',
        description: 'Path to the wiki directory. Use Browse to pick a folder, or type a path (relative paths resolve against the project root).',
        default: '',
      },
      {
        key: 'wikiStyle',
        type: 'select',
        label: 'Wiki format',
        description: 'Choose the wiki format. GitHub uses [[wiki links]] and alphabetical ordering. ADO (Azure DevOps) uses .order files and standard markdown links with dashes for spaces.',
        default: 'github',
        options: [
          { label: 'GitHub', value: 'github' },
          { label: 'ADO (Azure DevOps)', value: 'ado' },
        ],
      },
      {
        key: 'showHiddenFiles',
        type: 'boolean',
        label: 'Show hidden files',
        description: 'Display files and directories starting with a dot.',
        default: false,
      },
    ],
    help: {
      topics: [
        {
          id: 'wiki-browser',
          title: 'Wiki Browser',
          content: [
            '## Wiki Browser',
            '',
            'The Wiki tab lets you browse and edit markdown wikis stored outside the project.',
            '',
            '### View mode',
            '- Renders `.md` files with syntax-highlighted preview',
            '- File names are prettified (dashes/underscores become spaces, title-cased)',
            '- Only markdown files are shown in the tree',
            '',
            '### Edit mode',
            '- Full file explorer with all files visible',
            '- Monaco editor with Cmd+S / Ctrl+S to save',
            '- Right-click for file operations (create, rename, copy, delete)',
            '',
            '### Agent integration',
            '- **Run Agent in Wiki** button spawns a quick agent with wiki context',
            '- **Send to Agent** sends the current page to a quick or durable agent',
            '',
            '### Settings',
            '- **Wiki path** \u2014 Set the absolute path to your wiki directory',
            '- **Wiki format** \u2014 Choose GitHub or ADO (Azure DevOps) wiki format',
            '- **Show hidden files** \u2014 Toggle visibility of dotfiles (edit mode only)',
            '',
            '### ADO Wiki support',
            '- Respects `.order` files for page ordering',
            '- Standard markdown links navigate within the wiki',
            '- Folder index pages (same-named `.md` file) shown as folder content',
          ].join('\n'),
        },
      ],
    },
  },
  settingsPanel: 'declarative',
};
