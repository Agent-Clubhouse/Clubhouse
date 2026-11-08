/**
 * Which E2E specs run on the classic layout (#2843).
 *
 * Specs launch on the default (new) layout. The Classic layout E2E job sets
 * CLUBHOUSE_E2E_LAYOUT=classic, which makes launchApp seed `newChrome: false`
 * unless a spec chose a layout itself, and runs only CLASSIC_RUN_SPECS. A spec
 * moved to the new layout stays in that list until its new-layout run is stable
 * on CI, so classic keeps its coverage meanwhile.
 *
 * PINNED_CLASSIC_SPECS are the files that still seed `newChrome: false`, so
 * they run on classic in every job. A shared harness that pins would pin every
 * spec using it. Each one leaves that list when it moves. LAYOUT_SWITCH_SPECS seed both
 * layouts on purpose.
 * test/e2e-classic-layout.test.ts fails if a file pins classic and is in
 * neither list.
 *
 * Plain .mjs with no Playwright imports, so the config and that test can both load it.
 */

export const CLASSIC_LAYOUT_ENV = 'CLUBHOUSE_E2E_LAYOUT';

/** Run by the Classic layout E2E job, on classic. */
export const CLASSIC_RUN_SPECS = [
  // Moved to the new layout; kept on classic until those runs are stable on CI.
  'smoke-agent-lifecycle.spec.ts',
  'smoke-blank-screen.spec.ts',
  'smoke-settings-persistence.spec.ts',
  'open-project.spec.ts',
  'project-switching.spec.ts',
  'navigation.spec.ts',
  'start-agent.spec.ts',
  'agent-real-cli.spec.ts',
  'command-palette.spec.ts',
  'terminal.spec.ts',
  'terminal-e2e.spec.ts',
  'canvas-card-wheel.spec.ts',
  'canvas-create.spec.ts',
  'canvas-golden-path.spec.ts',
  'canvas-group-project-create.spec.ts',
  'canvas-startup-bindings.spec.ts',
  // Through the chat-rich harness, and the Annex specs that drive UI. Annex
  // specs that only use the protocol don't depend on the layout.
  'chat-fake-cli.spec.ts',
  'chat-rich/annex.spec.ts',
  'chat-rich/context-menu.spec.ts',
  'chat-rich/file-chips.spec.ts',
  'chat-rich/flag-off.spec.ts',
  'chat-rich/link-tokens.spec.ts',
  'chat-rich/media-cards.spec.ts',
  'chat-rich/media-images.spec.ts',
  'chat-rich/providers.spec.ts',
  'chat-rich/question-dock.spec.ts',
  'chat-rich/queue-merging.spec.ts',
  'chat-rich/reading.spec.ts',
  'annex-v2/chat-across-desktops.spec.ts',
  'annex-v2/full-demo.spec.ts',
  'annex-v2/remote-control.spec.ts',
  'annex-v2/settings-page.spec.ts',
];

/** Still pinned to classic, waiting to move. */
export const PINNED_CLASSIC_SPECS = [
  'agent-list-ui.spec.ts',
  'annex-v2/agents-across-machines.spec.ts',
  'find-replace.spec.ts',
  'mermaid-preview.spec.ts',
  'onboarding.spec.ts',
  'plugin-system.spec.ts',
  'popout-window.spec.ts',
  'rail-hover-flyout.spec.ts',
  'rail-pin.spec.ts',
  'telemetry-export.spec.ts',
];

/** Test the layout switch itself, so they seed both layouts. */
export const LAYOUT_SWITCH_SPECS = ['layout-default.spec.ts'];

/** The specs the Classic layout E2E job runs, as `testMatch` globs. */
export function classicTestMatch(specs = CLASSIC_RUN_SPECS) {
  if (specs.length === 0) throw new Error('e2e/classic-specs.mjs lists no specs for the classic run');
  return specs.map((spec) => `**/${spec}`);
}
