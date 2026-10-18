import type { PluginManifest } from '../../../../shared/plugin-types';

// Rail icon: stack of cards with top one tilted 45deg and a right arrow
const STACK_SWIPE_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="12" height="14" rx="2"/><rect x="6" y="4" width="12" height="14" rx="2" transform="rotate(12 12 11)"/><path d="M19 12l3 0m0 0l-2-2m2 2l-2 2"/></svg>`;

// In-project tab icon: same concept, slightly different
const TAB_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="12" height="14" rx="2"/><rect x="6" y="4" width="12" height="14" rx="2" transform="rotate(12 12 11)"/><path d="M19 12l3 0m0 0l-2-2m2 2l-2 2"/></svg>`;

export const manifest: PluginManifest = {
  id: 'review',
  name: 'Review',
  version: '1.0.0',
  description: 'Step through your agents one at a time, in one project or across all of them.',
  author: 'Clubhouse',
  engine: { api: 0.8 },
  scope: 'dual',
  permissions: ['commands', 'agents', 'projects', 'widgets', 'navigation'],
  contributes: {
    tab: { label: 'Review', title: 'Review', icon: TAB_ICON, layout: 'full' },
    railItem: { label: 'Review', title: 'Review', icon: STACK_SWIPE_ICON, position: 'top' },
    commands: [
      { id: 'review-prev', title: 'Previous Agent', defaultBinding: 'Meta+ArrowLeft', global: true },
      { id: 'review-next', title: 'Next Agent', defaultBinding: 'Meta+ArrowRight', global: true },
    ],
    settings: [
      {
        key: 'include-sleeping',
        type: 'boolean',
        label: 'Include sleeping agents',
        description: 'Show sleeping agents in Review.',
        default: true,
      },
      {
        key: 'needs-attention-only',
        type: 'boolean',
        label: 'Needs you only',
        description: 'Show only agents waiting on you: permission requests and errors.',
        default: false,
      },
      {
        key: 'include-remote',
        type: 'boolean',
        label: 'Include remote agents',
        description: 'Include agents running on paired hosts.',
        default: true,
      },
    ],
    help: {
      topics: [
        {
          id: 'review-carousel',
          title: 'Reviewing agents',
          content: [
            '## Reviewing agents',
            '',
            'Review shows one agent at a time, with a toolbar at the top and the keys you can press along the bottom.',
            '',
            '### Keys',
            '- **Left / Right** or **J / K** move between agents.',
            '- **1** to **9** jump to an agent, and **G** opens the jump list.',
            '- **S** puts the agent to sleep, and **W** wakes a sleeping one.',
            '- **Return** hands the keyboard to the agent. **Cmd+Left** and **Cmd+Right** move on and go back to browsing, from anywhere in the app.',
            '',
            '### Filters',
            '- **Needs you only** shows agents waiting on you. Opening Review from Needs you turns it on for that visit only.',
            '- **Sleeping** and **Remote** include sleeping agents and agents on paired hosts.',
            '',
            '### Sleeping agents',
            'A sleeping agent shows what its last session did. Type what it should do next and press Wake, or Skip to move on.',
          ].join('\n'),
        },
      ],
    },
  },
  settingsPanel: 'declarative',
};
