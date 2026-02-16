import type { PluginManifest } from '../../../../shared/plugin-types';

// Cross-project rail icon: spoke graph — center node with 4 corner nodes
const SPOKE_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="4" cy="4" r="2"/><circle cx="20" cy="4" r="2"/><circle cx="4" cy="20" r="2"/><circle cx="20" cy="20" r="2"/><line x1="9.5" y1="9.5" x2="5.5" y2="5.5"/><line x1="14.5" y1="9.5" x2="18.5" y2="5.5"/><line x1="9.5" y1="14.5" x2="5.5" y2="18.5"/><line x1="14.5" y1="14.5" x2="18.5" y2="18.5"/></svg>`;

// In-project tab icon: grid/dashboard
const GRID_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`;

export const manifest: PluginManifest = {
  id: 'hub',
  name: 'Hub',
  version: '1.0.0',
  description: 'Split-pane workspace for managing agents — per-project or across all projects.',
  author: 'Clubhouse',
  engine: { api: 0.5 },
  scope: 'dual',
  permissions: ['commands', 'storage', 'agents', 'projects', 'widgets', 'navigation', 'notifications'],
  contributes: {
    tab: { label: 'Hub', icon: GRID_ICON, layout: 'full' },
    railItem: { label: 'Hub', icon: SPOKE_ICON, position: 'top' },
    commands: [{ id: 'split-pane', title: 'Split Pane' }],
    storage: { scope: 'global' },
    settings: [
      {
        key: 'cross-project-hub',
        type: 'boolean',
        label: 'Cross-Project Hub',
        description: 'Show the cross-project hub in the sidebar rail for managing agents across all projects.',
        default: true,
      },
    ],
    help: {
      topics: [
        {
          id: 'split-pane-workspace',
          title: 'Split-Pane Workspace',
          content: [
            '## Split-Pane Workspace',
            '',
            'The Hub provides a split-pane workspace for managing agents.',
            '',
            '### Modes',
            '- **Per-project** — Each project has its own Hub tab showing only that project\'s agents.',
            '- **Cross-project** — The sidebar rail entry opens a global Hub spanning all projects.',
            '',
            '### Splitting panes',
            'Use the **Split Pane** command or the toolbar button to divide the workspace. Each pane can host a separate agent session.',
            '',
            '### Assigning agents',
            'Drag an agent into a pane or use the pane\'s dropdown to assign one.',
            '',
            '### Drag-and-drop',
            'Rearrange panes by dragging their title bars. Drop onto edges to create new splits.',
            '',
            '### Pane actions',
            'Right-click a pane title for options: close, maximize, or reset layout.',
            '',
            '### State persistence',
            'Your pane layout and agent assignments are saved automatically and restored on next launch.',
          ].join('\n'),
        },
        {
          id: 'hub-settings',
          title: 'Settings',
          content: [
            '## Settings',
            '',
            '### Cross-Project Hub',
            'Toggle the **Cross-Project Hub** setting to show or hide the global Hub in the sidebar rail. When enabled, the rail icon opens a workspace that spans all projects.',
          ].join('\n'),
        },
      ],
    },
  },
  settingsPanel: 'declarative',
};
