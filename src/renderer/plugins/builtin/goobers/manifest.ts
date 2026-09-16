import type { PluginManifest } from '../../../../shared/plugin-types';

// Rail icon: a small grid of three squares suggesting gaggles/runs.
const GOOBERS_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/></svg>`;

export const manifest: PluginManifest = {
  id: 'goobers',
  name: 'Goobers',
  version: '1.0.0',
  description: 'Monitor and control the local Goobers instance — gaggles, runs, and daemon health.',
  author: 'Clubhouse',
  engine: { api: 0.8 },
  scope: 'app',
  // Phase 1 set — minimal and exact. `badges` + `notifications` are added in
  // Phase 2 when the rail badge (spec §8.3) lands, not before (D26).
  permissions: ['storage', 'commands', 'logging', 'navigation'],
  contributes: {
    railItem: { label: 'Goobers', title: 'Goobers', icon: GOOBERS_ICON, position: 'top' },
    commands: [
      { id: 'goobers.open', title: 'Goobers: Open panel' },
      { id: 'goobers.refresh', title: 'Goobers: Refresh now' },
      { id: 'goobers.start', title: 'Goobers: Start daemon' },
      { id: 'goobers.stop', title: 'Goobers: Stop daemon' },
    ],
    help: {
      topics: [
        {
          id: 'goobers-overview',
          title: 'What is Goobers?',
          content: [
            '## What is Goobers?',
            '',
            'Goobers is a locally-running daemon that schedules and runs automated workflows',
            '("gaggles") against your repositories — opening pull requests, running checks,',
            'and reacting to backlog items on a schedule or on demand.',
            '',
            'This panel monitors and controls a Goobers *instance* — a directory on disk',
            'that holds the daemon\'s configuration and state (`instance.yaml`, a durable',
            'root identity, and the scheduler\'s working files). It shows whether the',
            'daemon is running, what runs are currently active, and lets you start or',
            'stop the daemon if you have enabled daemon control.',
            '',
            'This is a machine-level integration, not a per-project one — the same',
            'Goobers instance can serve runs across multiple gaggles and repositories,',
            'which is why this panel lives on the app rail rather than inside a project.',
          ].join('\n'),
        },
        {
          id: 'goobers-setup',
          title: 'Pointing Clubhouse at your instance',
          content: [
            '## Pointing Clubhouse at your instance',
            '',
            'Clubhouse identifies a Goobers instance by a single file:',
            '`<root>/instance.yaml`. To connect this panel to your instance, pick the',
            'directory that contains that file — either from the inline picker on this',
            'panel\'s "Not configured" screen, or from **Settings → Goobers**.',
            '',
            'If a root was previously retired, it will have a',
            '`.instance-decommissioned` marker file and Clubhouse will refuse to use it',
            '— point the picker at the current instance root instead.',
            '',
            'You can also set an explicit path to the `goobers` binary if it is not on',
            'your shell PATH. Clubhouse resolves and validates that path once, on',
            'connect and whenever the setting changes.',
          ].join('\n'),
        },
        {
          id: 'goobers-daemon',
          title: 'Starting and stopping the daemon',
          content: [
            '## Starting and stopping the daemon',
            '',
            'By default Clubhouse can *monitor* a Goobers daemon but not control it —',
            'starting and stopping is off by default. This is deliberate: the daemon',
            'inherits your full login-shell environment when Clubhouse starts it, a',
            'stop request can trigger an unbounded drain while in-flight runs finish,',
            'and a daemon Clubhouse starts keeps running after you quit the app.',
            '',
            'To enable daemon control, use the inline "Enable daemon control" prompt on',
            'the "Daemon not running" screen, or the toggle in **Settings → Goobers**',
            '— either surface shows these hazards before turning the setting on.',
            '',
            'Once enabled, Start and Stop controls appear in the panel header. Stopping',
            'shows a "draining" state until the daemon\'s liveness is actually gone —',
            'never a bare "stopped" the moment the process exits.',
          ].join('\n'),
        },
      ],
    },
  },
  settingsPanel: 'declarative',
};
