import type { PluginManifest } from '../../../../shared/plugin-types';

const TERMINAL_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;

export const manifest: PluginManifest = {
  id: 'terminal',
  name: 'Terminal',
  version: '1.0.0',
  description: 'Interactive shell terminal scoped to each project.',
  author: 'Clubhouse',
  engine: { api: 0.5 },
  scope: 'project',
  permissions: ['terminal', 'commands', 'agents'],
  contributes: {
    tab: { label: 'Terminal', icon: TERMINAL_ICON, layout: 'sidebar-content' },
    commands: [{ id: 'restart', title: 'Restart Terminal' }],
    help: {
      topics: [
        {
          id: 'shell-terminal',
          title: 'Shell Terminal',
          content: [
            '## Shell Terminal',
            '',
            'The Terminal tab provides an interactive shell scoped to each project.',
            '',
            '### Session management',
            'Each project gets its own terminal session running in the project directory. Sessions persist while the project is open.',
            '',
            '### Auto-reconnect',
            'If the shell process exits unexpectedly, the terminal will automatically reconnect and start a new session.',
            '',
            '### Restarting',
            'Use the **Restart Terminal** command to kill the current session and start fresh.',
            '',
            '### Status indicators',
            'The terminal tab shows connection status: **running** when connected, **disconnected** when the session has ended.',
          ].join('\n'),
        },
      ],
    },
  },
};
