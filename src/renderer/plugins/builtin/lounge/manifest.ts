import type { PluginManifest } from '../../../../shared/plugin-types';

// Lounge rail icon: sofa/couch — a casual gathering spot
const LOUNGE_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11V8a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v3"/><path d="M2 11v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><path d="M6 17v2"/><path d="M18 17v2"/></svg>`;

export const manifest: PluginManifest = {
  id: 'lounge',
  name: 'Lounge',
  version: '1.0.0',
  description: 'Chat-style agent browser — hop between agents organized by project.',
  author: 'Clubhouse',
  engine: { api: 0.6 },
  scope: 'app',
  permissions: ['agents', 'projects', 'navigation', 'widgets', 'commands', 'storage'],
  contributes: {
    railItem: { label: 'Lounge', icon: LOUNGE_ICON, position: 'top' },
    commands: [],
    storage: { scope: 'global' },
    help: {
      topics: [
        {
          id: 'lounge-overview',
          title: 'Lounge',
          content: [
            '## Lounge',
            '',
            'The Lounge provides a chat-style sidebar for quickly browsing and hopping between agents across all projects.',
            '',
            '### Agent list',
            'Agents are grouped into collapsible categories — by default, one per project. Click an agent to focus it.',
            '',
            '### Disambiguation',
            'When multiple agents share a name within the same category, they are shown as **project/agent** to avoid confusion.',
            '',
            '### Navigation',
            'Clicking an agent navigates to it while keeping the Lounge sidebar open for easy switching.',
          ].join('\n'),
        },
      ],
    },
  },
};
