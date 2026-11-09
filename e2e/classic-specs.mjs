/**
 * Which E2E specs run on the classic layout (#2843).
 *
 * Specs launch on the default (new) layout. The Classic layout E2E job sets
 * CLUBHOUSE_E2E_LAYOUT=classic, which makes launchApp seed `newChrome: false`
 * unless a spec chose a layout itself, and runs CLASSIC_SHARDS, one list per
 * shard: CLASSIC_ONLY_SPECS, and a few journeys that keep classic coverage.
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
 * Run by the Classic layout E2E job, on classic, one list per shard: the
 * classic-only specs, and a few short journeys whose navigation differs on
 * classic (the project's tabs, the terminal, a file preview), while classic
 * ships. Together they take about as long as one E2E shard, so one shard is
 * enough. A spec that needs classic coverage goes in the list with the most room.
 *
 * Specs moved to the new layout ran here too until their new-layout runs were
 * stable on main; the last of them left in #2843's rebalance, after 7 to 15
 * green main runs each. Their classic branches stay in the specs until classic
 * itself goes. Annex specs that only use the protocol don't depend on the
 * layout and never run here.
 */
export const CLASSIC_SHARDS = {
  1: [
    'agent-list-ui.spec.ts',
    'onboarding.spec.ts',
    'rail-hover-flyout.spec.ts',
    'rail-pin.spec.ts',
    'canvas-create.spec.ts',
    'mermaid-preview.spec.ts',
    'terminal.spec.ts',
    'terminal-e2e.spec.ts',
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
 * One classic shard's specs as `testMatch` globs, or every classic spec when no
 * shard is given (a local run of one spec: CLUBHOUSE_E2E_LAYOUT=classic npx
 * playwright test e2e/rail-pin.spec.ts). An unknown or empty shard throws,
 * rather than running everything or nothing.
 */
export function classicTestMatch(shard, shards = CLASSIC_SHARDS) {
  if (shard === undefined || shard === '') return Object.values(shards).flat().map((spec) => `**/${spec}`);
  const specs = shards[shard];
  if (!specs) throw new Error(`${CLASSIC_SHARD_ENV} is ${shard}, and e2e/classic-specs.mjs has shards ${Object.keys(shards).join(', ')}`);
  if (specs.length === 0) throw new Error(`Classic shard ${shard} in e2e/classic-specs.mjs has no specs`);
  return specs.map((spec) => `**/${spec}`);
}
