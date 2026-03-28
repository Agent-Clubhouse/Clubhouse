import type { PluginManifest } from '../../../../shared/plugin-types';

// Tab icon: 4-directional move/pan icon
const CANVAS_TAB_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>`;

// Rail icon: same move icon for the sidebar rail
const CANVAS_RAIL_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>`;

export const manifest: PluginManifest = {
  id: 'canvas',
  name: 'Canvas',
  version: '0.1.0',
  description: 'Free-form spatial workspace for arranging agent views, file views, and browser views.',
  author: 'Clubhouse',
  engine: { api: 0.9 },
  scope: 'dual',
  permissions: ['commands', 'storage', 'agents', 'projects', 'widgets', 'navigation', 'files', 'git', 'terminal', 'annex'],
  contributes: {
    tab: { label: 'Canvas', title: 'Canvas', icon: CANVAS_TAB_ICON, layout: 'full' },
    railItem: { label: 'Canvas', title: 'Canvas', icon: CANVAS_RAIL_ICON, position: 'top' },
    commands: [
      { id: 'add-agent-view', title: 'Add Agent View' },
      { id: 'add-file-view', title: 'Add File View' },
      { id: 'add-git-diff-view', title: 'Add Git Diff View' },
      { id: 'add-terminal-view', title: 'Add Terminal View' },
      { id: 'reset-viewport', title: 'Reset Canvas Viewport', defaultBinding: 'Meta+Shift+0' },
    ],
    storage: { scope: 'project-local' },
    settings: [
      {
        key: 'cross-project-canvas',
        type: 'boolean',
        label: 'Cross-Project Canvas',
        description: 'Show the cross-project canvas in the sidebar rail for managing views across all projects.',
        default: true,
      },
      {
        key: 'bidirectional-wires',
        type: 'boolean',
        label: 'Bidirectional Wires',
        description: 'Render all agent-to-agent wires as bidirectional by default, even when only one direction is bound.',
        default: false,
      },
    ],
    help: {
      topics: [
        {
          id: 'canvas-workspace',
          title: 'Canvas Workspace',
          content: [
            '## Canvas Workspace',
            '',
            'The Canvas provides a free-form spatial workspace for arranging views.',
            '',
            '### View types',
            '- **Agent View** — Shows an agent terminal or sleeping widget.',
            '- **File View** — Browse and read project files.',
            '- **Browser View** — A sandboxed web browser.',
            '- **Git Diff View** — View changed files and diffs across projects and worktrees.',
            '- **Terminal View** — Open a shell in any project root or git worktree.',
            '',
            '### Navigation',
            '- **Pan** — Click and drag on empty space, or use two-finger scroll.',
            '- **Zoom** — Ctrl+scroll (mouse) or pinch (trackpad), or use the zoom buttons.',
            '- **Right-click** — Open the context menu to create new views.',
            '',
            '### Views',
            'Drag a view\'s title bar to move it. Drag the bottom-right corner to resize.',
            'Click a view to bring it to front. Click the X button to close it.',
            '',
            '### Multiple canvases',
            'Use the tab bar to create, rename, and switch between multiple canvas workspaces.',
            '',
            '### State persistence',
            'Your views, positions, zoom level, and canvas tabs are saved automatically.',
          ].join('\n'),
        },
      ],
    },
  },
  settingsPanel: 'declarative',
};
