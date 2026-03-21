import type { PluginManifest } from '../../../../shared/plugin-types';

const GROUP_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="7" height="8" rx="1"/><rect x="14" y="11" width="7" height="8" rx="1"/><circle cx="5" cy="14" r="1" fill="currentColor"/><circle cx="8" cy="14" r="1" fill="currentColor"/><circle cx="16" cy="14" r="1" fill="currentColor"/><circle cx="19" cy="14" r="1" fill="currentColor"/><line x1="6.5" y1="11" x2="6.5" y2="8"/><line x1="17.5" y1="11" x2="17.5" y2="8"/><rect x="4" y="3" width="16" height="5" rx="1"/><line x1="8" y1="5.5" x2="16" y2="5.5"/></svg>`;

export const manifest: PluginManifest = {
  id: 'group-project',
  name: 'Group Project',
  version: '0.1.0',
  description: 'Shared coordination space for multi-agent collaboration via bulletin boards.',
  author: 'Clubhouse',
  engine: { api: 0.8 },
  scope: 'dual',
  permissions: ['canvas', 'widgets', 'storage'],
  contributes: {
    canvasWidgets: [
      {
        id: 'group-project',
        label: 'Group Project',
        icon: GROUP_ICON,
        defaultSize: { width: 320, height: 240 },
        metadataKeys: ['groupProjectId', 'name', 'description', 'instructions'],
      },
    ],
  },
  settingsPanel: 'declarative',
};
