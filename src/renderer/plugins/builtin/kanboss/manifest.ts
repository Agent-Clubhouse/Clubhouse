import type { PluginManifest } from '../../../../shared/plugin-types';

const KANBAN_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/><line x1="3" y1="9" x2="9" y2="9"/><line x1="15" y1="9" x2="21" y2="9"/></svg>`;

export const manifest: PluginManifest = {
  id: 'kanboss',
  name: 'KanBoss',
  version: '1.0.0',
  description: 'Kanban boards with AI-powered automation.',
  author: 'Clubhouse',
  engine: { api: 0.5 },
  scope: 'project',
  permissions: ['storage', 'agents', 'commands', 'notifications', 'navigation', 'widgets'],
  contributes: {
    tab: { label: 'KanBoss', icon: KANBAN_SVG, layout: 'sidebar-content' },
    commands: [
      { id: 'refresh', title: 'Refresh Boards' },
      { id: 'new-board', title: 'Create New Board' },
    ],
    help: {
      topics: [
        {
          id: 'kanboss',
          title: 'KanBoss',
          content: [
            '## KanBoss',
            '',
            'Project-scoped Kanban boards with AI-powered automation.',
            '',
            '### Creating a board',
            'Click **+ New** in the sidebar to create a board. Each board starts with three states (Todo, In Progress, Done) and a Default swimlane.',
            '',
            '### Cards',
            'Cards live at the intersection of a state (column) and swimlane (row). Click **+ Add** in any cell to create a card. Cards can be moved between states using the move dropdown.',
            '',
            '### Automation',
            'Mark a state as **Automatic** and provide an automation prompt. When a card enters that state in a swimlane with an assigned durable agent, a quick agent is spawned to complete the task. An evaluation agent then checks the outcome.',
            '',
            '### Priority levels',
            'Cards support five priority levels: None, Low, Medium, High, and Critical. Priority badges are color-coded for quick scanning.',
            '',
            '### Zoom',
            'Use the zoom controls in the toolbar to scale the board view between 50% and 200%.',
          ].join('\n'),
        },
        {
          id: 'kanboss-automation',
          title: 'KanBoss Automation',
          content: [
            '## KanBoss Automation',
            '',
            'Automation connects the Kanban workflow to AI agents.',
            '',
            '### Setup',
            '1. Open board settings (gear icon)',
            '2. Assign a durable agent as **manager** for a swimlane',
            '3. Mark a state as **Automatic** and write an automation prompt',
            '4. Set **Max Retries** (default: 3)',
            '',
            '### Flow',
            '1. Card enters an automatic state in a managed swimlane',
            '2. A quick agent executes the automation prompt',
            '3. An evaluation agent checks if the outcome was met',
            '4. On success: card advances to the next state',
            '5. On failure: card retries (up to max retries)',
            '6. If retries exhausted: card is marked **stuck**',
          ].join('\n'),
        },
      ],
    },
  },
};
