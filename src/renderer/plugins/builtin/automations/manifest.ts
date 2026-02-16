import type { PluginManifest } from '../../../../shared/plugin-types';

const CLOCK_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;

export const manifest: PluginManifest = {
  id: 'automations',
  name: 'Automations',
  version: '0.1.0',
  description: 'Schedule recurring quick-agent tasks with cron expressions.',
  author: 'Clubhouse',
  engine: { api: 0.2 },
  scope: 'project',
  contributes: {
    tab: { label: 'Automations', icon: CLOCK_ICON, layout: 'full' },
    commands: [{ id: 'create', title: 'Create Automation' }],
  },
};
