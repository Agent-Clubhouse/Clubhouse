import type { PluginManifest } from '../../../../shared/plugin-types';

const STICKY_NOTE_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8"/><polyline points="14 2 14 8 20 8"/><path d="M20 12v6a2 2 0 0 1-2 2H6"/><line x1="16" y1="17" x2="22" y2="17"/><line x1="19" y1="14" x2="19" y2="20"/></svg>`;

export const manifest: PluginManifest = {
  id: 'sticky-note',
  name: 'Sticky Notes',
  version: '0.1.0',
  description: 'Write and display markdown notes on the canvas.',
  author: 'Clubhouse',
  engine: { api: 0.8 },
  scope: 'project',
  permissions: ['canvas', 'widgets', 'storage', 'theme'],
  contributes: {
    help: {},
    canvasWidgets: [
      {
        id: 'note',
        label: 'Sticky Note',
        icon: STICKY_NOTE_ICON,
        defaultSize: { width: 300, height: 300 },
        metadataKeys: ['content', 'color'],
      },
    ],
    settings: [
      {
        key: 'default-color',
        type: 'select',
        label: 'Default Note Color',
        description: 'Default color for new sticky notes.',
        options: [
          { value: 'yellow', label: 'Yellow' },
          { value: 'blue', label: 'Blue' },
          { value: 'green', label: 'Green' },
          { value: 'pink', label: 'Pink' },
        ],
        default: 'yellow',
      },
    ],
  },
  settingsPanel: 'declarative',
};
