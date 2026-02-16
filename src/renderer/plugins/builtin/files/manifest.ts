import type { PluginManifest } from '../../../../shared/plugin-types';

const FOLDER_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

export const manifest: PluginManifest = {
  id: 'files',
  name: 'Files',
  version: '0.1.0',
  description: 'Project file browser with Monaco editor, markdown preview, and image display.',
  author: 'Clubhouse',
  engine: { api: 0.5 },
  scope: 'project',
  permissions: ['files', 'git', 'commands', 'notifications'],
  contributes: {
    tab: { label: 'Files', icon: FOLDER_ICON, layout: 'sidebar-content' },
    commands: [{ id: 'refresh', title: 'Refresh File Tree' }],
    settings: [
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
          id: 'file-browser',
          title: 'File Browser',
          content: [
            '## File Browser',
            '',
            'The Files tab provides a project file tree and built-in editor.',
            '',
            '### Supported formats',
            '- **Code files** — Syntax-highlighted editing via Monaco (40+ languages)',
            '- **Markdown** — Preview/Source toggle with syntax-highlighted code blocks',
            '- **SVG** — Preview/Source toggle',
            '- **Images** — Inline display (PNG, JPG, GIF, WebP, ICO, BMP)',
            '',
            '### Keyboard shortcuts',
            '- **Cmd+S / Ctrl+S** — Save the current file',
            '- **Arrow Up/Down** — Navigate the file tree',
            '- **Enter** — Open file or toggle directory',
            '- **Delete/Backspace** — Delete focused file or folder',
            '',
            '### File operations',
            'Right-click a file or folder for options: create, rename, copy, and delete.',
            '',
            '### Settings',
            '- **Show hidden files** — Toggle visibility of dotfiles in the tree.',
          ].join('\n'),
        },
      ],
    },
  },
  settingsPanel: 'declarative',
};
