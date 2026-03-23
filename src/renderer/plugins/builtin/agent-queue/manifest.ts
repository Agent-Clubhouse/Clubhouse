import type { PluginManifest } from '../../../../shared/plugin-types';

const QUEUE_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="7" y1="16" x2="13" y2="16"/><circle cx="4.5" cy="8" r="0.5" fill="currentColor"/><circle cx="4.5" cy="12" r="0.5" fill="currentColor"/><circle cx="4.5" cy="16" r="0.5" fill="currentColor"/></svg>`;

export const manifest: PluginManifest = {
  id: 'agent-queue',
  name: 'Agent Queue',
  version: '0.1.0',
  description: 'Task queue that spawns quick agents to execute missions with structured output.',
  author: 'Clubhouse',
  engine: { api: 0.8 },
  scope: 'dual',
  permissions: ['canvas', 'widgets', 'storage'],
  contributes: {
    canvasWidgets: [
      {
        id: 'agent-queue',
        label: 'Agent Queue',
        icon: QUEUE_ICON,
        defaultSize: { width: 360, height: 280 },
        metadataKeys: ['queueId', 'name', 'concurrency', 'projectId', 'projectPath', 'model', 'orchestrator', 'freeAgentMode', 'autoWorktree'],
      },
    ],
  },
};
