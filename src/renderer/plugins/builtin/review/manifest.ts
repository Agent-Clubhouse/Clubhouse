import type { PluginManifest } from '../../../../shared/plugin-types';

// Rail icon: stack of cards with top one tilted 45deg and a right arrow
const STACK_SWIPE_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="12" height="14" rx="2"/><rect x="6" y="4" width="12" height="14" rx="2" transform="rotate(12 12 11)"/><path d="M19 12l3 0m0 0l-2-2m2 2l-2 2"/></svg>`;

// In-project tab icon: same concept, slightly different
const TAB_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="6" width="12" height="14" rx="2"/><rect x="6" y="4" width="12" height="14" rx="2" transform="rotate(12 12 11)"/><path d="M19 12l3 0m0 0l-2-2m2 2l-2 2"/></svg>`;

export const manifest: PluginManifest = {
  id: 'review',
  name: 'Review',
  version: '1.0.0',
  description: 'Swipe between agents in a full-screen carousel — per-project or across all projects.',
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
        label: 'Include Sleeping Agents',
        description: 'Show sleeping agents in the review carousel.',
        default: true,
      },
    ],
    help: {
      topics: [
        {
          id: 'review-carousel',
          title: 'Agent Review Carousel',
          content: [
            '## Agent Review Carousel',
            '',
            'The Review plugin provides a full-screen, swipe-like carousel for browsing agents one at a time.',
            '',
            '### Navigation',
            '- Click the **left/right arrows** on the edges of the screen to move between agents.',
            '- Use **Cmd+Left** / **Cmd+Right** keyboard shortcuts for quick navigation.',
            '- Use the arrows in the **floating bar** at the top center.',
            '',
            '### Modes',
            '- **Per-project** — The tab shows only agents belonging to the current project.',
            '- **Cross-project** — The sidebar rail entry shows all agents across every project.',
            '',
            '### Sleeping agents',
            'Toggle the **Include sleeping** checkbox in the floating bar to show or hide sleeping agents in the carousel.',
          ].join('\n'),
        },
      ],
    },
  },
  settingsPanel: 'declarative',
};
