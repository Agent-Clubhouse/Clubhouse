import type { PluginManifest } from '../../../../shared/plugin-types';

const TERMINAL_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;

export const manifest: PluginManifest = {
  id: 'terminal',
  name: 'Terminal',
  version: '0.1.0',
  description: 'Interactive shell terminal scoped to each project.',
  author: 'Clubhouse',
  engine: { api: 0.2 },
  scope: 'project',
  contributes: {
    tab: { label: 'Terminal', icon: TERMINAL_ICON, layout: 'full' },
    commands: [{ id: 'restart', title: 'Restart Terminal' }],
  },
};
