import type { PluginManifest } from '../../../../shared/plugin-types';

const GROUP_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;

export const manifest: PluginManifest = {
  id: 'group-project',
  name: 'Group Project',
  version: '0.1.0',
  description: 'Shared coordination space for multi-agent collaboration via bulletin boards.',
  author: 'Clubhouse',
  engine: { api: 0.8 },
  scope: 'dual',
  permissions: ['canvas', 'widgets', 'storage', 'annex'],
  contributes: {
    canvasWidgets: [
      {
        id: 'group-project-card',
        label: 'Group Project',
        icon: GROUP_ICON,
        defaultSize: { width: 320, height: 240 },
        metadataKeys: ['groupProjectId', 'name', 'description', 'instructions'],
      },
    ],
  },
  settingsPanel: 'declarative',
};
