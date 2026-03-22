import type { PluginManifest } from '../../../../shared/plugin-types';

const SESSIONS_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;

export const manifest: PluginManifest = {
  id: 'sessions',
  name: 'Sessions',
  version: '1.0.0',
  description: 'Browse and replay historical agent conversation sessions.',
  author: 'Clubhouse',
  engine: { api: 0.8 },
  scope: 'project',
  permissions: ['agents', 'commands', 'widgets'],
  contributes: {
    tab: { label: 'Sessions', title: 'Sessions', icon: SESSIONS_ICON, layout: 'sidebar-content' },
    commands: [],
    help: {
      topics: [
        {
          id: 'session-viewer',
          title: 'Session Viewer',
          content: [
            '## Session Viewer',
            '',
            'The Sessions tab lets you browse historical agent conversation sessions.',
            '',
            '### Browsing sessions',
            'Expand any agent in the sidebar to see its session history. Click a session to view its details.',
            '',
            '### Session details',
            'The detail view shows summary statistics (duration, cost, tokens, files modified), a timeline scrubber, and a scrollable event list.',
            '',
            '### Timeline playback',
            'Use the Play button to step through events at 1x, 3x, or 5x speed. Click any event or drag the timeline thumb to jump to a specific point.',
          ].join('\n'),
        },
      ],
    },
  },
};
