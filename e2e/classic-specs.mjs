/**
 * Which E2E specs run on the classic layout (#2843).
 *
 * Specs launch on the default (new) layout. The Classic layout E2E job sets
 * CLUBHOUSE_E2E_LAYOUT=classic, which makes launchApp seed `newChrome: false`
 * unless a spec chose a layout itself, and runs CLASSIC_SHARDS, one list per
 * shard. Those are specs moved to the new layout that keep classic coverage
 * until their new-layout runs are stable, and CLASSIC_ONLY_SPECS.
 *
 * CLASSIC_ONLY_SPECS test UI only classic has (its agent list, rail, flyout,
 * onboarding modal). They pin classic themselves and run only in the Classic
 * layout job, while classic still ships. LAYOUT_SWITCH_SPECS seed both
 * layouts on purpose. test/e2e-classic-layout.test.ts fails if any other file
 * pins classic.
 *
 * Plain .mjs with no Playwright imports, so the config and that test can both load it.
 */

export const CLASSIC_LAYOUT_ENV = 'CLUBHOUSE_E2E_LAYOUT';

/**
 * Run by the Classic layout E2E job, on classic, one list per shard. The lists
 * are balanced by hand from measured Windows times (#3143's run: a test-count
 * split put every app-launching Annex, canvas and chat spec in one shard).
 * A new spec goes in the list with the most room.
 *
 * A spec leaves once its new-layout runs have been stable on main for a while;
 * the first moved specs (smoke, navigation, projects, agent start) left after
 * 10 to 15 green main runs. Their classic branches stay in the specs until
 * classic itself goes. Annex specs that only use the protocol don't depend on
 * the layout and never run here.
 */
export const CLASSIC_SHARDS = {
  1: [
    'agent-list-ui.spec.ts',
    'telemetry-export.spec.ts',
    'terminal.spec.ts',
    'terminal-e2e.spec.ts',
    'annex-v2/remote-control.spec.ts',
  ],
  2: [
    'rail-pin.spec.ts',
    'rail-hover-flyout.spec.ts',
    'plugin-system.spec.ts',
    'popout-window.spec.ts',
    'mermaid-preview.spec.ts',
    'command-palette.spec.ts',
  ],
  3: [
    'onboarding.spec.ts',
    'chat-rich/queue-merging.spec.ts',
    'chat-rich/question-dock.spec.ts',
    'chat-rich/reading.spec.ts',
    'chat-rich/annex.spec.ts',
    'chat-rich/flag-off.spec.ts',
  ],
  4: [
    'find-replace.spec.ts',
    'chat-fake-cli.spec.ts',
    'chat-rich/file-chips.spec.ts',
    'chat-rich/context-menu.spec.ts',
    'annex-v2/settings-page.spec.ts',
  ],
  5: [
    'chat-rich/providers.spec.ts',
    'chat-rich/media-images.spec.ts',
    'chat-rich/media-cards.spec.ts',
    'chat-rich/link-tokens.spec.ts',
    'annex-v2/full-demo.spec.ts',
    'annex-v2/chat-across-desktops.spec.ts',
    'canvas-card-wheel.spec.ts',
    'canvas-create.spec.ts',
    'canvas-golden-path.spec.ts',
    'canvas-group-project-create.spec.ts',
    'canvas-startup-bindings.spec.ts',
  ],
};

/** Every spec the Classic layout E2E job runs, across its shards. */
export const CLASSIC_RUN_SPECS = Object.values(CLASSIC_SHARDS).flat();

export const CLASSIC_SHARD_ENV = 'PLAYWRIGHT_CLASSIC_SHARD';

/** Classic-only UI: pinned to classic, and run only in the Classic layout job. */
export const CLASSIC_ONLY_SPECS = [
  'agent-list-ui.spec.ts',
  'onboarding.spec.ts',
  'rail-hover-flyout.spec.ts',
  'rail-pin.spec.ts',
];

/** Test the layout switch itself, so they seed both layouts. */
export const LAYOUT_SWITCH_SPECS = ['layout-default.spec.ts'];

/**
 * One classic shard's specs as `testMatch` globs. An unknown or empty shard
 * throws, rather than running everything or nothing.
 */
export function classicTestMatch(shard, shards = CLASSIC_SHARDS) {
  const specs = shards[shard];
  if (!specs) throw new Error(`${CLASSIC_SHARD_ENV} is ${shard}, and e2e/classic-specs.mjs has shards ${Object.keys(shards).join(', ')}`);
  if (specs.length === 0) throw new Error(`Classic shard ${shard} in e2e/classic-specs.mjs has no specs`);
  return specs.map((spec) => `**/${spec}`);
}
